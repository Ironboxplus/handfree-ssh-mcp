/**
 * PLAN.MD P0-04: TransferService -- extracted from SSHConnectionManager.
 *
 * Owns single-file and recursive-directory SFTP upload/download, remote-to-
 * remote relay transfer, and tar-archive packaging/extraction on both sides
 * of a transfer. SSHConnectionManager keeps every one of these method names
 * as a thin, behavior-preserving delegate (see the "Transfer-service facade"
 * block in ssh-connection-manager.ts) so every existing internal call site,
 * external tool caller (upload/download/transfer tools), and whitebox test
 * keeps working unchanged. This is a characterization/refactor step per
 * §7.1 -- no logic below is new, it is a byte-for-byte move plus two
 * mechanical renames: SSHConnectionManager.X -> TransferService.X for
 * self-referenced statics, and this.X -> this.pool.X for connection-pool-
 * owned members (SshConnectionPool now owns the SSH client cache, config
 * resolution, and connect/reconnect/close lifecycle).
 */
import { Client, ClientChannel } from "ssh2";
import type { SFTPWrapper, TransferOptions } from "ssh2";
import {
  SshConnectionPool,
  type SshDebugSink,
  type AcquiredSshClient,
} from "../connection/ssh-connection-pool.js";
import { SSHConfig } from "../models/types.js";
import { Logger } from "../utils/logger.js";
import { ToolError } from "../utils/tool-error.js";
import { OutputCollector } from "../utils/output-collector.js";
import {
  createDebugCollector,
  appendDebugOutput,
  appendDebugToError,
} from "../utils/debug-output.js";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import os from "os";
import { spawn } from "node:child_process";

export type SftpOptions = {
  reuseConnection?: boolean;
  timeout?: number;
  vvv?: boolean;
  fast?: boolean;
  sftpConcurrency?: number;
  chunkSize?: number;
  fileConcurrency?: number;
};

export type ArchiveCompression = "none" | "gzip" | "bzip2" | "xz" | "zstd";

/**
 * PLAN.MD §5.7 batch upload contract.
 */
export type BatchUploadOnError = "abort" | "continue";

export interface BatchTargetCollision {
  basename: string;
  sources: string[];
}

export type BatchUploadValidation =
  | { ok: true }
  | { ok: false; code: "INVALID_CONFIGURATION"; message: string }
  | { ok: false; code: "BATCH_TOO_LARGE"; message: string }
  | { ok: false; code: "BATCH_TARGET_COLLISION"; message: string; collisions: BatchTargetCollision[] };

export interface BatchUploadFileResult {
  localPath: string;
  remotePath: string;
  status: "uploaded" | "skipped" | "failed";
  reason?: string;
  crlfFixed?: boolean;
}

export interface BatchUploadResult {
  results: BatchUploadFileResult[];
  total: number;
  uploadedCount: number;
  skippedCount: number;
  failedCount: number;
  crlfFixedCount: number;
}

/** Internal outcome record for runBoundedTransfersWithResults. */
type BatchTransferOutcome<R> =
  | { status: "done"; value: R }
  | { status: "failed"; error: unknown }
  | { status: "not-run" };

export const MAX_BATCH_UPLOAD_SIZE = 1000;

/**
 * The remote filename a batch-upload source lands under: `remoteDir/<basename>`.
 * Pure. Splits on both `/` and `\` -- `localPath` is a path on the MCP host,
 * and on this project's own Windows dev machine that means backslash paths
 * are a real input, not a hypothetical one.
 */
export function batchUploadBasename(localPath: string): string {
  return path.posix.basename(localPath.replace(/\\/g, "/"));
}

/**
 * Pure. Every source in the batch whose basename collides with another
 * source's basename would silently overwrite it under the same remoteDir; an
 * identical path listed twice is the degenerate case of that same collision
 * (a basename colliding with itself), so it needs no separate check. Returns
 * one entry per colliding basename, listing every contributing source path.
 */
export function findBatchTargetCollisions(localPaths: readonly string[]): BatchTargetCollision[] {
  const bySourceBasename = new Map<string, string[]>();
  for (const localPath of localPaths) {
    const basename = batchUploadBasename(localPath);
    const sources = bySourceBasename.get(basename);
    if (sources) {
      sources.push(localPath);
    } else {
      bySourceBasename.set(basename, [localPath]);
    }
  }
  const collisions: BatchTargetCollision[] = [];
  for (const [basename, sources] of bySourceBasename) {
    if (sources.length > 1) {
      collisions.push({ basename, sources });
    }
  }
  return collisions;
}

/**
 * Pure. §5.7's pre-transfer validation, checked in this order: empty ->
 * too-large -> basename collisions. This must run to completion, and reject
 * on failure, before any SFTP call is made -- proven by a real SFTP call
 * count of 0 in P1-09-A3.
 */
export function validateBatchUploadTargets(localPaths: readonly string[]): BatchUploadValidation {
  if (localPaths.length === 0) {
    return { ok: false, code: "INVALID_CONFIGURATION", message: "localPath array must not be empty" };
  }
  if (localPaths.length > MAX_BATCH_UPLOAD_SIZE) {
    return {
      ok: false,
      code: "BATCH_TOO_LARGE",
      message: `localPath array has ${localPaths.length} entries, exceeding the limit of ${MAX_BATCH_UPLOAD_SIZE}`,
    };
  }
  const collisions = findBatchTargetCollisions(localPaths);
  if (collisions.length > 0) {
    return {
      ok: false,
      code: "BATCH_TARGET_COLLISION",
      message: `${collisions.length} basename collision(s) would overwrite each other under remotePath: ` +
        collisions.map((collision) => `"${collision.basename}" <- [${collision.sources.join(", ")}]`).join("; "),
      collisions,
    };
  }
  return { ok: true };
}

/**
 * PLAN.MD P1-03 (walker slice, §2.3 F5): a directory discovered by the
 * concurrent remote walker, materialized as a tree so the flatten step below
 * can reproduce the original serial depth-first order regardless of which
 * concurrent `readdir` happened to finish first. Each node's `children` are
 * in exactly the order the remote `readdir` returned them for that
 * directory -- the same order the old fully-serial walk iterated in.
 */
export interface RemoteDirNode {
  children: Array<
    | { kind: "file"; remotePath: string; localPath: string }
    | { kind: "dir"; node: RemoteDirNode }
  >;
}

/**
 * Pure. Flattens a `RemoteDirNode` tree into the files array in pre-order:
 * for each directory, files and subdirectories are emitted in that
 * directory's own captured entry order, with a subdirectory's entire
 * contents inlined at that entry's position before continuing to the next
 * entry. This is byte-for-byte the order the old serial
 * `downloadDirectory`/`collect` produced (depth-first, one `await
 * listRemoteDir` at a time) -- flattening only after every concurrent
 * listing has already settled into the tree is what makes the result
 * independent of completion timing.
 */
export function flattenRemoteDirTree(
  root: RemoteDirNode,
): Array<{ remotePath: string; localPath: string }> {
  const files: Array<{ remotePath: string; localPath: string }> = [];
  const visit = (node: RemoteDirNode): void => {
    for (const child of node.children) {
      if (child.kind === "file") {
        files.push({ remotePath: child.remotePath, localPath: child.localPath });
      } else {
        visit(child.node);
      }
    }
  };
  visit(root);
  return files;
}

/**
 * Build the actual argv passed to a locally-spawned `tar`, given the raw
 * archive args and a target platform. Pure and platform-parameterized (not
 * `process.platform` read internally) so both branches can be exhaustively
 * white-box tested from a single test run regardless of which OS the suite
 * actually executes on — see G1.
 *
 * GNU tar (Windows/MSYS builds, e.g. the one bundled with Git for Windows)
 * parses an absolute `X:\...` path as a `host:path` remote spec and tries to
 * open an rsh connection to a one-letter "host". `--force-local` tells it
 * every path argument, including any that contain a colon, is on the local
 * filesystem. Only add it on win32: bsdtar (macOS) does not support the
 * flag, and POSIX paths never contain a drive letter that could be misread.
 *
 * Separately, this MSYS tar build also mis-resolves a backslash-separated
 * `-C <dir>` argument during extraction (its path-safety canonicalization
 * corrupts the string, e.g. `C:\Users\...` becomes `C\:\\Users\\...` and
 * then fails with ENOENT). Forward slashes are valid Win32 path separators
 * and sidestep that bug entirely. A leading `//` is additionally the
 * standard MSYS/Cygwin spelling of a UNC path, so `\\server\share\x`
 * becoming `//server/share/x` is the idiomatic form for this tar build, not
 * just a safe fallback.
 *
 * Backslash never legitimately appears in any other argument here (flags,
 * and Windows disallows backslash in filenames), so this rewrite is safe to
 * apply blanket on win32 — and it must never run on other platforms, where
 * backslash is a perfectly legal POSIX filename character.
 */
export function buildLocalTarArgv(args: readonly string[], platform: NodeJS.Platform): string[] {
  if (platform !== "win32") {
    return [...args];
  }
  return ["--force-local", ...args.map((arg) => arg.replace(/\\/g, "/"))];
}

export class TransferService {
  constructor(private readonly pool: SshConnectionPool) {}

  // Absolute directories this service created itself under os.tmpdir() to
  // hold a transfer's temporary local archive (see createLocalArchiveWorkspace).
  // validateLocalPath exempts paths inside these from the user-facing local
  // path policy: the archive path is never user input, it is generated here
  // and immediately consumed by the same upload()/download() call, so this
  // does not open any new user-reachable local path.
  private readonly internalTransferWorkspaces = new Set<string>();


  /**
   * Run a transfer that reports progress through a callback, aborting it if no
   * progress arrives within `timeoutMs` (an INACTIVITY watchdog, not a total
   * duration cap -- a long but actively-streaming transfer is never killed).
   * When `timeoutMs` is falsy the operation runs unbounded, preserving the
   * previous behavior. `onTimeout` is invoked to tear down the stalled session.
   */
  private runWithInactivityTimeout<T>(
    start: (onProgress: () => void) => Promise<T>,
    timeoutMs: number | undefined,
    description: string,
    debug?: SshDebugSink,
    onTimeout?: () => void,
  ): Promise<T> {
    if (!timeoutMs || timeoutMs <= 0) {
      return start(() => {});
    }

    return new Promise<T>((resolve, reject) => {
      let settled = false;
      let timer: NodeJS.Timeout | null = null;
      // ssh2 fastPut/fastGet invokes `step` for every acknowledged chunk. At
      // the default 32 KiB chunk size that can mean thousands of callbacks per
      // second. Re-creating a JS timer for every callback eventually dominates
      // the event loop and makes an otherwise healthy transfer slow down. A
      // watchdog only needs a recent proof of life, so coalesce those resets.
      const progressRearmIntervalMs = Math.min(
        1_000,
        Math.max(1, Math.floor(timeoutMs / 4)),
      );
      let lastArmedAt = 0;

      const clear = () => {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
      };

      const arm = () => {
        clear();
        lastArmedAt = Date.now();
        timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          debug?.(`[mcp] ${description} stalled: no progress for ${timeoutMs}ms`);
          try {
            onTimeout?.();
          } catch {
            // Ignore cleanup failures after a stall.
          }
          reject(new ToolError(
            "SSH_CONNECTION_FAILED",
            `${description} stalled: no progress for ${timeoutMs}ms`,
            true,
          ));
        }, timeoutMs);
      };

      const onProgress = () => {
        if (!settled && Date.now() - lastArmedAt >= progressRearmIntervalMs) {
          arm();
        }
      };

      arm();
      start(onProgress).then(
        (value) => {
          if (settled) return;
          settled = true;
          clear();
          resolve(value);
        },
        (err) => {
          if (settled) return;
          settled = true;
          clear();
          reject(err);
        },
      );
    });
  }

  /**
   * Default inactivity window (ms) for SFTP data transfers when the caller does
   * not pass an explicit timeout. Deliberately generous: a healthy transfer
   * moves bytes far more often than this, so tripping it means the connection
   * is effectively dead, not merely slow.
   */
  private static readonly DEFAULT_TRANSFER_STALL_TIMEOUT_MS = 60_000;

  /** Chunk size for buffered SFTP writes, sized to yield per-ack progress. */
  private static readonly SFTP_WRITE_CHUNK_BYTES = 256 * 1024;

  /**
   * Relay uses explicit offset reads/writes instead of a single stream pipe so
   * the source can keep a bounded number of later ranges in flight while the
   * destination acknowledges earlier writes. These match ssh2 fastGet's
   * defaults, but the window is held only in MCP-host memory and never disk.
   */
  private static readonly DEFAULT_RELAY_SFTP_CONCURRENCY = 64;
  private static readonly DEFAULT_RELAY_SFTP_CHUNK_BYTES = 32 * 1024;
  private static readonly MAX_RELAY_PREFETCH_BYTES = 64 * 1024 * 1024;
  private static readonly DEFAULT_RECURSIVE_FILE_CONCURRENCY = 4;
  // Each concurrent worker opens its own SFTP channel (see upload/download),
  // and every recursive transfer already holds one extra channel briefly for
  // mkdir. OpenSSH's default `MaxSessions 10` bounds concurrently open
  // channels on a single connection, so a cap above that reliably produces
  // channel-open failures against a default-configured sshd. 8 leaves headroom
  // under the common default instead of assuming operators raised it.
  private static readonly MAX_RECURSIVE_FILE_CONCURRENCY = 8;
  private static readonly ARCHIVE_ERROR_OUTPUT_BYTES = 16 * 1024;

  // upload() returns a human-readable string, and uploadBatch() has to
  // classify each file's outcome from it (the single-file return shape is
  // frozen by the legacy characterization tests, so it cannot become a
  // structured object). Keeping the two discriminating substrings here means
  // the producer and the consumer cannot drift apart silently: rewording
  // either message without updating its constant is a compile-time rename,
  // not a batch result that quietly reports "uploaded" for a skipped file.
  private static readonly UPLOAD_SKIPPED_PREFIX = "Upload skipped:";
  private static readonly CRLF_FIX_MARKER = "CRLF→LF auto-fix";

  /**
   * Resolve the inactivity window for a data transfer: the caller's timeout if
   * valid, otherwise the generous default so a dead connection never hangs.
   */
  private transferStallTimeout(timeout?: number): number {
    return (
      this.pool.normalizeConnectTimeout(timeout) ??
      TransferService.DEFAULT_TRANSFER_STALL_TIMEOUT_MS
    );
  }

  /**
   * Pipe a readable into a writable under the inactivity watchdog, aborting if
   * no bytes flow for the stall window. Used by the non-fast download and relay
   * paths, which otherwise settle only on close/finish/error and so hang on a
   * dead reused connection. Read-side `data` events drive progress; the caller
   * supplies error mappers so each path keeps its own error code/message.
   */
  private pipeWithInactivityTimeout(
    readStream: NodeJS.ReadableStream,
    writeStream: NodeJS.WritableStream,
    timeoutMs: number | undefined,
    description: string,
    debug: SshDebugSink | undefined,
    mapReadError: (e: Error) => Error,
    mapWriteError: (e: Error) => Error,
  ): Promise<void> {
    const teardown = () => {
      this.unpipeStream(readStream, writeStream);
      this.destroyStream(readStream);
      this.destroyStream(writeStream);
    };
    return this.runWithInactivityTimeout<void>(
      (onProgress) =>
        new Promise<void>((resolve, reject) => {
          let settled = false;
          const settle = (err?: Error) => {
            if (settled) return;
            settled = true;
            if (err) {
              teardown();
              reject(err);
            } else {
              resolve();
            }
          };

          readStream.on("data", () => onProgress());
          // Resolve on whichever completion event the write side emits: local fs
          // writables emit "finish", SFTP writables emit "close".
          writeStream.on("finish", () => settle());
          writeStream.on("close", () => settle());
          writeStream.on("error", (err: Error) => settle(mapWriteError(err)));
          readStream.on("error", (err: Error) => settle(mapReadError(err)));

          readStream.pipe(writeStream);
        }),
      timeoutMs,
      description,
      debug,
      teardown,
    );
  }

  /**
   * Resolve the bounded relay prefetch window. `sftpConcurrency` is the
   * maximum number of source ranges that can be downloaded or awaiting a
   * destination write at once; each owns one `chunkSize` Buffer.
   */
  private createRelayTransferOptions(options?: SftpOptions): Required<Pick<TransferOptions, "concurrency" | "chunkSize">> {
    const requested = this.createSftpTransferOptions(options);
    const concurrency = requested.concurrency ?? TransferService.DEFAULT_RELAY_SFTP_CONCURRENCY;
    const chunkSize = requested.chunkSize ?? TransferService.DEFAULT_RELAY_SFTP_CHUNK_BYTES;
    const prefetchBytes = concurrency * chunkSize;

    if (!Number.isSafeInteger(prefetchBytes) || prefetchBytes > TransferService.MAX_RELAY_PREFETCH_BYTES) {
      throw new ToolError(
        "INVALID_CONFIGURATION",
        `relay prefetch window is too large (${concurrency} x ${chunkSize} bytes; max ${TransferService.MAX_RELAY_PREFETCH_BYTES} bytes)`,
        false,
      );
    }

    return { concurrency, chunkSize };
  }

  /**
   * Pure: how many parallel workers a relay transfer should start for a given
   * (sourceSize, chunkSize, concurrency) triple. Never more workers than there
   * are chunks to fetch, and never more than the configured concurrency.
   * Callers must only invoke this for sourceSize > 0; a zero-byte transfer
   * skips the worker pool entirely (see relayWithPrefetchWindow).
   */
  private resolveRelayWorkerCount(sourceSize: number, chunkSize: number, concurrency: number): number {
    return Math.min(concurrency, Math.ceil(sourceSize / chunkSize));
  }

  private sftpOpenFile(
    sftp: SFTPWrapper,
    remotePath: string,
    mode: "r" | "w",
    mapError: (error: Error) => Error,
  ): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      sftp.open(remotePath, mode, (error, handle) => {
        if (error) {
          reject(mapError(error));
          return;
        }
        resolve(handle);
      });
    });
  }

  private sftpCloseFile(sftp: SFTPWrapper, handle: Buffer): Promise<void> {
    return new Promise((resolve, reject) => {
      sftp.close(handle, (error?: Error | null) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  /**
   * Read one known-size range, retrying a short successful SFTP read until the
   * full range arrives. A zero-byte successful read before the known source
   * size is an unexpected source truncation rather than EOF we may silently
   * copy.
   */
  private async sftpReadRelayChunk(
    sftp: SFTPWrapper,
    handle: Buffer,
    offset: number,
    length: number,
  ): Promise<Buffer> {
    const chunk = Buffer.allocUnsafe(length);
    let received = 0;

    while (received < length) {
      const bytesRead = await new Promise<number>((resolve, reject) => {
        sftp.read(
          handle,
          chunk,
          received,
          length - received,
          offset + received,
          (error, count) => {
            if (error) {
              reject(this.makeSftpError("Source read error", error));
              return;
            }
            resolve(count);
          },
        );
      });

      if (bytesRead <= 0) {
        throw new ToolError(
          "SFTP_ERROR",
          `Source read error: source file changed or ended early at offset ${offset + received}`,
          true,
        );
      }
      received += bytesRead;
    }

    return chunk;
  }

  private sftpWriteRelayChunk(
    sftp: SFTPWrapper,
    handle: Buffer,
    chunk: Buffer,
    offset: number,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      sftp.write(handle, chunk, 0, chunk.length, offset, (error?: Error | null) => {
        if (error) {
          reject(this.makeSftpError("Dest write error", error));
          return;
        }
        resolve();
      });
    });
  }

  /**
   * Relay through a bounded range window. A worker reserves a source range,
   * downloads it, then writes that exact range at the same destination offset.
   * Multiple workers deliberately finish out of order: SFTP offset writes make
   * that safe and prevent one source/destination RTT pair from serializing the
   * entire relay.
   */
  private async relayWithPrefetchWindow(
    srcSftp: SFTPWrapper,
    dstSftp: SFTPWrapper,
    sourcePath: string,
    destPath: string,
    sourceSize: number,
    options: SftpOptions | undefined,
    timeout: number | undefined,
    description: string,
    debug: SshDebugSink | undefined,
  ): Promise<void> {
    // Validate before opening a pair of file handles so a bad requested window
    // cannot leave remote handles behind.
    const { concurrency, chunkSize } = this.createRelayTransferOptions(options);
    debug?.(
      `[mcp] relay prefetch window: concurrency=${concurrency}, chunkSize=${chunkSize}, maxBuffered=${concurrency * chunkSize}`,
    );

    let sourceHandle: Buffer | null = null;
    let destHandle: Buffer | null = null;
    let aborted = false;

    const abort = () => {
      if (aborted) return;
      aborted = true;
      // Closing the SFTP sessions below is the reliable cancellation mechanism
      // for ssh2 requests which have no per-request abort handle. Best-effort
      // close the file handles too; do not wait here or a dead server would turn
      // an inactivity timeout back into a hang.
      if (sourceHandle) {
        try {
          srcSftp.close(sourceHandle, () => {});
        } catch {
          // Ignore a channel that is already gone.
        }
      }
      if (destHandle) {
        try {
          dstSftp.close(destHandle, () => {});
        } catch {
          // Ignore a channel that is already gone.
        }
      }
      try {
        srcSftp.end();
      } catch {
        // Ignore a channel that is already gone.
      }
      try {
        dstSftp.end();
      } catch {
        // Ignore a channel that is already gone.
      }
    };

    await this.runWithInactivityTimeout<void>(
        (onProgress) =>
          new Promise<void>((resolve, reject) => {
            let settled = false;
            let nextOffset = 0;
            let workersRemaining = 0;

            const fail = (error: Error) => {
              if (settled) return;
              settled = true;
              abort();
              reject(error);
            };

            const finish = async () => {
              if (settled) return;
              settled = true;
              try {
                // Close both remote handles before verification so every
                // acknowledged write is durable and visible to `stat`/md5sum.
                if (sourceHandle) {
                  await this.sftpCloseFile(srcSftp, sourceHandle);
                  sourceHandle = null;
                }
                if (destHandle) {
                  await this.sftpCloseFile(dstSftp, destHandle);
                  destHandle = null;
                }
                resolve();
              } catch (error) {
                abort();
                reject(this.makeSftpError("Relay file close error", error as Error));
              }
            };

            const runWorker = async () => {
              try {
                while (!settled) {
                  const offset = nextOffset;
                  if (offset >= sourceSize) break;
                  nextOffset += chunkSize;
                  const length = Math.min(chunkSize, sourceSize - offset);
                  const chunk = await this.sftpReadRelayChunk(srcSftp, sourceHandle!, offset, length);
                  onProgress();
                  if (settled) return;
                  await this.sftpWriteRelayChunk(dstSftp, destHandle!, chunk, offset);
                  onProgress();
                }
              } catch (error) {
                fail(error as Error);
                return;
              }

              workersRemaining -= 1;
              if (workersRemaining === 0) {
                void finish();
              }
            };

            const openAndStart = async () => {
              try {
                sourceHandle = await this.sftpOpenFile(
                  srcSftp,
                  sourcePath,
                  "r",
                  (error) => this.makeSftpError("Source open error", error),
                );
                destHandle = await this.sftpOpenFile(
                  dstSftp,
                  destPath,
                  "w",
                  (error) => this.makeSftpError("Dest open error", error),
                );

                if (sourceSize === 0) {
                  await finish();
                  return;
                }

                // workerCount is a local const used only for the loop bound.
                // workersRemaining is a separate completion counter that
                // runWorker decrements; keeping them distinct means a future
                // worker that manages to decrement synchronously (e.g. a
                // same-tick resolved read) can never shrink the loop bound
                // out from under this for-loop.
                const workerCount = this.resolveRelayWorkerCount(sourceSize, chunkSize, concurrency);
                workersRemaining = workerCount;
                for (let index = 0; index < workerCount; index += 1) {
                  void runWorker();
                }
              } catch (error) {
                fail(error as Error);
              }
            };

            void openAndStart();
          }),
        this.transferStallTimeout(timeout),
        description,
        debug,
        abort,
      );
    // Do not end the SFTP sessions on success: transferBetweenServers owns
    // them and immediately reuses them for post-transfer stat verification.
    // Failure and timeout paths already call abort(), which ends both sessions.
  }












  private makeSftpError(context: string, error: Error): ToolError {
    const connectionFailure = this.pool.isConnectionShapedMessage(error.message);
    return new ToolError(
      connectionFailure ? "SSH_CONNECTION_FAILED" : "SFTP_ERROR",
      `${context}: ${error.message}`,
      connectionFailure,
    );
  }

  private createSftpTransferOptions(options?: SftpOptions): TransferOptions {
    const transferOptions: TransferOptions = {};
    const concurrency = this.optionalPositiveInteger(
      options?.sftpConcurrency,
      "sftpConcurrency",
    );
    const chunkSize = this.optionalPositiveInteger(options?.chunkSize, "chunkSize");

    if (concurrency !== undefined) {
      transferOptions.concurrency = concurrency;
    }
    if (chunkSize !== undefined) {
      transferOptions.chunkSize = chunkSize;
    }

    return transferOptions;
  }

  private optionalPositiveInteger(value: number | undefined, name: string): number | undefined {
    if (value === undefined) {
      return undefined;
    }
    if (!Number.isInteger(value) || value <= 0) {
      throw new ToolError(
        "INVALID_CONFIGURATION",
        `${name} must be a positive integer`,
        false,
      );
    }
    return value;
  }

  /**
   * Recursive directory transfer is dominated by per-file SFTP setup and
   * round trips when a tree contains many small files. Keep a conservative
   * default so the optimization remains safe for smaller SSH servers, but let
   * callers tune it within a hard cap.
   */
  private resolveRecursiveFileConcurrency(options?: SftpOptions): number {
    const requested = this.optionalPositiveInteger(options?.fileConcurrency, "fileConcurrency");
    const concurrency = requested ?? TransferService.DEFAULT_RECURSIVE_FILE_CONCURRENCY;
    if (concurrency > TransferService.MAX_RECURSIVE_FILE_CONCURRENCY) {
      throw new ToolError(
        "INVALID_CONFIGURATION",
        `fileConcurrency must not exceed ${TransferService.MAX_RECURSIVE_FILE_CONCURRENCY}`,
        false,
      );
    }
    return concurrency;
  }

  /**
   * Run independent file transfers with a bounded worker pool. Once a worker
   * fails no new files are scheduled; existing workers are awaited first so
   * their SFTP channels can finish/clean up before the original error is
   * returned to the caller.
   */
  private async runBoundedTransfers<T>(
    items: readonly T[],
    concurrency: number,
    worker: (item: T) => Promise<void>,
  ): Promise<void> {
    let nextIndex = 0;
    let firstError: unknown;

    const runWorker = async (): Promise<void> => {
      while (firstError === undefined) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= items.length) return;
        try {
          await worker(items[index]);
        } catch (error) {
          firstError ??= error;
          return;
        }
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(concurrency, items.length) }, () => runWorker()),
    );
    if (firstError !== undefined) {
      throw firstError;
    }
  }

  /**
   * PLAN.MD P1-09: like runBoundedTransfers above, but never throws -- every
   * item gets a recorded outcome instead of the pool unwinding on the first
   * error. uploadDirectory depends on runBoundedTransfers' fail-fast throw
   * semantics, so batch upload gets its own bounded executor rather than a
   * mode flag bolted onto that one.
   *
   * onError="abort": once any worker's item fails, no unstarted item is
   * scheduled afterwards; items already in flight are awaited to completion
   * (drained) before returning. onError="continue": every item is attempted
   * regardless of earlier failures.
   */
  private async runBoundedTransfersWithResults<T, R>(
    items: readonly T[],
    concurrency: number,
    onError: BatchUploadOnError,
    worker: (item: T) => Promise<R>,
  ): Promise<Array<BatchTransferOutcome<R>>> {
    const outcomes: Array<BatchTransferOutcome<R>> = items.map(() => ({ status: "not-run" }));
    let nextIndex = 0;
    let aborted = false;

    const runWorker = async (): Promise<void> => {
      while (!(onError === "abort" && aborted)) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= items.length) return;
        try {
          outcomes[index] = { status: "done", value: await worker(items[index]) };
        } catch (error) {
          outcomes[index] = { status: "failed", error };
          if (onError === "abort") aborted = true;
        }
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(concurrency, items.length) }, () => runWorker()),
    );
    return outcomes;
  }



  private unpipeStream(readStream: unknown, writeStream: unknown): void {
    const candidate = readStream as { unpipe?: (destination?: unknown) => unknown };
    if (typeof candidate.unpipe !== "function") {
      return;
    }
    try {
      candidate.unpipe(writeStream);
    } catch {
      // Ignore cleanup errors after the original stream failure.
    }
  }

  private destroyStream(stream: unknown): void {
    const candidate = stream as { destroy?: () => void };
    if (typeof candidate.destroy !== "function") {
      return;
    }
    try {
      candidate.destroy();
    } catch {
      // Ignore cleanup errors after the original stream failure.
    }
  }


  /**
   * Validate a local filesystem path for SFTP transfer.
   *
   * The path must be inside the MCP working directory OR inside one of the
   * server's `allowedLocalDirectories` entries. The working directory is
   * always allowed implicitly for backward compatibility.
   */
  public validateLocalPath(localPath: string, name?: string): string {
    const resolvedPath = path.resolve(localPath);

    // Exempt this service's own internally-created temp archive workspaces
    // (under os.tmpdir(), see createLocalArchiveWorkspace) from the
    // user-facing local path policy below. These paths are never user input:
    // they are generated by this service for one archive transfer and
    // consumed by the very same upload()/download() call, so this cannot be
    // used to reach an otherwise-disallowed user path.
    for (const workspace of this.internalTransferWorkspaces) {
      if (resolvedPath === workspace || resolvedPath.startsWith(workspace + path.sep)) {
        return resolvedPath;
      }
    }

    const config = name ? this.pool.getServerConfig(name) : undefined;

    // disableSftpPathPolicy fully opens the local side too (any path allowed).
    if (config?.disableSftpPathPolicy) {
      return resolvedPath;
    }

    const allowedRoots = new Set<string>([process.cwd()]);

    // Add per-server allowedLocalDirectories if a server is targeted
    if (config?.allowedLocalDirectories) {
      for (const dir of config.allowedLocalDirectories) {
        allowedRoots.add(dir);
      }
    }

    const isAllowed = Array.from(allowedRoots).some((root) =>
      resolvedPath === root || resolvedPath.startsWith(root + path.sep),
    );

    if (!isAllowed) {
      const allowedList = Array.from(allowedRoots).join(", ");
      throw new ToolError(
        "LOCAL_PATH_NOT_ALLOWED",
        `Local path '${resolvedPath}' is not inside any allowed directory. Allowed: ${allowedList}. ` +
          `Add the directory under 'allowedLocalDirectories' in the server's YAML config to permit it.`,
        false,
      );
    }
    return resolvedPath;
  }

  /**
   * Validate a remote (POSIX) path for SFTP transfer.
   *
   * The path must be an absolute POSIX path inside one of the server's
   * `allowedRemoteDirectories` entries. If that list is unset or empty,
   * SFTP is rejected: configure the list explicitly before using
   * upload/download/transfer.
   */
  public validateRemotePath(remotePath: string, name: string): string {
    if (typeof remotePath !== "string" || remotePath.length === 0) {
      throw new ToolError(
        "REMOTE_PATH_NOT_ALLOWED",
        "Remote path must be a non-empty string.",
        false,
      );
    }
    if (remotePath.includes("\0")) {
      throw new ToolError(
        "REMOTE_PATH_NOT_ALLOWED",
        "Remote path must not contain null bytes.",
        false,
      );
    }
    if (!path.posix.isAbsolute(remotePath)) {
      throw new ToolError(
        "REMOTE_PATH_NOT_ALLOWED",
        `Remote path must be an absolute POSIX path, got: ${remotePath}`,
        false,
      );
    }

    // Reject '..' BEFORE normalization so an escape like /allowed/../etc/passwd
    // is rejected outright instead of collapsing to /etc/passwd and then
    // being checked against the (now-bypassed) allowlist.
    if (remotePath.split("/").includes("..")) {
      throw new ToolError(
        "REMOTE_PATH_NOT_ALLOWED",
        `Remote path must not contain '..' segments: ${remotePath}`,
        false,
      );
    }

    const normalized = path.posix.normalize(remotePath);

    const config = this.pool.getConfig(name);
    const allowedRoots = config.allowedRemoteDirectories ?? [];

    // Default is OPEN: with no 'allowedRemoteDirectories' configured (or
    // disableSftpPathPolicy set), any absolute POSIX path is allowed. Configure
    // 'allowedRemoteDirectories' to opt into an allowlist for this server.
    if (config.disableSftpPathPolicy || allowedRoots.length === 0) {
      return normalized;
    }

    const isAllowed = allowedRoots.some((root) =>
      normalized === root || normalized.startsWith(root === "/" ? "/" : root + "/"),
    );

    if (!isAllowed) {
      throw new ToolError(
        "REMOTE_PATH_NOT_ALLOWED",
        `Remote path '${normalized}' is not inside any allowedRemoteDirectories entry for server '${name}'. ` +
          `Allowed: ${allowedRoots.join(", ")}.`,
        false,
      );
    }

    return normalized;
  }

  /**
   * Upload file
   */
  public async upload(
    localPath: string,
    remotePath: string,
    name?: string,
    options?: SftpOptions & { skipIfIdentical?: boolean },
  ): Promise<string> {
    const resolvedName = name || this.pool.defaultName;
    const reuseConnection = options?.reuseConnection !== false;
    const { collector: debugCollector, debug } = createDebugCollector(options?.vvv === true);
    const validatedLocalPath = this.validateLocalPath(localPath, resolvedName);
    const validatedRemotePath = this.validateRemotePath(remotePath, resolvedName);
    const skipIfIdentical = options?.skipIfIdentical !== false; // default true

    // ---- Read local file (stat + content as Buffer) ----
    let stat: fs.Stats;
    try {
      stat = fs.statSync(validatedLocalPath);
    } catch (e) {
      throw new ToolError(
        "LOCAL_FILE_READ_FAILED",
        `Failed to stat local file '${validatedLocalPath}': ${(e as Error).message}`,
        false,
      );
    }
    if (!stat.isFile()) {
      throw new ToolError(
        "LOCAL_FILE_READ_FAILED",
        `Local path '${validatedLocalPath}' is not a regular file (size=${stat.size}). ` +
          `Use uploadDirectory / recursive=true for directories.`,
        false,
      );
    }

    const isShellScript = TransferService.SHELL_SCRIPT_EXTENSIONS.has(
      path.extname(validatedLocalPath).toLowerCase(),
    );
    const fastUpload = options?.fast === true;
    // fastPut reads from disk on its own. Keep that path zero-copy from this
    // process's perspective: a default skip-if-identical check must not turn a
    // large fast upload into a synchronous fs.readFileSync() followed by a
    // second disk read inside ssh2.
    const mustReadPayload = !fastUpload || isShellScript;
    let payload: Buffer | null = null;
    let crlfFixed: { buffer: Buffer; fixed: boolean; replacedCount: number } = {
      buffer: Buffer.alloc(0),
      fixed: false,
      replacedCount: 0,
    };

    if (mustReadPayload) {
      try {
        payload = fs.readFileSync(validatedLocalPath);
      } catch (e) {
        throw new ToolError(
          "LOCAL_FILE_READ_FAILED",
          `Failed to read local file '${validatedLocalPath}': ${(e as Error).message}`,
          false,
        );
      }

      // ---- CRLF auto-fix for shell scripts ----
      crlfFixed = TransferService.maybeFixShellScriptLineEndings(
        validatedLocalPath,
        payload,
      );
      payload = crlfFixed.buffer;
    }

    const crlfNote = crlfFixed.fixed
      ? ` (${TransferService.CRLF_FIX_MARKER}: converted ${crlfFixed.replacedCount} line endings to LF before upload because target is a shell script).`
      : "";

    debug?.(`[mcp] sftp upload on [${resolvedName}], reuseConnection=${reuseConnection}`);
    let connection: AcquiredSshClient | null = null;
    try {
      connection = await this.pool.acquireSshClient(resolvedName, {
        reuseConnection,
        timeout: options?.timeout,
        debug,
        purpose: "sftp",
      });
      const client = connection.client;

      // ---- Skip-if-identical check ----
      if (skipIfIdentical) {
        const decision = payload
          ? await this.shouldSkipUpload(
              client,
              payload,
              validatedRemotePath,
              isShellScript,
              options?.timeout,
              debug,
            )
          : await this.shouldSkipFastUpload(
              client,
              validatedLocalPath,
              stat.size,
              validatedRemotePath,
              options?.timeout,
              debug,
            );
        if (decision.skip) {
          return appendDebugOutput(
            `${TransferService.UPLOAD_SKIPPED_PREFIX} remote file '${validatedRemotePath}' is already identical to local ` +
              `'${validatedLocalPath}' (${decision.reason}).${crlfNote}`,
            debugCollector,
          );
        }
      }

      // ---- Actually upload ----
      if (fastUpload && !crlfFixed.fixed) {
        await this.sftpFastPut(
          client,
          validatedLocalPath,
          validatedRemotePath,
          options,
          options?.timeout,
          debug,
        );
      } else {
        await this.sftpWriteBuffer(client, validatedRemotePath, payload!, options?.timeout, debug);
      }

      const uploadedBytes = payload?.length ?? stat.size;
      const modeNote = fastUpload && !crlfFixed.fixed ? " via fast SFTP" : "";
      return appendDebugOutput(
        `File uploaded successfully (${uploadedBytes} bytes${modeNote})${crlfNote}`,
        debugCollector,
      );
    } catch (error) {
      if (reuseConnection && this.pool.isConnectionError(error as Error)) {
        this.pool.closeClient(resolvedName, true);
      }
      throw appendDebugToError(error as Error, debugCollector);
    } finally {
      connection?.close();
    }
  }

  /**
   * Threshold above which we use MD5 hash comparison instead of byte-content
   * comparison for skip-if-identical.
   */
  private static readonly SKIP_IF_IDENTICAL_HASH_THRESHOLD = 256 * 1024 * 1024;

  /**
   * Shell scripts that need CRLF→LF normalization on upload to a Linux host.
   */
  private static readonly SHELL_SCRIPT_EXTENSIONS = new Set([".sh", ".bash", ".zsh"]);

  /**
   * If the local file is a shell script (.sh / .bash / .zsh) and contains
   * any CRLF line endings, return a new buffer with all CRLF replaced by LF.
   * Otherwise return the buffer unchanged.
   */
  private static maybeFixShellScriptLineEndings(
    localPath: string,
    buffer: Buffer,
  ): { buffer: Buffer; fixed: boolean; replacedCount: number } {
    const ext = path.extname(localPath).toLowerCase();
    if (!TransferService.SHELL_SCRIPT_EXTENSIONS.has(ext)) {
      return { buffer, fixed: false, replacedCount: 0 };
    }

    // Count CRLF occurrences. Buffer.indexOf is fast.
    let count = 0;
    let idx = buffer.indexOf("\r\n");
    while (idx !== -1) {
      count++;
      idx = buffer.indexOf("\r\n", idx + 2);
    }
    if (count === 0) {
      return { buffer, fixed: false, replacedCount: 0 };
    }

    // Replace via string conversion. Safe for shell scripts which are always
    // text. Use 'binary' encoding to avoid any UTF-8 normalization surprises.
    const fixed = Buffer.from(
      buffer.toString("binary").replace(/\r\n/g, "\n"),
      "binary",
    );
    return { buffer: fixed, fixed: true, replacedCount: count };
  }

  /**
   * Decide whether an upload can be skipped because the remote file is
   * already identical to the local payload.
   *
   * Strategy for regular files:
   *   - If remote file does not exist → don't skip.
   *   - If sizes differ → don't skip.
   *   - If size ≤ 256 MiB → fetch remote bytes and byte-compare.
   *   - Else → MD5 both sides and compare hashes.
   *
   * Strategy for shell scripts (lineEndingAgnostic=true):
   *   The local payload has already been LF-normalized. We must compare
   *   against an LF-normalized view of the remote file too, so a remote that
   *   still contains CRLF is treated as equal to an LF-only local file.
   *   Because remote-side md5sum runs on raw bytes (including CRLF), we
   *   cannot use the hash branch — we always download the remote and
   *   byte-compare after normalizing it.
   *
   * Any error during the check is treated as 'don't skip' (i.e. fall through
   * to a normal upload), since correctness wins over an optimization.
   */
  private async shouldSkipUpload(
    client: Client,
    localPayload: Buffer,
    remotePath: string,
    lineEndingAgnostic: boolean,
    timeout?: number,
    debug?: SshDebugSink,
  ): Promise<{ skip: boolean; reason: string }> {
    let remoteSize: number;
    try {
      const sftp = await this.openSftp(client, "dest", timeout, debug);
      try {
        const stat = await this.sftpStat(sftp, remotePath, "dest");
        remoteSize = stat.size;
      } finally {
        sftp.end();
      }
    } catch {
      return { skip: false, reason: "remote-missing-or-unstat-able" };
    }

    if (lineEndingAgnostic) {
      // For shell scripts we can't trust raw size: remote may have CRLF.
      // Sanity-cap the remote download size to keep memory bounded.
      if (remoteSize > TransferService.SKIP_IF_IDENTICAL_HASH_THRESHOLD) {
        // Shell scripts this large are pathological; just re-upload.
        return { skip: false, reason: `shell-script-too-large-for-content-compare(${remoteSize} bytes)` };
      }
      let remoteBuf: Buffer;
      try {
        remoteBuf = await this.sftpReadBuffer(client, remotePath, remoteSize, timeout, debug);
      } catch {
        return { skip: false, reason: "remote-read-failed-during-content-compare" };
      }
      const remoteNormalized = TransferService.normalizeCrlfToLf(remoteBuf);
      if (
        remoteNormalized.length === localPayload.length &&
        remoteNormalized.equals(localPayload)
      ) {
        const note = remoteNormalized.length !== remoteBuf.length
          ? `identical-content-ignoring-line-endings(${remoteNormalized.length} bytes after LF-normalization, remote raw was ${remoteBuf.length} bytes with CRLF)`
          : `identical-content(${remoteNormalized.length} bytes)`;
        return { skip: true, reason: note };
      }
      return { skip: false, reason: "content-differs-after-line-ending-normalization" };
    }

    // -------- Non-shell-script path --------

    if (remoteSize !== localPayload.length) {
      return { skip: false, reason: `size-differs(local=${localPayload.length},remote=${remoteSize})` };
    }

    if (remoteSize <= TransferService.SKIP_IF_IDENTICAL_HASH_THRESHOLD) {
      // Byte-content compare
      let remoteBuf: Buffer;
      try {
        remoteBuf = await this.sftpReadBuffer(client, remotePath, remoteSize, timeout, debug);
      } catch {
        return { skip: false, reason: "remote-read-failed-during-content-compare" };
      }
      if (remoteBuf.length === localPayload.length && remoteBuf.equals(localPayload)) {
        return { skip: true, reason: `identical-content(${remoteSize} bytes)` };
      }
      return { skip: false, reason: "content-differs" };
    }

    // Large file → hash compare
    const localMd5 = crypto.createHash("md5").update(localPayload).digest("hex");
    let remoteMd5: string | null = null;
    try {
      remoteMd5 = await this.remoteMd5(client, remotePath);
    } catch {
      return { skip: false, reason: "remote-md5-unavailable" };
    }
    if (remoteMd5 === localMd5) {
      return { skip: true, reason: `identical-md5(${localMd5}, ${remoteSize} bytes)` };
    }
    return { skip: false, reason: `md5-differs(local=${localMd5}, remote=${remoteMd5})` };
  }

  /**
   * Skip-if-identical path for a fast upload. Unlike the buffered path, this
   * never preloads the local file. Most uploads hit the size-different branch
   * and can enter ssh2 fastPut immediately; equal-sized files are compared with
   * streaming SHA-256 digests so memory remains bounded on every platform.
   */
  private async shouldSkipFastUpload(
    client: Client,
    localPath: string,
    localSize: number,
    remotePath: string,
    timeout?: number,
    debug?: SshDebugSink,
  ): Promise<{ skip: boolean; reason: string }> {
    let remoteSize: number;
    try {
      const sftp = await this.openSftp(client, "fast-upload-stat", timeout, debug);
      try {
        remoteSize = (await this.sftpStat(sftp, remotePath, "dest")).size;
      } finally {
        sftp.end();
      }
    } catch {
      return { skip: false, reason: "remote-missing-or-unstat-able" };
    }

    if (remoteSize !== localSize) {
      return { skip: false, reason: `size-differs(local=${localSize},remote=${remoteSize})` };
    }

    try {
      const identical = await this.filesMatchByStreamingHash(
        client,
        localPath,
        remotePath,
        timeout,
        debug,
      );
      return identical
        ? { skip: true, reason: `identical-sha256(${localSize} bytes)` }
        : { skip: false, reason: "content-differs" };
    } catch {
      // A failed optional comparison must not prevent the real upload.
      return { skip: false, reason: "streamed-content-compare-unavailable" };
    }
  }

  /**
   * Compare one local and one remote file without buffering either whole file.
   * The two streams are hashed independently because their chunk boundaries are
   * not guaranteed to align. The same inactivity watchdog used by transfers
   * makes a stale reused SFTP channel fail rather than hang this comparison.
   */
  private async filesMatchByStreamingHash(
    client: Client,
    localPath: string,
    remotePath: string,
    timeout?: number,
    debug?: SshDebugSink,
  ): Promise<boolean> {
    const sftp = await this.openSftp(client, "fast-upload-compare", timeout, debug);
    let localStream: fs.ReadStream | null = null;
    let remoteStream: NodeJS.ReadableStream | null = null;
    const cleanup = () => {
      this.destroyStream(localStream);
      this.destroyStream(remoteStream);
      try {
        sftp.end();
      } catch {
        // Ignore late SFTP cleanup errors.
      }
    };

    try {
      return await this.runWithInactivityTimeout<boolean>(
        (onProgress) =>
          new Promise<boolean>((resolve, reject) => {
            const localHash = crypto.createHash("sha256");
            const remoteHash = crypto.createHash("sha256");
            let localDone = false;
            let remoteDone = false;
            let settled = false;

            const fail = (error: Error) => {
              if (settled) return;
              settled = true;
              cleanup();
              reject(error);
            };
            const finish = () => {
              if (settled || !localDone || !remoteDone) return;
              settled = true;
              resolve(localHash.digest("hex") === remoteHash.digest("hex"));
            };

            try {
              localStream = fs.createReadStream(localPath);
              remoteStream = sftp.createReadStream(remotePath);
              localStream.on("data", (chunk: string | Buffer) => {
                localHash.update(chunk);
                onProgress();
              });
              remoteStream.on("data", (chunk: string | Buffer) => {
                remoteHash.update(chunk);
                onProgress();
              });
              localStream.on("end", () => {
                localDone = true;
                finish();
              });
              remoteStream.on("end", () => {
                remoteDone = true;
                finish();
              });
              localStream.on("error", (error: Error) => fail(error));
              remoteStream.on("error", (error: Error) => fail(error));
            } catch (error) {
              fail(error as Error);
            }
          }),
        this.transferStallTimeout(timeout),
        `compare ${remotePath}`,
        debug,
        cleanup,
      );
    } finally {
      cleanup();
    }
  }

  /**
   * Return a copy of `buf` with every CRLF replaced by LF. No-op if the
   * buffer contains no CRLF.
   */
  private static normalizeCrlfToLf(buf: Buffer): Buffer {
    if (buf.indexOf("\r\n") === -1) return buf;
    return Buffer.from(
      buf.toString("binary").replace(/\r\n/g, "\n"),
      "binary",
    );
  }

  /**
   * Read an SFTP file fully into a Buffer.
   *
   * Guarded by an inactivity watchdog: if no bytes arrive for the stall window
   * (a dead reused connection can open the channel but never stream) the read
   * aborts with a retriable error instead of hanging. An actively-streaming
   * read is never killed because each chunk resets the watchdog.
   */
  private async sftpReadBuffer(
    client: Client,
    remotePath: string,
    expectedSize: number,
    timeout?: number,
    debug?: SshDebugSink,
  ): Promise<Buffer> {
    const sftp = await this.openSftp(client, "read", timeout, debug);
    const endSftp = () => {
      try {
        sftp.end();
      } catch {
        // Ignore late SFTP cleanup errors.
      }
    };
    try {
      return await this.runWithInactivityTimeout<Buffer>(
        (onProgress) =>
          new Promise<Buffer>((resolve, reject) => {
            const chunks: Buffer[] = [];
            let received = 0;
            const stream = sftp.createReadStream(remotePath);
            stream.on("data", (chunk: Buffer) => {
              chunks.push(chunk);
              received += chunk.length;
              onProgress();
            });
            stream.on("error", (e: Error) => {
              reject(this.makeSftpError("Remote read failed", e));
            });
            stream.on("end", () => {
              if (received !== expectedSize) {
                return reject(
                  new ToolError(
                    "SFTP_ERROR",
                    `Remote read short: expected ${expectedSize} bytes, got ${received}`,
                    false,
                  ),
                );
              }
              resolve(Buffer.concat(chunks, received));
            });
          }),
        this.transferStallTimeout(timeout),
        `remote read ${remotePath}`,
        debug,
        endSftp,
      );
    } finally {
      endSftp();
    }
  }

  /**
   * Write a Buffer to an SFTP path (overwrites if exists).
   *
   * The payload is written in chunks so the inactivity watchdog gets a real
   * progress signal per acknowledged chunk: a dead reused connection that opens
   * the channel but never acks a write aborts with a retriable error instead of
   * hanging, while an actively-flushing write is never killed.
   */
  private async sftpWriteBuffer(
    client: Client,
    remotePath: string,
    payload: Buffer,
    timeout?: number,
    debug?: SshDebugSink,
  ): Promise<void> {
    const sftp = await this.openSftp(client, "write", timeout, debug);
    const endSftp = () => {
      try {
        sftp.end();
      } catch {
        // Ignore late SFTP cleanup errors.
      }
    };
    try {
      await this.runWithInactivityTimeout<void>(
        (onProgress) =>
          new Promise<void>((resolve, reject) => {
            const writeStream = sftp.createWriteStream(remotePath);
            let offset = 0;
            let ended = false;

            writeStream.on("close", () => resolve());
            writeStream.on("error", (e: Error) => {
              reject(this.makeSftpError("File upload failed", e));
            });

            const writeNext = () => {
              if (offset >= payload.length) {
                if (!ended) {
                  ended = true;
                  writeStream.end();
                }
                return;
              }
              const end = Math.min(offset + TransferService.SFTP_WRITE_CHUNK_BYTES, payload.length);
              const chunk = payload.subarray(offset, end);
              offset = end;
              writeStream.write(chunk, (err?: Error | null) => {
                if (err) {
                  // The "error" event will reject; nothing else to do here.
                  return;
                }
                onProgress();
                writeNext();
              });
            };

            writeNext();
          }),
        this.transferStallTimeout(timeout),
        `upload ${remotePath}`,
        debug,
        endSftp,
      );
    } finally {
      endSftp();
    }
  }

  /**
   * Upload a local file using ssh2's parallel SFTP fastPut implementation.
   */
  private async sftpFastPut(
    client: Client,
    localPath: string,
    remotePath: string,
    options: SftpOptions | undefined,
    timeout?: number,
    debug?: SshDebugSink,
  ): Promise<void> {
    // Validate transfer options BEFORE opening the channel so invalid options
    // can never leak an SFTP channel.
    const transferOptions = this.createSftpTransferOptions(options);
    const sftp = await this.openSftp(client, "fastPut", timeout, debug);
    debug?.(
      `[mcp] fastPut ${localPath} -> ${remotePath}, concurrency=${transferOptions.concurrency ?? "ssh2-default"}, chunkSize=${transferOptions.chunkSize ?? "ssh2-default"}`,
    );

    const endSftp = () => {
      try {
        sftp.end();
      } catch {
        // Ignore late SFTP cleanup errors.
      }
    };

    try {
      await this.runWithInactivityTimeout<void>(
        (onProgress) =>
          new Promise<void>((resolve, reject) => {
            sftp.fastPut(
              localPath,
              remotePath,
              { ...transferOptions, step: () => onProgress() },
              (err?: Error | null) => {
                if (err) {
                  reject(this.makeSftpError("Fast upload failed", err));
                  return;
                }
                resolve();
              },
            );
          }),
        this.transferStallTimeout(timeout),
        `fast upload ${localPath} -> ${remotePath}`,
        debug,
        endSftp,
      );
    } finally {
      endSftp();
    }
  }

  /**
   * Download a remote file using ssh2's parallel SFTP fastGet implementation.
   */
  private async sftpFastGet(
    client: Client,
    remotePath: string,
    localPath: string,
    options: SftpOptions | undefined,
    timeout?: number,
    debug?: SshDebugSink,
  ): Promise<void> {
    // Validate transfer options BEFORE opening the channel so invalid options
    // can never leak an SFTP channel.
    const transferOptions = this.createSftpTransferOptions(options);
    const sftp = await this.openSftp(client, "fastGet", timeout, debug);
    debug?.(
      `[mcp] fastGet ${remotePath} -> ${localPath}, concurrency=${transferOptions.concurrency ?? "ssh2-default"}, chunkSize=${transferOptions.chunkSize ?? "ssh2-default"}`,
    );

    const endSftp = () => {
      try {
        sftp.end();
      } catch {
        // Ignore late SFTP cleanup errors.
      }
    };

    try {
      await this.runWithInactivityTimeout<void>(
        (onProgress) =>
          new Promise<void>((resolve, reject) => {
            sftp.fastGet(
              remotePath,
              localPath,
              { ...transferOptions, step: () => onProgress() },
              (err?: Error | null) => {
                if (err) {
                  reject(this.makeSftpError("Fast download failed", err));
                  return;
                }
                resolve();
              },
            );
          }),
        this.transferStallTimeout(timeout),
        `fast download ${remotePath} -> ${localPath}`,
        debug,
        endSftp,
      );
    } finally {
      endSftp();
    }
  }

  /**
   * Download file
   */
  public async download(
    remotePath: string,
    localPath: string,
    name?: string,
    options?: SftpOptions,
  ): Promise<string> {
    const resolvedName = name || this.pool.defaultName;
    const reuseConnection = options?.reuseConnection !== false;
    const { collector: debugCollector, debug } = createDebugCollector(options?.vvv === true);
    const validatedLocalPath = this.validateLocalPath(localPath, resolvedName);
    const validatedRemotePath = this.validateRemotePath(remotePath, resolvedName);
    debug?.(`[mcp] sftp download on [${resolvedName}], reuseConnection=${reuseConnection}`);
    let connection: AcquiredSshClient | null = null;
    try {
      connection = await this.pool.acquireSshClient(resolvedName, {
        reuseConnection,
        timeout: options?.timeout,
        debug,
        purpose: "sftp",
      });

      if (options?.fast === true) {
        await this.sftpFastGet(
          connection.client,
          validatedRemotePath,
          validatedLocalPath,
          options,
          options?.timeout,
          debug,
        );
        return appendDebugOutput(
          "File downloaded successfully via fast SFTP",
          debugCollector,
        );
      }

      const sftp = await this.openSftp(connection.client, "download", options?.timeout, debug);
      try {
        await this.pipeWithInactivityTimeout(
          sftp.createReadStream(validatedRemotePath),
          fs.createWriteStream(validatedLocalPath),
          this.transferStallTimeout(options?.timeout),
          `download ${validatedRemotePath} -> ${validatedLocalPath}`,
          debug,
          (err) => this.makeSftpError("File download failed", err),
          (err) => new ToolError("LOCAL_FILE_WRITE_FAILED", `Failed to save file: ${err.message}`, false),
        );
      } finally {
        try {
          sftp.end();
        } catch {
          // Ignore late SFTP cleanup errors.
        }
      }
      return appendDebugOutput("File downloaded successfully", debugCollector);
    } catch (error) {
      if (reuseConnection && this.pool.isConnectionError(error as Error)) {
        this.pool.closeClient(resolvedName, true);
      }
      throw appendDebugToError(error as Error, debugCollector);
    } finally {
      connection?.close();
    }
  }


  /**
   * Transfer a file between two remote servers by piping SFTP streams
   * directly through the MCP host memory. No temp file, no SCP, no
   * authorized-key exchange between the two servers required -- each
   * side uses its own existing SSH session.
   * After the transfer, file sizes are compared via SFTP stat.
   * If both servers have md5sum, a hash verification is also performed.
   */
  public async transferBetweenServers(
    sourceName: string,
    sourceRemotePath: string,
    destName: string,
    destRemotePath: string,
    options?: SftpOptions & { skipIfIdentical?: boolean },
  ): Promise<string> {
    const validatedSourcePath = this.validateRemotePath(sourceRemotePath, sourceName);
    const validatedDestPath = this.validateRemotePath(destRemotePath, destName);
    const skipIfIdentical = options?.skipIfIdentical !== false; // default true
    const reuseConnection = options?.reuseConnection !== false;
    const selfRelay = sourceName === destName;
    const { collector: debugCollector, debug } = createDebugCollector(options?.vvv === true);

    debug?.(
      `[mcp] sftp relay ${sourceName} -> ${destName}, reuseConnection=${reuseConnection}`,
    );
    let srcConnection: AcquiredSshClient | null = null;
    let dstConnection: AcquiredSshClient | null = null;
    let srcSftp: SFTPWrapper | null = null;
    let dstSftp: SFTPWrapper | null = null;

    try {
      srcConnection = await this.pool.acquireSshClient(sourceName, {
        reuseConnection,
        timeout: options?.timeout,
        debug,
        purpose: "sftp",
      });
      // Same host on both ends: reuse the one SSH client (two SFTP channels are
      // still opened below) so we never open or close a second connection.
      dstConnection = selfRelay
        ? srcConnection
        : await this.pool.acquireSshClient(destName, {
            reuseConnection,
            timeout: options?.timeout,
            debug,
            purpose: "sftp",
          });
      const srcClient = srcConnection.client;
      const dstClient = dstConnection.client;

      srcSftp = await this.openSftp(srcClient, "source", options?.timeout, debug);
      dstSftp = await this.openSftp(dstClient, "dest", options?.timeout, debug);
      // Get source file size before transfer
      const srcStat = await this.sftpStat(srcSftp, validatedSourcePath, "source");

      // Skip-if-identical: same size on both sides AND matching md5sum (when
      // available on both). We never pull bytes through the MCP host for the
      // compare — if md5sum is missing on either side we just transfer.
      if (skipIfIdentical) {
        const dstStatProbe = await this.sftpStat(dstSftp, validatedDestPath, "dest")
          .catch(() => null);
        if (dstStatProbe && dstStatProbe.size === srcStat.size) {
          const [srcMd5, dstMd5] = await Promise.all([
            this.remoteMd5(srcClient, validatedSourcePath).catch(() => null),
            this.remoteMd5(dstClient, validatedDestPath).catch(() => null),
          ]);
          if (srcMd5 && dstMd5 && srcMd5 === dstMd5) {
            const srcConfig = this.pool.getConfig(sourceName);
            const dstConfig = this.pool.getConfig(destName);
            return appendDebugOutput(
              `Transfer skipped: destination already identical ` +
                `(size=${srcStat.size} bytes, md5=${srcMd5}). ` +
                `${srcConfig.username}@${srcConfig.host}:${validatedSourcePath}` +
                ` == ${dstConfig.username}@${dstConfig.host}:${validatedDestPath}`,
              debugCollector,
            );
          }
        }
      }

      // Bind the validated paths into the rest of the verification flow so
      // we never accidentally fall back to the un-validated originals.
      sourceRemotePath = validatedSourcePath;
      destRemotePath = validatedDestPath;

      await this.relayWithPrefetchWindow(
        srcSftp,
        dstSftp,
        validatedSourcePath,
        validatedDestPath,
        srcStat.size,
        options,
        options?.timeout,
        `relay ${sourceName}:${validatedSourcePath} -> ${destName}:${validatedDestPath}`,
        debug,
      );

      // --- Verification ---
      const dstStat = await this.sftpStat(dstSftp, destRemotePath, "dest");
      const verification: string[] = [];

      // Size check
      if (srcStat.size !== dstStat.size) {
        throw new ToolError(
          "SFTP_ERROR",
          `Transfer verification failed: size mismatch (source=${srcStat.size} bytes, dest=${dstStat.size} bytes)`,
          true,
        );
      }
      verification.push(`size=${srcStat.size} bytes ✓`);

      // MD5 check (best-effort: if md5sum is available on both servers)
      const [srcMd5, dstMd5] = await Promise.all([
        this.remoteMd5(srcClient, sourceRemotePath).catch(() => null),
        this.remoteMd5(dstClient, destRemotePath).catch(() => null),
      ]);

      if (srcMd5 && dstMd5) {
        if (srcMd5 !== dstMd5) {
          throw new ToolError(
            "SFTP_ERROR",
            `Transfer verification failed: MD5 mismatch (source=${srcMd5}, dest=${dstMd5})`,
            true,
          );
        }
        verification.push(`md5=${srcMd5} ✓`);
      }

      const srcConfig = this.pool.getConfig(sourceName);
      const dstConfig = this.pool.getConfig(destName);
      return appendDebugOutput(
        `Transfer complete (windowed via SFTP, verified: ${verification.join(", ")}): ` +
          `${srcConfig.username}@${srcConfig.host}:${sourceRemotePath}` +
          ` → ${dstConfig.username}@${dstConfig.host}:${destRemotePath}`,
        debugCollector,
      );
    } catch (error) {
      if (reuseConnection && this.pool.isConnectionError(error as Error)) {
        this.pool.closeClient(sourceName, true);
        if (!selfRelay) this.pool.closeClient(destName, true);
      }
      throw appendDebugToError(error as Error, debugCollector);
    } finally {
      srcSftp?.end();
      dstSftp?.end();
      srcConnection?.close();
      if (!selfRelay) dstConnection?.close();
    }
  }

  /**
   * Pack a local file/directory into a temporary tar archive, upload that one
   * file, and extract it into a remote destination directory. The source
   * basename is retained inside the archive.
   */
  public async uploadArchive(
    localSourcePath: string,
    remoteDestinationDirectory: string,
    name?: string,
    compression: ArchiveCompression = "none",
    options?: SftpOptions,
  ): Promise<string> {
    const resolvedName = name || this.pool.defaultName;
    const validatedSource = this.validateLocalPath(localSourcePath, resolvedName);
    const validatedDestination = this.validateRemotePath(remoteDestinationDirectory, resolvedName);
    this.assertLocalArchiveSource(validatedSource);
    const { collector: debugCollector, debug } = createDebugCollector(options?.vvv === true);
    const workspace = this.createLocalArchiveWorkspace(compression);
    const remoteArchive = this.createRemoteArchivePath(validatedDestination, compression);
    let remoteArchiveMayExist = false;

    try {
      await this.runLocalTar(
        this.archiveCreateArgs(workspace.archivePath, validatedSource, compression, path),
        `create ${compression} archive from '${validatedSource}'`,
        "LOCAL_FILE_READ_FAILED",
      );
      await this.ensureRemoteDirectory(resolvedName, validatedDestination, options, debug);
      remoteArchiveMayExist = true;
      await this.upload(workspace.archivePath, remoteArchive, resolvedName, {
        ...options,
        fast: options?.fast !== false,
        skipIfIdentical: false,
      });
      await this.runRemoteTarOnServer(
        resolvedName,
        this.archiveExtractArgs(remoteArchive, validatedDestination, compression),
        `extract ${compression} archive into '${validatedDestination}'`,
        options,
        debug,
      );
      return appendDebugOutput(
        `Archive upload complete (${compression}): '${validatedSource}' → ${resolvedName}:'${validatedDestination}'`,
        debugCollector,
      );
    } catch (error) {
      throw appendDebugToError(error as Error, debugCollector);
    } finally {
      if (remoteArchiveMayExist) {
        await this.cleanupRemoteArchive(resolvedName, remoteArchive, options, debug);
      }
      this.cleanupLocalArchiveWorkspace(workspace.directory);
    }
  }

  /**
   * Pack a remote file/directory into one temporary archive, download it, and
   * extract it locally. The source basename is retained inside the archive.
   */
  public async downloadArchive(
    remoteSourcePath: string,
    localDestinationDirectory: string,
    name?: string,
    compression: ArchiveCompression = "none",
    options?: SftpOptions,
  ): Promise<string> {
    const resolvedName = name || this.pool.defaultName;
    const validatedSource = this.validateRemotePath(remoteSourcePath, resolvedName);
    const validatedDestination = this.validateLocalPath(localDestinationDirectory, resolvedName);
    this.ensureLocalDestinationDirectory(validatedDestination);
    this.assertArchiveBasename(path.posix.basename(validatedSource), validatedSource);
    const { collector: debugCollector, debug } = createDebugCollector(options?.vvv === true);
    const workspace = this.createLocalArchiveWorkspace(compression);
    const remoteArchive = this.createRemoteArchivePath(path.posix.dirname(validatedSource), compression);
    let remoteArchiveMayExist = false;

    try {
      remoteArchiveMayExist = true;
      await this.runRemoteTarOnServer(
        resolvedName,
        this.archiveCreateArgs(remoteArchive, validatedSource, compression, path.posix),
        `create ${compression} archive from '${validatedSource}'`,
        options,
        debug,
      );
      await this.download(remoteArchive, workspace.archivePath, resolvedName, {
        ...options,
        fast: options?.fast !== false,
      });
      await this.runLocalTar(
        this.archiveExtractArgs(workspace.archivePath, validatedDestination, compression),
        `extract ${compression} archive into '${validatedDestination}'`,
        "LOCAL_FILE_WRITE_FAILED",
      );
      return appendDebugOutput(
        `Archive download complete (${compression}): ${resolvedName}:'${validatedSource}' → '${validatedDestination}'`,
        debugCollector,
      );
    } catch (error) {
      throw appendDebugToError(error as Error, debugCollector);
    } finally {
      if (remoteArchiveMayExist) {
        await this.cleanupRemoteArchive(resolvedName, remoteArchive, options, debug);
      }
      this.cleanupLocalArchiveWorkspace(workspace.directory);
    }
  }

  /**
   * Pack on the source server, relay one archive through the existing bounded
   * SFTP window, and extract on the destination server.
   */
  public async transferArchiveBetweenServers(
    sourceName: string,
    sourceRemotePath: string,
    destName: string,
    destRemoteDirectory: string,
    compression: ArchiveCompression = "none",
    options?: SftpOptions,
  ): Promise<string> {
    const validatedSource = this.validateRemotePath(sourceRemotePath, sourceName);
    const validatedDestination = this.validateRemotePath(destRemoteDirectory, destName);
    this.assertArchiveBasename(path.posix.basename(validatedSource), validatedSource);
    const { collector: debugCollector, debug } = createDebugCollector(options?.vvv === true);
    const sourceArchive = this.createRemoteArchivePath(path.posix.dirname(validatedSource), compression);
    const destArchive = this.createRemoteArchivePath(validatedDestination, compression);
    let sourceArchiveMayExist = false;
    let destArchiveMayExist = false;

    try {
      sourceArchiveMayExist = true;
      await this.runRemoteTarOnServer(
        sourceName,
        this.archiveCreateArgs(sourceArchive, validatedSource, compression, path.posix),
        `create ${compression} archive from '${validatedSource}'`,
        options,
        debug,
      );
      await this.ensureRemoteDirectory(destName, validatedDestination, options, debug);
      destArchiveMayExist = true;
      await this.transferBetweenServers(sourceName, sourceArchive, destName, destArchive, {
        ...options,
        skipIfIdentical: false,
      });
      await this.runRemoteTarOnServer(
        destName,
        this.archiveExtractArgs(destArchive, validatedDestination, compression),
        `extract ${compression} archive into '${validatedDestination}'`,
        options,
        debug,
      );
      return appendDebugOutput(
        `Archive relay complete (${compression}): ${sourceName}:'${validatedSource}' → ${destName}:'${validatedDestination}'`,
        debugCollector,
      );
    } catch (error) {
      throw appendDebugToError(error as Error, debugCollector);
    } finally {
      if (sourceArchiveMayExist) {
        await this.cleanupRemoteArchive(sourceName, sourceArchive, options, debug);
      }
      if (destArchiveMayExist) {
        await this.cleanupRemoteArchive(destName, destArchive, options, debug);
      }
    }
  }

  /**
   * SFTP stat a remote file.
   */
  private sftpStat(
    sftp: SFTPWrapper,
    remotePath: string,
    label: string,
  ): Promise<{ size: number }> {
    return new Promise((resolve, reject) => {
      sftp.stat(remotePath, (err, stats) => {
        if (err) {
          return reject(
            this.makeSftpError(`Failed to stat ${label} file`, err),
          );
        }
        resolve({ size: stats.size });
      });
    });
  }

  /**
   * Compute MD5 of a remote file via ssh exec. Returns null if md5sum is unavailable.
   */
  private remoteMd5(client: Client, remotePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      client.exec(`md5sum ${this.shellQuote(remotePath)}`, (err, stream) => {
        if (err) return reject(err);

        let data = "";
        stream.on("data", (chunk: Buffer) => { data += chunk.toString(); });
        stream.stderr.on("data", () => { /* ignore stderr */ });
        stream.on("close", (code: number) => {
          if (code !== 0) return reject(new Error("md5sum failed"));
          const hash = data.trim().split(/\s+/)[0];
          if (!hash || hash.length !== 32) return reject(new Error("unexpected md5sum output"));
          resolve(hash);
        });
      });
    });
  }

  /**
   * Minimal POSIX shell quoting for a file path.
   */
  private shellQuote(s: string): string {
    return "'" + s.replace(/'/g, "'\\''") + "'";
  }

  private archiveSuffix(compression: ArchiveCompression): string {
    switch (compression) {
      case "none": return ".tar";
      case "gzip": return ".tar.gz";
      case "bzip2": return ".tar.bz2";
      case "xz": return ".tar.xz";
      case "zstd": return ".tar.zst";
    }
  }

  private archiveCreateArgs(
    archivePath: string,
    sourcePath: string,
    compression: ArchiveCompression,
    pathApi: Pick<typeof path, "dirname" | "basename">,
  ): string[] {
    const basename = pathApi.basename(sourcePath);
    this.assertArchiveBasename(basename, sourcePath);
    const flagArgs = compression === "zstd"
      ? ["--zstd", "-cf"]
      : [{ none: "-cf", gzip: "-czf", bzip2: "-cjf", xz: "-cJf" }[compression]];
    return [...flagArgs, archivePath, "-C", pathApi.dirname(sourcePath), "--", basename];
  }

  private archiveExtractArgs(
    archivePath: string,
    destinationDirectory: string,
    compression: ArchiveCompression,
  ): string[] {
    const flagArgs = compression === "zstd"
      ? ["--zstd", "-xf"]
      : [{ none: "-xf", gzip: "-xzf", bzip2: "-xjf", xz: "-xJf" }[compression]];
    return [...flagArgs, archivePath, "-C", destinationDirectory];
  }

  private assertArchiveBasename(basename: string, sourcePath: string): void {
    if (!basename || basename === "." || basename === "..") {
      throw new ToolError(
        "INVALID_CONFIGURATION",
        `Archive source must name a file or directory, not a filesystem root: ${sourcePath}`,
        false,
      );
    }
  }

  private assertLocalArchiveSource(sourcePath: string): void {
    try {
      fs.statSync(sourcePath);
    } catch (error) {
      throw new ToolError(
        "LOCAL_FILE_READ_FAILED",
        `Failed to stat archive source '${sourcePath}': ${(error as Error).message}`,
        false,
      );
    }
    this.assertArchiveBasename(path.basename(sourcePath), sourcePath);
  }

  private ensureLocalDestinationDirectory(destinationDirectory: string): void {
    try {
      if (fs.existsSync(destinationDirectory)) {
        if (!fs.statSync(destinationDirectory).isDirectory()) {
          throw new Error("destination exists and is not a directory");
        }
      } else {
        fs.mkdirSync(destinationDirectory, { recursive: true });
      }
    } catch (error) {
      throw new ToolError(
        "LOCAL_FILE_WRITE_FAILED",
        `Failed to prepare archive destination '${destinationDirectory}': ${(error as Error).message}`,
        false,
      );
    }
  }

  private createLocalArchiveWorkspace(compression: ArchiveCompression): {
    directory: string;
    archivePath: string;
  } {
    try {
      // Use the OS temp directory, not process.cwd(): an MCP server's working
      // directory is arbitrary and often a user's project directory, so
      // creating archive scratch space there would litter it and tie large
      // temporary archives to whatever volume cwd happens to live on.
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), ".handfree-transfer-"));
      this.internalTransferWorkspaces.add(directory);
      return {
        directory,
        archivePath: path.join(directory, `payload${this.archiveSuffix(compression)}`),
      };
    } catch (error) {
      throw new ToolError(
        "LOCAL_FILE_WRITE_FAILED",
        `Failed to create local transfer workspace: ${(error as Error).message}`,
        false,
      );
    }
  }

  private cleanupLocalArchiveWorkspace(directory: string): void {
    try {
      fs.rmSync(directory, { recursive: true, force: true });
    } catch (error) {
      Logger.log(`Failed to clean local transfer workspace '${directory}': ${(error as Error).message}`, "error");
    } finally {
      this.internalTransferWorkspaces.delete(directory);
    }
  }

  private createRemoteArchivePath(
    remoteDirectory: string,
    compression: ArchiveCompression,
  ): string {
    const token = crypto.randomBytes(12).toString("hex");
    return path.posix.join(
      remoteDirectory,
      `.handfree-transfer-${token}${this.archiveSuffix(compression)}`,
    );
  }

  private async runLocalTar(
    args: string[],
    description: string,
    errorCode: "LOCAL_FILE_READ_FAILED" | "LOCAL_FILE_WRITE_FAILED",
  ): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const stderr = new OutputCollector(TransferService.ARCHIVE_ERROR_OUTPUT_BYTES);
      let settled = false;
      // See buildLocalTarArgv's doc comment for why this platform-conditional
      // rewrite exists (drive-letter misparse + extraction path corruption on
      // Windows/MSYS tar builds).
      const localArgs = buildLocalTarArgv(args, process.platform);
      const child = spawn("tar", localArgs, {
        stdio: ["ignore", "ignore", "pipe"],
        windowsHide: true,
      });
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        reject(new ToolError(errorCode, `Failed to ${description}: ${error.message}`, false));
      });
      child.once("close", (code) => {
        if (settled) return;
        settled = true;
        if (code === 0) {
          resolve();
          return;
        }
        const detail = stderr.getSnapshot().tail.toString("utf8").trim();
        reject(new ToolError(
          errorCode,
          `Failed to ${description} (tar exit ${code})${detail ? `: ${detail}` : ""}`,
          false,
        ));
      });
    });
  }

  private async runRemoteTarOnServer(
    name: string,
    args: string[],
    description: string,
    options: SftpOptions | undefined,
    debug: SshDebugSink | undefined,
  ): Promise<void> {
    const reuseConnection = options?.reuseConnection !== false;
    let connection: AcquiredSshClient | null = null;
    try {
      connection = await this.pool.acquireSshClient(name, {
        reuseConnection,
        timeout: options?.timeout,
        debug,
        purpose: "command",
      });
      const command = ["tar", ...args].map((arg) => this.shellQuote(arg)).join(" ");
      debug?.(`[mcp] remote archive command on [${name}]: tar ${args[0] ?? ""}`);
      const stream = await this.pool.withConnectionTimeout(
        new Promise<ClientChannel>((resolve, reject) => {
          connection!.client.exec(command, (error, channel) => {
            if (error) {
              reject(this.pool.isConnectionShapedMessage(error.message)
                ? new ToolError("SSH_CONNECTION_FAILED", `Failed to open remote archive command: ${error.message}`, true)
                : new ToolError("COMMAND_EXECUTION_ERROR", `Failed to open remote archive command: ${error.message}`, false));
              return;
            }
            resolve(channel);
          });
        }),
        this.pool.normalizeConnectTimeout(options?.timeout),
        `Remote archive command channel open on [${name}]`,
        debug,
      );
      await new Promise<void>((resolve, reject) => {
        const stderr = new OutputCollector(TransferService.ARCHIVE_ERROR_OUTPUT_BYTES);
        let settled = false;
        const finish = (error?: Error) => {
          if (settled) return;
          settled = true;
          error ? reject(error) : resolve();
        };
        stream.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
        stream.on("error", (error: Error) => finish(this.makeSftpError(`Remote archive command failed on [${name}]`, error)));
        const finishWithExitCode = (code: number | null) => {
          if (code === 0) {
            finish();
            return;
          }
          const detail = stderr.getSnapshot().tail.toString("utf8").trim();
          finish(new ToolError(
            "COMMAND_EXECUTION_ERROR",
            `Failed to ${description} on [${name}] (tar exit ${code ?? "unknown"})${detail ? `: ${detail}` : ""}`,
            false,
          ));
        };
        // RFC 4254 exit-status precedes channel close. Some SSH servers send a
        // valid exit-status but delay or omit the reciprocal close handshake;
        // accepting either event prevents a completed tar from hanging forever.
        // `finish` is idempotent, so normal servers emitting both are safe.
        stream.on("exit", (code: number | null) => finishWithExitCode(code));
        stream.on("close", (code: number | null) => finishWithExitCode(code));
      });
    } catch (error) {
      if (reuseConnection && this.pool.isConnectionError(error as Error)) {
        this.pool.closeClient(name, true);
      }
      throw error;
    } finally {
      connection?.close();
    }
  }

  private async ensureRemoteDirectory(
    name: string,
    remoteDirectory: string,
    options: SftpOptions | undefined,
    debug: SshDebugSink | undefined,
  ): Promise<void> {
    const reuseConnection = options?.reuseConnection !== false;
    let connection: AcquiredSshClient | null = null;
    try {
      connection = await this.pool.acquireSshClient(name, {
        reuseConnection,
        timeout: options?.timeout,
        debug,
        purpose: "sftp",
      });
      await this.sftpMkdirRecursive(connection.client, remoteDirectory, options?.timeout, debug);
    } catch (error) {
      if (reuseConnection && this.pool.isConnectionError(error as Error)) {
        this.pool.closeClient(name, true);
      }
      throw error;
    } finally {
      connection?.close();
    }
  }

  private async cleanupRemoteArchive(
    name: string,
    remoteArchivePath: string,
    options: SftpOptions | undefined,
    debug: SshDebugSink | undefined,
  ): Promise<void> {
    const reuseConnection = options?.reuseConnection !== false;
    let connection: AcquiredSshClient | null = null;
    let sftp: SFTPWrapper | null = null;
    try {
      connection = await this.pool.acquireSshClient(name, {
        reuseConnection,
        timeout: options?.timeout,
        debug,
        purpose: "sftp",
      });
      sftp = await this.openSftp(connection.client, "archive-cleanup", options?.timeout, debug);
      await new Promise<void>((resolve, reject) => {
        sftp!.unlink(remoteArchivePath, (error?: Error | null) => {
          if (!error || /no such|not found/i.test(error.message)) {
            resolve();
            return;
          }
          reject(this.makeSftpError("Failed to remove remote temporary archive", error));
        });
      });
    } catch (error) {
      Logger.log(
        `Failed to clean remote temporary archive [${name}] '${remoteArchivePath}': ${(error as Error).message}`,
        "error",
      );
    } finally {
      try { sftp?.end(); } catch { /* ignore cleanup errors */ }
      connection?.close();
    }
  }

  /**
   * Open an SFTP session from an existing SSH client.
   */
  private openSftp(
    client: Client,
    label: string,
    timeout?: number,
    debug?: SshDebugSink,
  ): Promise<SFTPWrapper> {
    const open = new Promise<SFTPWrapper>((resolve, reject) => {
      client.sftp((err: Error | undefined, sftp: SFTPWrapper) => {
        if (err) {
          // A client that cannot open an SFTP channel is unusable, so treat the
          // failure as connection-shaped regardless of wording. This lets the
          // caller force-drop the stale cached client and self-heal on retry.
          return reject(new ToolError(
            "SSH_CONNECTION_FAILED",
            `SFTP connection failed (${label}): ${err.message}`,
            true,
          ));
        }
        debug?.(`[mcp] sftp channel opened (${label})`);
        resolve(sftp);
      });
    });
    return this.pool.withConnectionTimeout(
      open,
      this.pool.normalizeConnectTimeout(timeout),
      `SFTP channel open (${label})`,
      debug,
      undefined,
      (sftp) => {
        try {
          sftp.end();
        } catch {
          // Ignore late SFTP cleanup errors.
        }
      },
    );
  }

  /**
   * List remote files/directories via SFTP readdir
   */
  public async listRemoteDir(
    remotePath: string,
    name?: string,
    options?: SftpOptions,
  ): Promise<Array<{ filename: string; isDirectory: boolean; size: number }>> {
    const resolvedName = name || this.pool.defaultName;
    const reuseConnection = options?.reuseConnection !== false;
    const { collector: debugCollector, debug } = createDebugCollector(options?.vvv === true);
    debug?.(`[mcp] sftp list on [${resolvedName}], reuseConnection=${reuseConnection}`);
    let connection: AcquiredSshClient | null = null;

    try {
      connection = await this.pool.acquireSshClient(resolvedName, {
        reuseConnection,
        timeout: options?.timeout,
        debug,
        purpose: "sftp",
      });
      const entries = await new Promise<Array<{ filename: string; isDirectory: boolean; size: number }>>((resolve, reject) => {
        this.openSftp(connection!.client, "list", options?.timeout, debug).then((sftp) => {
          sftp.readdir(remotePath, (err, list) => {
            sftp.end();
            if (err) {
              return reject(this.makeSftpError("Failed to list remote directory", err));
            }
            const entries = list.map((entry) => ({
              filename: entry.filename,
              isDirectory: (entry.attrs.mode & 0o40000) !== 0,
              size: entry.attrs.size,
            }));
            resolve(entries);
          });
        }, reject);
      });
      return entries;
    } catch (error) {
      if (reuseConnection && this.pool.isConnectionError(error as Error)) {
        this.pool.closeClient(resolvedName, true);
      }
      throw appendDebugToError(error as Error, debugCollector);
    } finally {
      connection?.close();
    }
  }

  /**
   * Upload a local directory recursively to a remote server. Directory
   * creation is completed before a bounded pool uploads independent files;
   * this avoids the per-file serial round-trip bottleneck for small trees.
   */
  public async uploadDirectory(
    localDir: string,
    remoteDir: string,
    name?: string,
    options?: SftpOptions & { skipIfIdentical?: boolean },
  ): Promise<string[]> {
    const resolvedName = name || this.pool.defaultName;
    const resolvedLocal = this.validateLocalPath(localDir, resolvedName);
    const validatedRemoteDir = this.validateRemotePath(remoteDir, resolvedName);
    if (!fs.statSync(resolvedLocal).isDirectory()) {
      throw new ToolError("LOCAL_FILE_READ_FAILED", `Not a directory: ${localDir}`, false);
    }
    const fileConcurrency = this.resolveRecursiveFileConcurrency(options);

    const reuseConnection = options?.reuseConnection !== false;
    const { collector: debugCollector, debug } = createDebugCollector(options?.vvv === true);
    debug?.(`[mcp] sftp recursive upload mkdir on [${resolvedName}], reuseConnection=${reuseConnection}`);
    let connection: AcquiredSshClient | null = null;
    try {
      connection = await this.pool.acquireSshClient(resolvedName, {
        reuseConnection,
        timeout: options?.timeout,
        debug,
        purpose: "sftp",
      });
      await this.sftpMkdirRecursive(connection.client, validatedRemoteDir, options?.timeout, debug);
    } catch (error) {
      if (reuseConnection && this.pool.isConnectionError(error as Error)) {
        this.pool.closeClient(resolvedName, true);
      }
      throw appendDebugToError(error as Error, debugCollector);
    } finally {
      connection?.close();
    }

    const directories: string[] = [];
    const files: Array<{ localPath: string; remotePath: string }> = [];
    const collect = (currentLocal: string, currentRemote: string): void => {
      for (const entry of fs.readdirSync(currentLocal, { withFileTypes: true })) {
        const localPath = path.join(currentLocal, entry.name);
        const remotePath = path.posix.join(currentRemote, entry.name);
        if (entry.isDirectory()) {
          directories.push(remotePath);
          collect(localPath, remotePath);
        } else {
          files.push({ localPath, remotePath });
        }
      }
    };
    collect(resolvedLocal, validatedRemoteDir);

    // Create the full directory tree through one SSH connection/SFTP channel
    // before opening parallel file transfers.
    if (directories.length > 0) {
      let directoryConnection: AcquiredSshClient | null = null;
      try {
        directoryConnection = await this.pool.acquireSshClient(resolvedName, {
          reuseConnection,
          timeout: options?.timeout,
          debug,
          purpose: "sftp",
        });
        await this.sftpMkdirMany(directoryConnection.client, directories, options?.timeout, debug);
      } catch (error) {
        if (reuseConnection && this.pool.isConnectionError(error as Error)) {
          this.pool.closeClient(resolvedName, true);
        }
        throw appendDebugToError(error as Error, debugCollector);
      } finally {
        directoryConnection?.close();
      }
    }

    await this.runBoundedTransfers(
      files,
      fileConcurrency,
      async ({ localPath, remotePath }) => {
        await this.upload(localPath, remotePath, resolvedName, options);
      },
    );
    return files.map(({ remotePath }) => remotePath);
  }

  /**
   * PLAN.MD §5.7: upload multiple independent local files to the same remote
   * directory in one call. Each source lands at `remoteDir/<basename>`. This
   * is uploadDirectory() minus the local directory walk -- every file still
   * goes through the existing single-file upload() path so skip-if-identical,
   * CRLF fix, fast, and local/remote path policy are all inherited rather
   * than reimplemented, via a bounded worker pool that (unlike
   * runBoundedTransfers) reports a status for every file instead of throwing
   * on the first failure.
   */
  public async uploadBatch(
    localPaths: string[],
    remoteDir: string,
    name?: string,
    options?: SftpOptions & { skipIfIdentical?: boolean; onError?: BatchUploadOnError },
  ): Promise<BatchUploadResult> {
    // Pre-transfer validation: must reject before any remote I/O (P1-09-A3).
    const validation = validateBatchUploadTargets(localPaths);
    if (!validation.ok) {
      throw new ToolError(validation.code, validation.message, false);
    }

    const resolvedName = name || this.pool.defaultName;
    const validatedRemoteDir = this.validateRemotePath(remoteDir, resolvedName);
    const onError: BatchUploadOnError = options?.onError === "continue" ? "continue" : "abort";
    const fileConcurrency = this.resolveRecursiveFileConcurrency(options);
    const reuseConnection = options?.reuseConnection !== false;

    // Ensure the destination directory exists, mirroring uploadDirectory's
    // mkdir step. This is unconditional remote I/O and intentionally happens
    // after -- never before -- the pure validation above.
    let connection: AcquiredSshClient | null = null;
    try {
      connection = await this.pool.acquireSshClient(resolvedName, {
        reuseConnection,
        timeout: options?.timeout,
        purpose: "sftp",
      });
      await this.sftpMkdirRecursive(connection.client, validatedRemoteDir, options?.timeout);
    } catch (error) {
      if (reuseConnection && this.pool.isConnectionError(error as Error)) {
        this.pool.closeClient(resolvedName, true);
      }
      throw error;
    } finally {
      connection?.close();
    }

    const items = localPaths.map((localPath) => ({
      localPath,
      remotePath: path.posix.join(validatedRemoteDir, batchUploadBasename(localPath)),
    }));

    const outcomes = await this.runBoundedTransfersWithResults(
      items,
      fileConcurrency,
      onError,
      ({ localPath, remotePath }) => this.upload(localPath, remotePath, resolvedName, options),
    );

    const results: BatchUploadFileResult[] = items.map(({ localPath, remotePath }, index) => {
      const outcome = outcomes[index];
      if (outcome.status === "done") {
        if (outcome.value.startsWith(TransferService.UPLOAD_SKIPPED_PREFIX)) {
          return { localPath, remotePath, status: "skipped" };
        }
        return {
          localPath,
          remotePath,
          status: "uploaded",
          crlfFixed: outcome.value.includes(TransferService.CRLF_FIX_MARKER),
        };
      }
      if (outcome.status === "failed") {
        const error = outcome.error;
        return { localPath, remotePath, status: "failed", reason: error instanceof Error ? error.message : String(error) };
      }
      return {
        localPath,
        remotePath,
        status: "failed",
        reason: `not attempted: aborted after an earlier failure (onError=${onError})`,
      };
    });

    return {
      results,
      total: results.length,
      uploadedCount: results.filter((result) => result.status === "uploaded").length,
      skippedCount: results.filter((result) => result.status === "skipped").length,
      failedCount: results.filter((result) => result.status === "failed").length,
      crlfFixedCount: results.filter((result) => result.crlfFixed).length,
    };
  }

  /**
   * PLAN.MD P1-03 (walker slice, §2.3 F5): concurrently discover a remote
   * directory tree with bounded `readdir` concurrency, instead of the old
   * fully-serial `await listRemoteDir` per directory. A semaphore gates only
   * the `list()` call itself -- the one point per directory where
   * `listRemoteDir` opens its own SFTP channel (see `openSftp` inside it) --
   * so at most `concurrency` directory listings are ever in flight at once,
   * consistent with `resolveRecursiveFileConcurrency`'s reasoning about
   * OpenSSH's default `MaxSessions`. Everything else (looping entries, local
   * `mkdir`, recursing into subdirectories) is local and unbounded.
   *
   * Every discovered directory gets `fs.mkdirSync` called for it as soon as
   * it is discovered (before its own contents are listed), matching the old
   * walk's behavior of creating each local directory during the walk rather
   * than deferring it to a separate pass.
   *
   * Failure semantics mirror `runBoundedTransfers`: once any `list()` call
   * fails, no further directory is scheduled, but every listing already in
   * flight is awaited to completion (drained, not left dangling) before the
   * first error is thrown.
   */
  private async walkRemoteDirectory(
    rootRemote: string,
    rootLocal: string,
    concurrency: number,
    list: (remotePath: string) => Promise<Array<{ filename: string; isDirectory: boolean; size: number }>>,
  ): Promise<RemoteDirNode> {
    let activeListings = 0;
    const waiters: Array<() => void> = [];
    const acquire = (): Promise<void> => {
      if (activeListings < concurrency) {
        activeListings++;
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => waiters.push(resolve));
    };
    const release = (): void => {
      const next = waiters.shift();
      if (next) {
        next(); // Hand the slot directly to the next waiter; activeListings unchanged.
      } else {
        activeListings--;
      }
    };

    let firstError: unknown;

    const visit = async (remote: string, local: string, node: RemoteDirNode): Promise<void> => {
      if (firstError !== undefined) return;
      await acquire();
      // Re-check after acquiring: this visit may have been queued behind the
      // semaphore for a long time, and a sibling may have failed while it
      // waited. Without this, every already-queued directory still issues its
      // own doomed listing before the error surfaces -- on a wide tree
      // (thousands of subdirectories discovered but not yet listed) that is
      // thousands of pointless SFTP round trips between the failure and the
      // caller seeing it.
      // Re-check after acquiring: this visit may have been queued behind the
      // semaphore for a long time, and a sibling may have failed while it
      // waited. Without this, every already-queued directory still issues its
      // own doomed listing before the error surfaces -- on a wide tree
      // (thousands of subdirectories discovered but not yet listed) that is
      // thousands of pointless SFTP round trips between the failure and the
      // caller seeing it.
      if (firstError !== undefined) {
        release();
        return;
      }
      let entries: Array<{ filename: string; isDirectory: boolean; size: number }>;
      try {
        entries = await list(remote);
      } catch (error) {
        firstError ??= error;
        return;
      } finally {
        release();
      }
      if (firstError !== undefined) return;

      const childVisits: Promise<void>[] = [];
      for (const entry of entries) {
        if (entry.filename === "." || entry.filename === "..") continue;
        const remotePath = path.posix.join(remote, entry.filename);
        const localPath = path.join(local, entry.filename);
        if (entry.isDirectory) {
          fs.mkdirSync(localPath, { recursive: true });
          const childNode: RemoteDirNode = { children: [] };
          node.children.push({ kind: "dir", node: childNode });
          childVisits.push(visit(remotePath, localPath, childNode));
        } else {
          node.children.push({ kind: "file", remotePath, localPath });
        }
      }
      // Await every child visit this directory started -- including ones
      // whose sibling failed -- so a failure never leaves an in-flight
      // listing dangling/unobserved.
      await Promise.all(childVisits);
    };

    const rootNode: RemoteDirNode = { children: [] };
    await visit(rootRemote, rootLocal, rootNode);
    if (firstError !== undefined) {
      throw firstError;
    }
    return rootNode;
  }

  /**
   * Download a remote directory recursively to a local path. First discover
   * the remote tree and create the local directory tree (bounded-concurrent
   * `readdir`, see `walkRemoteDirectory`), then pull independent files
   * through a bounded worker pool to amortize small-file SFTP round trips.
   * Discovery fully completes before any file transfer starts, so the two
   * phases never both hold SFTP channels at once -- both are bounded by the
   * same `fileConcurrency`, so the combined channel usage never exceeds it.
   */
  public async downloadDirectory(
    remoteDir: string,
    localDir: string,
    name?: string,
    options?: SftpOptions,
  ): Promise<string[]> {
    const resolvedName = name || this.pool.defaultName;
    const resolvedLocal = this.validateLocalPath(localDir, resolvedName);
    const validatedRemoteDir = this.validateRemotePath(remoteDir, resolvedName);
    const fileConcurrency = this.resolveRecursiveFileConcurrency(options);

    if (!fs.existsSync(resolvedLocal)) {
      fs.mkdirSync(resolvedLocal, { recursive: true });
    }

    const tree = await this.walkRemoteDirectory(
      validatedRemoteDir,
      resolvedLocal,
      fileConcurrency,
      (currentRemote) => this.listRemoteDir(currentRemote, resolvedName, options),
    );
    const files = flattenRemoteDirTree(tree);

    await this.runBoundedTransfers(
      files,
      fileConcurrency,
      async ({ remotePath, localPath }) => {
        await this.download(remotePath, localPath, resolvedName, options);
      },
    );
    return files.map(({ localPath }) => localPath);
  }

  /**
   * Create remote directory recursively via SFTP
   */
  private async sftpMkdirRecursive(
    client: Client,
    remotePath: string,
    timeout?: number,
    debug?: SshDebugSink,
  ): Promise<void> {
    const sftp = await this.openSftp(client, "mkdir", timeout, debug);
    const walk = new Promise<void>((resolve, reject) => {
      const parts = remotePath.split("/").filter(Boolean);
      let current = "";

      const mkdirNext = (index: number) => {
        if (index >= parts.length) {
          return resolve();
        }

        current += "/" + parts[index];
        sftp.mkdir(current, (err?: Error | null) => {
          // An existing directory (or other non-connection failure) is fine and
          // just means the path component already exists. A connection-shaped
          // error means the channel died mid-walk -- surface it instead of
          // silently marching on (and eventually hanging the per-file uploads).
          if (err && this.pool.isConnectionShapedMessage(err.message)) {
            return reject(this.makeSftpError("Remote mkdir failed", err));
          }
          mkdirNext(index + 1);
        });
      };

      mkdirNext(0);
    });

    try {
      await this.pool.withConnectionTimeout(
        walk,
        this.pool.normalizeConnectTimeout(timeout),
        `SFTP mkdir ${remotePath}`,
        debug,
      );
    } finally {
      try {
        sftp.end();
      } catch {
        // Ignore late SFTP cleanup errors.
      }
    }
  }

  /** Create already-parent-ordered directories through one SFTP channel. */
  private async sftpMkdirMany(
    client: Client,
    remoteDirectories: readonly string[],
    timeout?: number,
    debug?: SshDebugSink,
  ): Promise<void> {
    const sftp = await this.openSftp(client, "mkdir-many", timeout, debug);
    try {
      for (const remoteDirectory of remoteDirectories) {
        await this.pool.withConnectionTimeout(
          new Promise<void>((resolve, reject) => {
            sftp.mkdir(remoteDirectory, (error?: Error | null) => {
              if (error && this.pool.isConnectionShapedMessage(error.message)) {
                reject(this.makeSftpError(`Remote mkdir failed for '${remoteDirectory}'`, error));
                return;
              }
              resolve();
            });
          }),
          this.pool.normalizeConnectTimeout(timeout),
          `SFTP mkdir ${remoteDirectory}`,
          debug,
        );
      }
    } finally {
      try { sftp.end(); } catch { /* ignore late cleanup errors */ }
    }
  }
}
