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

async function withSftp<T>(serverName: string | undefined, fn: (sftp: SFTPWrapper) => Promise<T>): Promise<T> {
  const manager = SSHConnectionManager.getInstance();
  const resolvedName = manager.resolveServer(serverName);
  await manager.connect(resolvedName);
  const client: Client = manager.getClient(resolvedName);
  const sftp = await new Promise<SFTPWrapper>((resolve, reject) => {
    client.sftp((err, wrapper) => (err ? reject(err) : resolve(wrapper)));
  });
  try {
    return await fn(sftp);
  } finally {
    try {
      sftp.end();
    } catch {
      // Ignore SFTP channel close errors -- the underlying client connection
      // is shared/cached and must not be torn down here.
    }
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
export async function resolveRemoteHomeDir(serverName?: string): Promise<string> {
  return withSftp(serverName, (sftp) => new Promise<string>((resolve, reject) => {
    sftp.realpath(".", (err, absolutePath) => (err ? reject(err) : resolve(absolutePath)));
  }));
}

/** Reads a whole remote text file. Returns null if it does not exist (yet --
 * this is the normal, expected shape of "state not written yet" during the
 * short window right after launch, or "process still running, no exit.json
 * yet"). Caps read size defensively; state files are always small JSON/text. */
export async function readRemoteTextFile(
  serverName: string | undefined,
  absolutePath: string,
  maxBytes = 1_000_000,
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
  }));
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
  }));
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
export async function listRemoteDirectory(serverName: string | undefined, absolutePath: string): Promise<RemoteDirEntry[]> {
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
  }));
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
export async function statRemoteFile(serverName: string | undefined, absolutePath: string): Promise<RemoteFileStat | null> {
  return withSftp(serverName, (sftp) => new Promise<RemoteFileStat | null>((resolve, reject) => {
    sftp.stat(absolutePath, (err, stats) => {
      if (err) {
        if (isMissingFileError(err)) return resolve(null);
        return reject(err);
      }
      resolve({ size: stats.size, isFile: (stats.mode & S_IFMT) !== S_IFDIR });
    });
  }));
}
