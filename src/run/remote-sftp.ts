import type { Client, SFTPWrapper } from "ssh2";
import { SSHConnectionManager } from "../services/ssh-connection-manager.js";

/**
 * PLAN.MD's Phase 2 durability design: the remote state directory is the
 * single source of truth (no local JobStore, no local daemon -- see
 * PLAN.MD's "Phase 2 与 Rev.4 取消 P0-05/P0-06 的关系"). run-status/run-logs/
 * run-list all read it back over plain SFTP. This module is a thin,
 * read-oriented SFTP helper reusing the EXISTING connection pool via
 * SSHConnectionManager's already-public connect()/getClient() -- no new
 * method was added to SshConnectionPool or TransferService for this;
 * everything here is built on the same two public calls every other tool
 * already uses to reach a live ssh2 Client.
 */

/** Per-request bound for SFTP operations here. Generous: these read small
 * state files and directory listings, never bulk data (bulk transfers go
 * through TransferService, which has its own budgets). */
export const DEFAULT_SFTP_OPERATION_TIMEOUT_MS = 30_000;

/**
 * `reuseConnection` (default true) goes through SSHConnectionManager's
 * acquireSshClient -- the SAME reuseConnection=false one-shot-client escape
 * hatch executeCommand/upload/download/transfer already have (see
 * SshConnectionPool.acquireSshClient). Previously this always used
 * manager.connect()+getClient(), the shared cached client, with no way to
 * force a fresh one -- a run-* tool call stuck behind a stale cached
 * connection (e.g. after a keepalive timeout) had no escape, unlike every
 * other SFTP-using tool in this codebase.
 *
 * `timeoutMs` bounds the SFTP channel open AND the caller's request, using
 * the same withConnectionTimeout wrapper TransferService already uses for
 * its own channel opens. Without it there was NO per-request timeout at all:
 * a silently-dropped connection (routine on cloud GPU hosts behind NAT/proxy
 * idle reaping) leaves an SFTP callback that never fires, and RunService's
 * collect wait loop checks its own deadline only BETWEEN polls -- so one
 * wedged read hung an entire workspace-run call past any timeout its caller
 * set. Deliberately NOT passed to acquireSshClient: ensureConnected's own
 * timeout path calls closeClient() on the SHARED CACHED client, so reusing
 * this value there would let a slow connect tear down a connection other
 * in-flight operations are using.
 *
 * Scope note: one acquisition + one SFTP channel per REQUEST, deliberately.
 * Batching several reads onto one longer-lived session was tried and
 * reverted: it couples N reads to one socket lifetime, so a single socket
 * death (which is exactly what happens on the flaky links this work is
 * about) takes out the whole logical operation instead of one read that the
 * next call transparently re-acquires. Measured on the real lab host:
 * per-request 3/3 clean acceptance runs, session-scoped failed 3 of 7.
 */
async function withSftp<T>(
  serverName: string | undefined,
  fn: (sftp: SFTPWrapper) => Promise<T>,
  reuseConnection?: boolean,
  timeoutMs: number = DEFAULT_SFTP_OPERATION_TIMEOUT_MS,
): Promise<T> {
  const manager = SSHConnectionManager.getInstance();
  const resolvedName = manager.resolveServer(serverName);
  const acquired = await manager.acquireSshClient(resolvedName, { reuseConnection, purpose: "sftp" });
  try {
    const client: Client = acquired.client;
    const sftp = await manager.withOperationTimeout(
      new Promise<SFTPWrapper>((resolve, reject) => {
        client.sftp((err, wrapper) => (err ? reject(err) : resolve(wrapper)));
      }),
      timeoutMs,
      `SFTP channel open for [${resolvedName}]`,
      // A channel arriving after the timeout already fired would leak
      // otherwise -- nothing else holds a reference to it.
      (wrapper) => {
        try {
          wrapper.end();
        } catch {
          // Ignore late SFTP cleanup errors.
        }
      },
    );
    try {
      return await manager.withOperationTimeout(fn(sftp), timeoutMs, `SFTP request on [${resolvedName}]`);
    } finally {
      try {
        sftp.end();
      } catch {
        // Ignore SFTP channel close errors -- the underlying client
        // connection's lifetime is owned by `acquired.close()` below, not
        // by the SFTP channel itself.
      }
    }
  } finally {
    acquired.close();
  }
}

function isMissingFileError(error: Error): boolean {
  return /no such file|not found/i.test(error.message);
}

/**
 * The remote "home" directory for a server, i.e. what bash's own `$HOME`
 * resolves to for the same SSH user -- discovered via SFTP REALPATH(".")
 * rather than guessed, matching how a normal (non-chroot) sftp-server's
 * starting directory always equals the login shell's home directory.
 */
export async function resolveRemoteHomeDir(serverName?: string, reuseConnection?: boolean, timeoutMs?: number): Promise<string> {
  return withSftp(serverName, (sftp) => new Promise<string>((resolve, reject) => {
    sftp.realpath(".", (err, absolutePath) => (err ? reject(err) : resolve(absolutePath)));
  }), reuseConnection, timeoutMs);
}

/** Reads a whole remote text file. Returns null if it does not exist (yet --
 * this is the normal, expected shape of "state not written yet" during the
 * short window right after launch, or "process still running, no exit.json
 * yet"). Caps read size defensively; state files are always small JSON/text. */
export async function readRemoteTextFile(
  serverName: string | undefined,
  absolutePath: string,
  maxBytes = 1_000_000,
  reuseConnection?: boolean,
  timeoutMs?: number,
): Promise<string | null> {
  return withSftp(serverName, (sftp) => new Promise<string | null>((resolve, reject) => {
    sftp.open(absolutePath, "r", (openErr, handle) => {
      if (openErr) {
        if (isMissingFileError(openErr)) return resolve(null);
        return reject(openErr);
      }
      sftp.fstat(handle, (statErr, stats) => {
        if (statErr) {
          sftp.close(handle, () => {});
          return reject(statErr);
        }
        const size = Math.min(stats.size, maxBytes);
        if (size <= 0) {
          sftp.close(handle, () => {});
          return resolve("");
        }
        const buffer = Buffer.alloc(size);
        sftp.read(handle, buffer, 0, size, 0, (readErr, bytesRead) => {
          sftp.close(handle, () => {});
          if (readErr) return reject(readErr);
          resolve(buffer.subarray(0, bytesRead).toString("utf8"));
        });
      });
    });
  }), reuseConnection, timeoutMs);
}

export interface RemoteByteRange {
  data: Buffer;
  fileSize: number;
}

/** Reads raw bytes `[offset, offset + maxLength)` (capped at the real file
 * size), for the byte-offset log reader. Returns null if the file does not
 * exist yet (a run whose stdout/stderr has not been created yet, or was
 * already rotated away). */
export async function readRemoteByteRange(
  serverName: string | undefined,
  absolutePath: string,
  offset: number,
  maxLength: number,
  reuseConnection?: boolean,
  timeoutMs?: number,
): Promise<RemoteByteRange | null> {
  return withSftp(serverName, (sftp) => new Promise<RemoteByteRange | null>((resolve, reject) => {
    sftp.open(absolutePath, "r", (openErr, handle) => {
      if (openErr) {
        if (isMissingFileError(openErr)) return resolve(null);
        return reject(openErr);
      }
      sftp.fstat(handle, (statErr, stats) => {
        if (statErr) {
          sftp.close(handle, () => {});
          return reject(statErr);
        }
        const fileSize = stats.size;
        const start = Math.min(Math.max(0, offset), fileSize);
        const end = Math.min(fileSize, start + Math.max(0, maxLength));
        const length = end - start;
        if (length <= 0) {
          sftp.close(handle, () => {});
          return resolve({ data: Buffer.alloc(0), fileSize });
        }
        const buffer = Buffer.alloc(length);
        sftp.read(handle, buffer, 0, length, start, (readErr, bytesRead) => {
          sftp.close(handle, () => {});
          if (readErr) return reject(readErr);
          resolve({ data: buffer.subarray(0, Math.max(0, bytesRead)), fileSize });
        });
      });
    });
  }), reuseConnection, timeoutMs);
}

export interface RemoteDirEntry {
  filename: string;
  isDirectory: boolean;
  /** PLAN.MD P2-06: collect must never traverse or download through a
   * symlink (the simplest sufficient rule that makes "symlink pointing
   * outside remoteRoot" structurally unreachable -- see
   * src/run/collect-glob.ts). SFTP READDIR attrs are lstat-based (the real
   * server test fixture builds them via `fs.lstatSync`), so a symlink entry
   * here has neither the regular-file nor the directory bit set; computed
   * from the raw mode's S_IFMT nibble rather than trusted from the SFTP
   * library's own type field so this stays correct against any spec-
   * conformant sftp-server. */
  isSymlink: boolean;
}

const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;
const S_IFDIR = 0o040000;

/** Lists a remote directory. Returns an empty array if it does not exist
 * (e.g. no runs have ever been launched for this server yet). */
export async function listRemoteDirectory(
  serverName: string | undefined,
  absolutePath: string,
  reuseConnection?: boolean,
  timeoutMs?: number,
): Promise<RemoteDirEntry[]> {
  return withSftp(serverName, (sftp) => new Promise<RemoteDirEntry[]>((resolve, reject) => {
    sftp.readdir(absolutePath, (err, list) => {
      if (err) {
        if (isMissingFileError(err)) return resolve([]);
        return reject(err);
      }
      resolve(list.map((entry) => ({
        filename: entry.filename,
        isDirectory: (entry.attrs.mode & S_IFDIR) !== 0,
        isSymlink: (entry.attrs.mode & S_IFMT) === S_IFLNK,
      })));
    });
  }), reuseConnection, timeoutMs);
}

export interface RemoteFileStat {
  size: number;
  isFile: boolean;
}

/** Stats a remote path (follows symlinks, like `stat(2)`, NOT `lstat(2)` --
 * callers that must not follow symlinks use listRemoteDirectory's
 * lstat-based `isSymlink` instead, before ever calling this). Returns null
 * if the path does not exist. Used by the push phase (entrypoint revision)
 * and the collect phase (byte-cap accounting before downloading). */
export async function statRemoteFile(
  serverName: string | undefined,
  absolutePath: string,
  reuseConnection?: boolean,
  timeoutMs?: number,
): Promise<RemoteFileStat | null> {
  return withSftp(serverName, (sftp) => new Promise<RemoteFileStat | null>((resolve, reject) => {
    sftp.stat(absolutePath, (err, stats) => {
      if (err) {
        if (isMissingFileError(err)) return resolve(null);
        return reject(err);
      }
      resolve({ size: stats.size, isFile: (stats.mode & S_IFMT) !== S_IFDIR });
    });
  }), reuseConnection, timeoutMs);
}
