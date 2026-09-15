import { Client, ClientChannel } from "ssh2";
import {
  SshConnectionPool,
  type SshDebugSink,
  type AcquiredSshClient,
  type SshAcquireOptions,
} from "../connection/ssh-connection-pool.js";
import type { SFTPWrapper, TransferOptions } from "ssh2";
import { SocksClient } from "socks";
import { SSHConfig, SshConnectionConfigMap, ServerStatus } from "../models/types.js";
import { Logger } from "../utils/logger.js";
import {
  collectSystemStatus,
  DEFAULT_STATUS_COLLECT_TIMEOUT_MS,
} from "../utils/status-collector.js";
import { ToolError } from "../utils/tool-error.js";
import { OutputCollector } from "../utils/output-collector.js";
import { OutputLogWriter } from "../utils/output-log-writer.js";
import { BackgroundCommandLogWriter } from "../utils/background-command-log-writer.js";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import os from "os";
import { spawn } from "node:child_process";

export const BUILT_IN_COMMAND_BLACKLIST: Array<{ regex: RegExp; reason: string }> = [
  { regex: /^\s*(?:sudo\s+)?(?:reboot|shutdown|halt|poweroff)(?:\s|$)/i, reason: "system power command" },
  { regex: /\b(?:Restart-Computer|Stop-Computer)\b/i, reason: "Windows power command" },
  { regex: /^\s*(?:sudo\s+)?(?:init\s+[06]|telinit\s+[06])(?:\s|$)/i, reason: "system runlevel power command" },
  { regex: /^\s*(?:sudo\s+)?rm\b(?=.*(?:\s--recursive\b|\s-\S*r))(?=.*(?:\s--force\b|\s-\S*f))/i, reason: "recursive force rm" },
  { regex: /\bRemove-Item\b(?=.*\s-Recurse(?:\s|$))(?=.*\s-Force(?:\s|$))/i, reason: "recursive force Remove-Item" },
  { regex: /^\s*(?:del|erase|rd)\b(?=.*(?:\/s\b|\s-Recurse(?:\s|$)))(?=.*(?:\/q\b|\s-Force(?:\s|$)))/i, reason: "recursive quiet Windows delete" },
  { regex: /^\s*(?:sudo\s+)?rmdir\s+(?:\/|\*|~|\$HOME|%USERPROFILE%|[A-Za-z]:\\)(?:\s|$)/i, reason: "dangerous rmdir target" },
  { regex: /^\s*(?:sudo\s+)?chmod\s+-R\s+777\b/i, reason: "recursive world-writable chmod" },
  { regex: /^\s*(?:sudo\s+)?chown\s+-R\s+\S+\s+\/(?:\s|$)/i, reason: "recursive chown on root" },
];

// Output redirection (`> /path`, `> ~/path`) is normal, non-destructive usage
// (logging, nohup, saving results) and blocking it broke legitimate workflows.
// Real destructive-operation protection lives in BUILT_IN_COMMAND_BLACKLIST
// (power/recursive-force-rm) and the SFTP path policy, so this guard list is
// intentionally empty. Servers can still add their own patterns via
// commandBlacklist. Kept as an extension point rather than removed outright.
export const BUILT_IN_DESTRUCTIVE_GUARDS: Array<{ regex: RegExp; reason: string }> = [];

type SftpOptions = {
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
type BackgroundCommandState = {
  runId: string;
  status: "running" | "completed" | "failed";
  serverName: string;
  command: string;
  startedAt: string;
  finishedAt?: string;
  logPath: string;
  error?: string;
};
type BackgroundCommandStartOptions = {
  timeout?: number;
  maxRetries?: number;
  maxOutputBytes?: number;
  reuseConnection?: boolean;
  vvv?: boolean;
};
type ExecuteCommandWithProgressOptions = BackgroundCommandStartOptions & {
  onProgress?: (chunk: string) => void;
};
type BackgroundCommandStatus = BackgroundCommandState & {
  incremental: boolean;
  outputTail?: string;
  outputChunk?: string;
  outputUnavailable?: boolean;
  outputTruncated?: boolean;
  outputStartOffset: number;
  nextOffset: number;
  fileSize: number;
  hasMore: boolean;
  cursorReset?: boolean;
};
type CommandLogSink = {
  appendStdout(chunk: Buffer | string): void;
  appendStderr(chunk: Buffer | string): void;
};

/**
 * SSH Connection Manager class
 */
export class SSHConnectionManager {
  private static instance: SSHConnectionManager;
  private static readonly MAX_BACKGROUND_COMMANDS = 100;
  private backgroundCommands: Map<string, BackgroundCommandState> = new Map();
  private backgroundCommandOffsets: Map<string, number> = new Map();
  private outputLogRoot: string | null = null; // null = use <cwd>/.handfree-output at write time
  // Absolute directories this service created itself under os.tmpdir() to
  // hold a transfer's temporary local archive (see createLocalArchiveWorkspace).
  // validateLocalPath exempts paths inside these from the user-facing local
  // path policy: the archive path is never user input, it is generated here
  // and immediately consumed by the same upload()/download() call, so this
  // does not open any new user-reachable local path.
  private readonly internalTransferWorkspaces = new Set<string>();

  private readonly pool: SshConnectionPool = new SshConnectionPool();

  private constructor() {}

  /**
   * Get singleton instance
   */
  public static getInstance(): SSHConnectionManager {
    if (!SSHConnectionManager.instance) {
      SSHConnectionManager.instance = new SSHConnectionManager();
    }
    return SSHConnectionManager.instance;
  }

  // ---------------------------------------------------------------------
  // Connection-pool facade (PLAN.MD P0-04): SshConnectionPool
  // (src/connection/ssh-connection-pool.ts) now owns the SSH client cache,
  // server config storage/resolution, connect/reconnect/close lifecycle, and
  // jump-host tunneling. These are thin, behavior-preserving delegates so
  // every existing internal call site in this file (and every external
  // caller: tools, tests) keeps working unchanged. This is a
  // characterization/refactor step per §7.1 -- no logic below is new, it is
  // 1:1 delegation to the extracted pool.
  // ---------------------------------------------------------------------

  private get clients(): Map<string, Client> {
    return this.pool.clients;
  }
  private get configs(): SshConnectionConfigMap {
    return this.pool.configs;
  }
  private set configs(value: SshConnectionConfigMap) {
    this.pool.configs = value;
  }
  private get connected(): Map<string, boolean> {
    return this.pool.connected;
  }
  private get statusCache(): Map<string, ServerStatus> {
    return this.pool.statusCache;
  }
  private get connectionGenerations(): Map<string, number> {
    return this.pool.connectionGenerations;
  }
  private get pendingClients(): Map<string, Client> {
    return this.pool.pendingClients;
  }
  private get connecting(): Map<string, Promise<void>> {
    return this.pool.connecting;
  }
  private get jumpClients(): Map<string, Client[]> {
    return this.pool.jumpClients;
  }
  private get defaultName(): string {
    return this.pool.defaultName;
  }
  private set defaultName(value: string) {
    this.pool.defaultName = value;
  }
  private get enabledServers(): string[] | null {
    return this.pool.enabledServers;
  }
  private set enabledServers(value: string[] | null) {
    this.pool.enabledServers = value;
  }

  /**
   * Batch set SSH configurations
   * @param configs - Server configurations
   * @param enabledServers - List of enabled server names (null = all enabled)
   */
  public setConfig(configs: SshConnectionConfigMap, enabledServers?: string[]): void {
    this.pool.setConfig(configs, enabledServers);
  }

  /**
   * Replace the full config map during hot-reload. Connections whose host,
   * port, username, authentication, or proxy settings changed are closed so
   * the next tool call reconnects with the fresh OpenSSH/YAML values.
   */
  public replaceConfig(configs: SshConnectionConfigMap, enabledServers?: string[]): void {
    this.pool.replaceConfig(configs, enabledServers);
  }

  public closeConnection(name?: string): { requested: string; closed: string[] } {
    return this.pool.closeConnection(name);
  }

  private closeClient(name: string, bumpGeneration = false): void {
    this.pool.closeClient(name, bumpGeneration);
  }

  private closeClientIfCurrent(name: string, client: Client, bumpGeneration = false): void {
    this.pool.closeClientIfCurrent(name, client, bumpGeneration);
  }

  /**
   * Check if a server is enabled for use
   */
  private isServerEnabled(name: string): boolean {
    return this.pool.isServerEnabled(name);
  }

  /**
   * Returns true when more than one server is enabled,
   * meaning callers MUST specify connectionName explicitly.
   */
  public isMultiServer(): boolean {
    return this.pool.isMultiServer();
  }

  /**
   * Resolve the target server name.
   * When multiple servers are enabled, connectionName is mandatory.
   */
  public resolveServer(connectionName?: string): string {
    return this.pool.resolveServer(connectionName);
  }

  /**
   * Get specified connection configuration
   * Throws error if server is not enabled
   */
  public getConfig(name?: string): SSHConfig {
    return this.pool.getConfig(name);
  }

  /**
   * Get server config without throwing (returns null if not found/enabled)
   * Useful for tools that want to inspect config without failing
   */
  public getServerConfig(name?: string): SSHConfig | null {
    return this.pool.getServerConfig(name);
  }

  /**
   * Batch connect all configured SSH connections
   */
  public async connectAll(): Promise<void> {
    return this.pool.connectAll();
  }

  /**
   * Connect to SSH with specified name.
   *
   * Concurrent callers for the same server share a single in-flight promise,
   * so we never create two SSH clients and leak the loser.
   */
  public async connect(name?: string, timeout?: number): Promise<void> {
    return this.pool.connect(name, timeout);
  }

  private async acquireSshClient(
    key: string,
    options: SshAcquireOptions = {},
  ): Promise<AcquiredSshClient> {
    return this.pool.acquireSshClient(key, options);
  }

  private withConnectionTimeout<T>(
    operation: Promise<T>,
    timeoutMs: number | undefined,
    description: string,
    debug?: SshDebugSink,
    onTimeout?: () => void,
    onLateResolve?: (value: T) => void,
  ): Promise<T> {
    return this.pool.withConnectionTimeout(operation, timeoutMs, description, debug, onTimeout, onLateResolve);
  }

  private normalizeConnectTimeout(timeout?: number): number | undefined {
    return this.pool.normalizeConnectTimeout(timeout);
  }

  /**
   * Resolve the short exec-channel-open timeout (ms) for a server. Kept separate
   * from the command run timeout so a dead reused connection fails fast on open.
   */
  private resolveChannelOpenTimeout(config: SSHConfig): number {
    return this.pool.resolveChannelOpenTimeout(config);
  }

  // resolveKeepalive/resolveCircuitOpenTimeout have no STAYS-side caller in
  // this file (verified: only used internally by SshConnectionPool's own
  // doConnect/connectOneShotClient/connectJumpClient), but existing
  // whitebox tests (keepalive-channel-open.test.ts) reach into these via
  // `(manager as any)` -- kept reachable here so that reflection-based
  // characterization keeps working unchanged after the extraction.
  private resolveKeepalive(config: SSHConfig): { keepaliveInterval?: number; keepaliveCountMax?: number } {
    return this.pool.resolveKeepalive(config);
  }

  private resolveCircuitOpenTimeout(config: SSHConfig, connectTimeout?: number): number {
    return this.pool.resolveCircuitOpenTimeout(config, connectTimeout);
  }

  /**
   * Get SSH Client with specified name
   */
  public getClient(name?: string): Client {
    return this.pool.getClient(name);
  }

  /**
   * Ensure SSH client is connected
   * @private
   */
  private async ensureConnected(name?: string, timeout?: number): Promise<Client> {
    return this.pool.ensureConnected(name, timeout);
  }

  /**
   * Check if an error is a connection-related error that can be retried
   * @private
   */
  private isConnectionError(error: Error): boolean {
    return this.pool.isConnectionError(error);
  }

  private canRetryCommandConnectionError(error: Error): boolean {
    return this.pool.canRetryCommandConnectionError(error);
  }

  private isConnectionShapedMessage(message: string): boolean {
    return this.pool.isConnectionShapedMessage(message);
  }

  /**
   * Force reconnect to SSH server
   * @private
   */
  private async reconnect(name?: string): Promise<void> {
    return this.pool.reconnect(name);
  }

  /**
   * Disconnect SSH connection
   */
  public disconnect(): void {
    this.pool.disconnect();
  }




  /**
   * Set the root directory under which execute-command full-output logs are
   * persisted. If null/unset, defaults to <cwd>/.handfree-output resolved at
   * each write. Per-call logs land under <root>/<server>/<user>/<file>.log.
   */
  public setOutputLogRoot(rootDir: string | null | undefined): void {
    this.outputLogRoot = rootDir && rootDir.length > 0 ? rootDir : null;
  }

  /**
   * Resolve the configured output log root, applying the default
   * (<cwd>/.handfree-output) when nothing was explicitly set.
   */
  public getOutputLogRoot(): string {
    return this.outputLogRoot ?? path.join(process.cwd(), ".handfree-output");
  }























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

  /**
   * Resolve the inactivity window for a data transfer: the caller's timeout if
   * valid, otherwise the generous default so a dead connection never hangs.
   */
  private transferStallTimeout(timeout?: number): number {
    return (
      this.normalizeConnectTimeout(timeout) ??
      SSHConnectionManager.DEFAULT_TRANSFER_STALL_TIMEOUT_MS
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
    const concurrency = requested.concurrency ?? SSHConnectionManager.DEFAULT_RELAY_SFTP_CONCURRENCY;
    const chunkSize = requested.chunkSize ?? SSHConnectionManager.DEFAULT_RELAY_SFTP_CHUNK_BYTES;
    const prefetchBytes = concurrency * chunkSize;

    if (!Number.isSafeInteger(prefetchBytes) || prefetchBytes > SSHConnectionManager.MAX_RELAY_PREFETCH_BYTES) {
      throw new ToolError(
        "INVALID_CONFIGURATION",
        `relay prefetch window is too large (${concurrency} x ${chunkSize} bytes; max ${SSHConnectionManager.MAX_RELAY_PREFETCH_BYTES} bytes)`,
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
    const connectionFailure = this.isConnectionShapedMessage(error.message);
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
    const concurrency = requested ?? SSHConnectionManager.DEFAULT_RECURSIVE_FILE_CONCURRENCY;
    if (concurrency > SSHConnectionManager.MAX_RECURSIVE_FILE_CONCURRENCY) {
      throw new ToolError(
        "INVALID_CONFIGURATION",
        `fileConcurrency must not exceed ${SSHConnectionManager.MAX_RECURSIVE_FILE_CONCURRENCY}`,
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
   * Sleep helper for retry backoff
   * @private
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * SECURITY: Patterns that indicate command chaining (used to detect hidden rm)
   */
  private static readonly COMMAND_CHAIN_PATTERNS = [
    /;/,           // Command separator: cmd1; cmd2
    /&&/,          // AND operator: cmd1 && cmd2
    /\|\|/,        // OR operator: cmd1 || cmd2
    /\|/,          // Pipe: cmd1 | cmd2
    /\$\(/,        // Command substitution: $(cmd)
    /`/,           // Backtick substitution: `cmd`
  ];

  /**
   * SECURITY: Safe directory for destructive operations (rm, mv, etc.)
   */
  // Default safe directory fallback (used only if username missing for some reason)
  private static readonly DEFAULT_SAFE_DIRECTORY = "/home";

  /**
   * SECURITY: Find the first destructive pattern match and return a reason
   * Returns null when no destructive pattern is found
   * @private
   */
  private getDestructiveMatch(command: string): string | null {
    // This catches: "cd /; rm -rf *", "echo test && rm file", "$(rm file)", and risky writes like "> /etc/..."
    for (const { regex, reason } of BUILT_IN_DESTRUCTIVE_GUARDS) {
      if (regex.test(command)) {
        return reason;
      }
    }
    return null;
  }

  /**
   * SECURITY: Validate that a path is within the safe directory
   * Handles path traversal attacks like ../../etc/passwd
   * @private
   */
  private isPathInSafeDirectory(filePath: string, safeDir: string): boolean {
    // Normalize: remove redundant slashes, handle . and ..
    const parts = filePath.split('/').filter(p => p !== '' && p !== '.');
    const normalized: string[] = [];

    for (const part of parts) {
      if (part === '..') {
        normalized.pop(); // Go up one directory
      } else {
        normalized.push(part);
      }
    }

    const normalizedPath = '/' + normalized.join('/');

    // After normalization, must be inside safe directory with a `/` boundary
    // so `/home/alice-evil` is rejected when safeDir is `/home/alice`.
    if (safeDir === "/") return true;
    return normalizedPath === safeDir || normalizedPath.startsWith(safeDir + "/");
  }

  /**
   * SECURITY: Validate rm command specifically
   * Only allow rm on files/dirs inside the safe directory
   * @private
   */
  private validateRmCommand(command: string, safeDir: string): { valid: boolean; reason?: string } {
    // Check for command chaining - rm must be a standalone command, not hidden in a chain
    for (const pattern of SSHConnectionManager.COMMAND_CHAIN_PATTERNS) {
      if (pattern.test(command)) {
        return { 
          valid: false, 
          reason: `rm command cannot be chained with other commands. Found: ${pattern.toString()}` 
        };
      }
    }
    
    // Extract the rm command and its arguments
    const rmMatch = command.match(/^rm\s+(.+)$/);
    if (!rmMatch) {
      return { valid: false, reason: "Invalid rm command format" };
    }
    
    const argsString = rmMatch[1];
    
    // Parse arguments - split by space but handle quoted strings
    // For simplicity, we'll split by space and filter out flags
    const parts = argsString.split(/\s+/);
    const paths: string[] = [];
    
    for (const part of parts) {
      // Skip flags like -f, -r, -rf, --force, etc.
      if (part.startsWith('-')) {
        continue;
      }
      paths.push(part);
    }
    
    if (paths.length === 0) {
      return { valid: false, reason: "No paths specified for rm" };
    }
    
    // Validate each path
    for (const p of paths) {
      // Must be absolute path
      if (!p.startsWith('/')) {
        return { valid: false, reason: `rm path must be absolute: ${p}` };
      }
      
      // Must be inside safe directory
      if (!this.isPathInSafeDirectory(p, safeDir)) {
        return { 
          valid: false, 
          reason: `rm blocked: path "${p}" is outside safe directory "${safeDir}"` 
        };
      }
    }
    
    return { valid: true };
  }

  /**
   * SECURITY: Main command validation with multiple layers of defense
   * @private
   */
  private validateCommand(
    command: string,
    name?: string
  ): { isAllowed: boolean; reason?: string } {
    
    // ========================================
    // LAYER 1: Check for hidden destructive commands in chains
    // Block things like: "cd /; rm -rf *", "echo | rm file", "$(rm file)"
    // ========================================
    const config = this.getConfig(name);
    const safeDir = config.safeDirectory
      || (config.username
          ? (config.username === 'root' ? '/root' : `/home/${config.username}`)
          : SSHConnectionManager.DEFAULT_SAFE_DIRECTORY);
    const destructiveReason = config.disableBuiltinGuards
      ? null
      : this.getDestructiveMatch(command);
    if (destructiveReason) {
      // Command contains rm/rmdir - check if it's a simple rm command or hidden in a chain
      const trimmed = command.trim();

      // If it starts with rm, validate it properly but continue through whitelist/blacklist policy checks
      if (trimmed.startsWith('rm ') || trimmed === 'rm') {
        const rmValidation = this.validateRmCommand(trimmed, safeDir);
        if (!rmValidation.valid) {
          Logger.log(`SECURITY: rm command blocked: ${rmValidation.reason}`, "error");
          return {
            isAllowed: false,
            reason: rmValidation.reason,
          };
        }
        Logger.log(`SECURITY: rm command passed safe directory validation (${safeDir}): ${command}`, "info");
      } else {
        // Destructive pattern detected somewhere in the command (chained, subshell, redirection, etc.)
        Logger.log(`SECURITY: Destructive pattern detected (${destructiveReason}): ${command}`, "error");
        return {
          isAllowed: false,
          reason: `Blocked destructive pattern: ${destructiveReason}. Command: "${command}"`,
        };
      }
    }
    
    // ========================================
    // LAYER 2: Built-in blacklist for high-risk operations
    // ========================================
    if (!config.disableBuiltinBlacklist) {
      for (const { regex, reason } of BUILT_IN_COMMAND_BLACKLIST) {
        if (regex.test(command)) {
          Logger.log(`Command blocked by built-in blacklist (${reason}): ${command}`, "info");
          return {
            isAllowed: false,
            reason: `Command blocked by built-in blacklist: ${reason}`,
          };
        }
      }
    }

    // ========================================
    // LAYER 3: User blacklist check
    // ========================================
    if (config.commandBlacklist && config.commandBlacklist.length > 0) {
      const matchesBlacklist = config.commandBlacklist.some((pattern) => {
        try {
          const regex = new RegExp(pattern);
          return regex.test(command);
        } catch (e) {
          Logger.log(`Invalid blacklist regex pattern: ${pattern}`, "error");
          return false;
        }
      });
      if (matchesBlacklist) {
        Logger.log(`Command blocked by blacklist: ${command}`, "info");
        return {
          isAllowed: false,
          reason: "Command matches blacklist, execution forbidden",
        };
      }
    }

    // ========================================
    // LAYER 4: Optional whitelist mode
    // ========================================
    const commandMode = config.commandMode
      ?? ((config.commandWhitelist && config.commandWhitelist.length > 0) ? "whitelist" : "blacklist");
    if (commandMode === "whitelist") {
      const whitelist = config.commandWhitelist ?? [];
      const matchesWhitelist = whitelist.some((pattern) => {
        try {
          const regex = new RegExp(pattern);
          return regex.test(command);
        } catch (e) {
          Logger.log(`Invalid whitelist regex pattern: ${pattern}`, "error");
          return false;
        }
      });

      if (!matchesWhitelist) {
        Logger.log(`Command blocked by whitelist: ${command}`, "info");
        return {
          isAllowed: false,
          reason: `Command not in whitelist, execution forbidden. Command: "${command}"`,
        };
      }
    }

    // Validation passed
    return {
      isAllowed: true,
    };
  }

  /**
   * Low-level streaming runner shared by both the buffered (`executeCommand`)
   * and progress (`executeCommandWithProgress`) paths.
   *
   * Streams raw stdout/stderr bytes into:
   *   - `stdoutCollector` / `stderrCollector` (tail-only, for the returned text)
   *   - `logWriter` (full output persisted to disk)
   *   - `onProgress` (live forwarding, never truncated)
   *
   * Resolves with the exit code (null if the remote process was signaled).
   * @private
   */
  private async runCommandStream(
    cmdString: string,
    client: Client,
    timeout: number,
    sinks: {
      stdoutCollector?: OutputCollector;
      stderrCollector?: OutputCollector;
      logWriter?: CommandLogSink;
      onProgress?: (chunk: string) => void;
      debug?: SshDebugSink;
      // Short timeout (ms) for the exec-channel-OPEN phase only. Falls back to
      // the command timeout when unset. A dead reused connection can accept but
      // never open a channel; this bounds that hang so the caller can drop the
      // stale client and retry with a fresh one instead of waiting the full
      // command timeout.
      channelOpenTimeout?: number;
    }
  ): Promise<number | null> {
    return new Promise<number | null>((resolve, reject) => {
      let timeoutId: NodeJS.Timeout | null = null;
      let settled = false;
      let channelOpened = false;
      let activeStream: ClientChannel | null = null;
      const eventedClient = client as Client & {
        once?: (event: string, listener: (...args: any[]) => void) => unknown;
        removeListener?: (event: string, listener: (...args: any[]) => void) => unknown;
      };
      const canObserveClientLifecycle =
        typeof eventedClient.once === "function" &&
        typeof eventedClient.removeListener === "function";

      const clearCommandTimer = () => {
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }
      };

      const removeClientLifecycleListeners = () => {
        if (!canObserveClientLifecycle) {
          return;
        }
        eventedClient.removeListener?.("error", onClientError);
        eventedClient.removeListener?.("end", onClientEnd);
        eventedClient.removeListener?.("close", onClientClose);
      };

      const cleanup = () => {
        clearCommandTimer();
        removeClientLifecycleListeners();
      };

      const settle = (err: Error | null, code?: number | null) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (err) reject(err);
        else resolve(code ?? null);
      };

      const closeLateStream = (stream: ClientChannel) => {
        try {
          stream.close();
        } catch {
          // Ignore late-stream close errors after the promise has settled.
        }
      };

      const failOnClientEvent = (event: string, message?: string) => {
        const phase = channelOpened ? "running command" : "opening command channel";
        const detail = message ? `: ${message}` : "";
        sinks.debug?.(`[mcp] SSH client ${event} while ${phase}${detail}`);
        settle(new ToolError(
          "SSH_CONNECTION_FAILED",
          `SSH connection ${event} while ${phase}${detail}`,
          true,
        ));
        if (activeStream) {
          closeLateStream(activeStream);
        }
      };

      const onClientError = (err: Error) => {
        failOnClientEvent("failed", err.message);
      };

      const onClientEnd = () => {
        failOnClientEvent("ended");
      };

      const onClientClose = () => {
        failOnClientEvent("closed");
      };

      const armExecOpenTimeout = () => {
        // Bound the channel-OPEN phase by the short channel-open timeout (not the
        // full command timeout): a reused-but-dead connection can accept yet never
        // open a channel, and waiting the whole command timeout is the 300s hang.
        const execOpenTimeout = Math.max(
          1,
          sinks.channelOpenTimeout && sinks.channelOpenTimeout > 0
            ? Math.min(sinks.channelOpenTimeout, timeout)
            : timeout,
        );
        timeoutId = setTimeout(() => {
          sinks.debug?.(`[mcp] exec channel open timed out after ${execOpenTimeout}ms`);
          settle(new ToolError(
            "SSH_CONNECTION_FAILED",
            `SSH exec channel timeout: no response from server within ${execOpenTimeout}ms while opening command channel`,
            true,
          ));
        }, execOpenTimeout);
      };

      const armCommandTimeout = (stream: ClientChannel) => {
        timeoutId = setTimeout(() => {
          sinks.debug?.(`[mcp] remote command timed out after ${timeout}ms; closing command channel`);
          settle(new ToolError(
            "COMMAND_TIMEOUT",
            `Command timeout: execution exceeded ${timeout}ms limit. Remote process killed.`,
            false,
          ));
          try {
            stream.signal("KILL");
          } catch {
            // Ignore errors when sending signal.
          }
          try {
            stream.close();
          } catch {
            // Ignore errors when closing streams during timeout.
          }
        }, timeout);
      };

      armExecOpenTimeout();
      if (canObserveClientLifecycle) {
        eventedClient.once?.("error", onClientError);
        eventedClient.once?.("end", onClientEnd);
        eventedClient.once?.("close", onClientClose);
      }
      sinks.debug?.(`[mcp] opening exec channel for command: ${cmdString}`);

      try {
        client.exec(cmdString, (err: Error | undefined, stream: ClientChannel) => {
          if (settled) {
            if (stream) closeLateStream(stream);
            return;
          }

          if (err) {
            const isConnectionFailure = this.isConnectionShapedMessage(err.message);
            const code = isConnectionFailure ? "SSH_CONNECTION_FAILED" : "COMMAND_EXECUTION_ERROR";
            sinks.debug?.(`[mcp] exec callback failed: ${err.message}`);
            settle(new ToolError(code, `Command execution error: ${err.message}`, isConnectionFailure));
            return;
          }

          clearCommandTimer();
          channelOpened = true;
          activeStream = stream;
          sinks.debug?.("[mcp] exec channel opened");

          stream.on("data", (chunk: Buffer) => {
            sinks.stdoutCollector?.push(chunk);
            sinks.logWriter?.appendStdout(chunk);
            if (sinks.onProgress) sinks.onProgress(chunk.toString());
          });

          stream.stderr.on("data", (chunk: Buffer) => {
            sinks.stderrCollector?.push(chunk);
            sinks.logWriter?.appendStderr(chunk);
            if (sinks.onProgress) sinks.onProgress(`[STDERR] ${chunk.toString()}`);
          });

          stream.on("close", (code: number) => {
            sinks.debug?.(`[mcp] exec channel closed with code ${code ?? "null"}`);
            settle(null, code ?? null);
          });

          stream.on("error", (err: Error) => {
            const isConnectionFailure = this.isConnectionShapedMessage(err.message);
            const code = isConnectionFailure ? "SSH_CONNECTION_FAILED" : "COMMAND_EXECUTION_ERROR";
            sinks.debug?.(`[mcp] exec stream error: ${err.message}`);
            settle(new ToolError(code, `Stream error: ${err.message}`, isConnectionFailure));
          });

          armCommandTimeout(stream);
        });
      } catch (err) {
        const error = err as Error;
        const isConnectionFailure = this.isConnectionShapedMessage(error.message);
        const code = isConnectionFailure ? "SSH_CONNECTION_FAILED" : "COMMAND_EXECUTION_ERROR";
        sinks.debug?.(`[mcp] client.exec threw before callback: ${error.message}`);
        settle(new ToolError(code, `Command execution error: ${error.message}`, isConnectionFailure));
      }
    });
  }

  /**
   * Default cap on bytes returned to the caller from `execute-command`.
   * Combined stdout + stderr; tail-only truncation past this limit. The
   * full output is always persisted to disk regardless of this cap.
   */
  public static readonly DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
  private static readonly DEFAULT_DEBUG_BYTES = 64 * 1024;

  private createDebugCollector(enabled: boolean): {
    collector: OutputCollector | null;
    debug?: SshDebugSink;
  } {
    if (!enabled) {
      return { collector: null };
    }

    const collector = new OutputCollector(SSHConnectionManager.DEFAULT_DEBUG_BYTES);
    return {
      collector,
      debug: (line: string) => {
        collector.push(`${line}\n`);
      },
    };
  }

  private appendDebugOutput(result: string, collector: OutputCollector | null): string {
    const debugBlock = this.formatDebugBlock(collector);
    if (!debugBlock) {
      return result;
    }

    return `${result}\n\n${debugBlock}`;
  }

  private appendDebugToError(error: Error, collector: OutputCollector | null): Error {
    const debugBlock = this.formatDebugBlock(collector);
    if (!debugBlock) {
      return error;
    }

    const message = `${error.message}\n\n${debugBlock}`;

    if (error instanceof ToolError) {
      return new ToolError(error.code, message, error.retriable);
    }

    const wrapped = new Error(message);
    wrapped.name = error.name;
    return wrapped;
  }

  private formatDebugBlock(collector: OutputCollector | null): string | null {
    if (!collector || collector.getTotalBytes() === 0) {
      return null;
    }

    const snapshot = collector.getSnapshot();
    const header = snapshot.truncated
      ? `[SSH DEBUG TRUNCATED: dropped ${snapshot.droppedBytes} bytes]\n`
      : "[SSH DEBUG]\n";
    return `${header}${snapshot.tail.toString("utf8").trimEnd()}`;
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
   * Assemble the final user-visible result string from collected tails.
   * Adds a truncation header (with the on-disk log path) and the legacy
   * [STDERR]/[EXIT CODE] markers so the LLM still sees the same shape.
   */
  private buildExecuteResult(args: {
    stdoutCollector: OutputCollector;
    stderrCollector: OutputCollector;
    exitCode: number | null;
    logWriter: OutputLogWriter | null;
    maxOutputBytes: number;
  }): string {
    const { stdoutCollector, stderrCollector, exitCode, logWriter, maxOutputBytes } = args;

    const stdoutSnap = stdoutCollector.getSnapshot();
    const stderrSnap = stderrCollector.getSnapshot();
    const totalBytes = stdoutSnap.totalBytes + stderrSnap.totalBytes;
    const totalDropped = stdoutSnap.droppedBytes + stderrSnap.droppedBytes;
    const truncated = stdoutSnap.truncated || stderrSnap.truncated;

    const stdoutText = stdoutSnap.tail.toString("utf8");
    const stderrText = stderrSnap.tail.toString("utf8");

    let body = "";
    if (stdoutText.trim()) {
      body += stdoutText;
    }
    if (stderrText.trim()) {
      if (body) body += "\n";
      body += `[STDERR]\n${stderrText}`;
    }
    if (exitCode !== 0 && exitCode !== null) {
      if (body) body += "\n";
      body += `[EXIT CODE: ${exitCode}]`;
    }
    if (!body.trim()) {
      body = exitCode === 0
        ? "(Command completed successfully with no output)"
        : `(Command exited with code ${exitCode} and no output)`;
    }

    if (truncated) {
      const logPathLine = logWriter
        ? `Full output saved to: ${logWriter.getPath()}\n`
        : "Full output log was not available (disk write failed).\n";
      const header =
        `[OUTPUT TRUNCATED]\n` +
        `Total bytes: ${totalBytes} (stdout=${stdoutSnap.totalBytes}, stderr=${stderrSnap.totalBytes})\n` +
        `Bytes dropped from head: ${totalDropped}\n` +
        `Showing last <= ${maxOutputBytes} bytes per stream.\n` +
        logPathLine +
        `---\n`;
      return header + body;
    }
    return body;
  }

  /**
   * Execute SSH command with auto-retry on connection errors
   * 
   * Features:
   * - Validates command against command policy before execution
   * - Auto-reconnects and retries on connection failures
   * - Exponential backoff between retries (500ms, 1000ms, 2000ms)
   * - Configurable timeout per command
   */
  public async executeCommand(
    cmdString: string,
    name?: string,
    options: {
      timeout?: number;
      maxRetries?: number;
      maxOutputBytes?: number;
      reuseConnection?: boolean;
      vvv?: boolean;
    } = {}
  ): Promise<string> {
    // Validate command input and security
    const validationResult = this.validateCommand(cmdString, name);
    if (!validationResult.isAllowed) {
      throw new ToolError(
        "COMMAND_VALIDATION_FAILED",
        `Command validation failed: ${validationResult.reason}`,
        false,
      );
    }

    const timeout = options.timeout || 30000; // Default 30 seconds timeout
    const maxRetries = options.maxRetries ?? 2; // Default 2 retries
    const maxOutputBytes = options.maxOutputBytes ?? SSHConnectionManager.DEFAULT_MAX_OUTPUT_BYTES;
    const reuseConnection = options.reuseConnection !== false;
    const key = name || this.defaultName;
    const { collector: debugCollector, debug } = this.createDebugCollector(options.vvv === true);

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      let acquiredClient: Client | null = null;
      try {
        debug?.(`[mcp] command attempt ${attempt + 1}/${maxRetries + 1} on [${key}], reuseConnection=${reuseConnection}`);
        const commandConnection = await this.acquireSshClient(key, {
          reuseConnection,
          timeout,
          debug,
          purpose: "command",
        });
        const client = commandConnection.client;
        acquiredClient = client;

        // Per-attempt collectors + log writer. We rebuild them on each retry
        // so partial output from a failed attempt is not mixed into the next.
        const stdoutCollector = new OutputCollector(maxOutputBytes);
        const stderrCollector = new OutputCollector(maxOutputBytes);
        const logWriter = this.createLogWriter(key, cmdString);
        const startedMs = Date.now();
        let exitCode: number | null = null;
        try {
          exitCode = await this.runCommandStream(cmdString, client, timeout, {
            stdoutCollector,
            stderrCollector,
            logWriter: logWriter ?? undefined,
            debug,
            channelOpenTimeout: this.resolveChannelOpenTimeout(this.getConfig(key)),
          });
        } finally {
          logWriter?.close({ exitCode, durationMs: Date.now() - startedMs });
          commandConnection.close();
        }
        const result = this.buildExecuteResult({
          stdoutCollector,
          stderrCollector,
          exitCode,
          logWriter,
          maxOutputBytes,
        });

        // Success - log if this was a retry
        if (attempt > 0) {
          Logger.log(`Command succeeded on retry attempt ${attempt} for [${key}]`, "info");
        }

        return this.appendDebugOutput(result, debugCollector);
      } catch (error) {
        lastError = error as Error;
        const connectionError = this.isConnectionError(lastError);
        
        // Check if this is a connection error that can be retried
        if (connectionError && this.canRetryCommandConnectionError(lastError) && attempt < maxRetries) {
          const backoffMs = 500 * Math.pow(2, attempt); // 500ms, 1000ms, 2000ms
          Logger.log(
            `Connection error on attempt ${attempt + 1}/${maxRetries + 1} for [${key}]: ${lastError.message}. Retrying in ${backoffMs}ms...`,
            "info"
          );
          
          // Wait with exponential backoff
          await this.sleep(backoffMs);

          if (reuseConnection) {
            try {
              await this.reconnect(name);
            } catch (reconnectError) {
              Logger.log(
                `Reconnect failed for [${key}]: ${(reconnectError as Error).message}`,
                "error"
              );
            }
          }
          
          continue;
        }

        if (connectionError && reuseConnection) {
          if (acquiredClient) {
            this.closeClientIfCurrent(key, acquiredClient, true);
          }
        }
        
        // Non-retryable error or max retries reached
        break;
      }
    }
    
    // All retries exhausted
    throw this.appendDebugToError(
      lastError || new Error("Command execution failed after all retries"),
      debugCollector,
    );
  }

  /**
   * Execute SSH command with real-time streaming output via progress callback
   * 
   * Features:
   * - Validates command against command policy before execution
   * - Streams stdout/stderr chunks to the onProgress callback in real-time
   * - Auto-reconnects and retries on connection failures
   * - Longer default timeout suitable for long-running tasks
   * 
   * @param cmdString - Command to execute
   * @param name - SSH connection name (optional)
   * @param options - Execution options including timeout and progress callback
   */
  public async executeCommandWithProgress(
    cmdString: string,
    name?: string,
    options: ExecuteCommandWithProgressOptions = {}
  ): Promise<string> {
    // Validate command input and security
    const validationResult = this.validateCommand(cmdString, name);
    if (!validationResult.isAllowed) {
      throw new ToolError(
        "COMMAND_VALIDATION_FAILED",
        `Command validation failed: ${validationResult.reason}`,
        false,
      );
    }

    return this.executeCommandWithProgressValidated(cmdString, name, options);
  }

  private async executeCommandWithProgressValidated(
    cmdString: string,
    name?: string,
    options: ExecuteCommandWithProgressOptions = {},
  ): Promise<string> {
    const timeout = options.timeout || 300000; // Default 5 minutes for streaming
    const maxRetries = options.maxRetries ?? 2; // Default 2 retries
    const maxOutputBytes = options.maxOutputBytes ?? SSHConnectionManager.DEFAULT_MAX_OUTPUT_BYTES;
    const reuseConnection = options.reuseConnection !== false;
    const key = name || this.defaultName;
    const { collector: debugCollector, debug } = this.createDebugCollector(options.vvv === true);

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      let acquiredClient: Client | null = null;
      try {
        debug?.(`[mcp] streaming command attempt ${attempt + 1}/${maxRetries + 1} on [${key}], reuseConnection=${reuseConnection}`);
        const commandConnection = await this.acquireSshClient(key, {
          reuseConnection,
          timeout,
          debug,
          purpose: "command",
        });
        const client = commandConnection.client;
        acquiredClient = client;

        // Per-attempt collectors + log writer. onProgress keeps streaming
        // every byte live; only the final returned string is capped.
        const stdoutCollector = new OutputCollector(maxOutputBytes);
        const stderrCollector = new OutputCollector(maxOutputBytes);
        const logWriter = this.createLogWriter(key, cmdString);
        const startedMs = Date.now();
        let exitCode: number | null = null;
        try {
          exitCode = await this.runCommandStream(cmdString, client, timeout, {
            stdoutCollector,
            stderrCollector,
            logWriter: logWriter ?? undefined,
            onProgress: options.onProgress,
            debug,
            channelOpenTimeout: this.resolveChannelOpenTimeout(this.getConfig(key)),
          });
        } finally {
          logWriter?.close({ exitCode, durationMs: Date.now() - startedMs });
          commandConnection.close();
        }
        const result = this.buildExecuteResult({
          stdoutCollector,
          stderrCollector,
          exitCode,
          logWriter,
          maxOutputBytes,
        });

        // Success - log if this was a retry
        if (attempt > 0) {
          Logger.log(
            `Streaming command succeeded on retry attempt ${attempt} for [${key}]`,
            "info"
          );
        }

        return this.appendDebugOutput(result, debugCollector);
      } catch (error) {
        lastError = error as Error;
        const connectionError = this.isConnectionError(lastError);

        // Check if this is a connection error that can be retried
        if (connectionError && this.canRetryCommandConnectionError(lastError) && attempt < maxRetries) {
          const backoffMs = 500 * Math.pow(2, attempt);
          Logger.log(
            `Connection error on streaming attempt ${attempt + 1}/${maxRetries + 1} for [${key}]: ${lastError.message}. Retrying in ${backoffMs}ms...`,
            "info"
          );

          await this.sleep(backoffMs);

          if (reuseConnection) {
            try {
              await this.reconnect(name);
            } catch (reconnectError) {
              Logger.log(
                `Reconnect failed for [${key}]: ${(reconnectError as Error).message}`,
                "error"
              );
            }
          }

          continue;
        }

        if (connectionError && reuseConnection) {
          if (acquiredClient) {
            this.closeClientIfCurrent(key, acquiredClient, true);
          }
        }

        break;
      }
    }

    throw this.appendDebugToError(
      lastError || new Error("Streaming command execution failed after all retries"),
      debugCollector,
    );
  }

  public startCommandBackground(
    cmdString: string,
    name?: string,
    options: BackgroundCommandStartOptions = {},
  ): BackgroundCommandState {
    const validationResult = this.validateCommand(cmdString, name);
    if (!validationResult.isAllowed) {
      throw new ToolError(
        "COMMAND_VALIDATION_FAILED",
        `Command validation failed: ${validationResult.reason}`,
        false,
      );
    }

    const key = name || this.defaultName;
    const config = this.getConfig(key);
    this.pruneBackgroundCommands();
    if (this.countRunningBackgroundCommands() >= SSHConnectionManager.MAX_BACKGROUND_COMMANDS) {
      throw new ToolError(
        "COMMAND_EXECUTION_ERROR",
        `Too many background commands are still running (limit ${SSHConnectionManager.MAX_BACKGROUND_COMMANDS})`,
        false,
      );
    }

    const startedAt = new Date();
    const runId = this.createBackgroundRunId(startedAt);
    const writer = new BackgroundCommandLogWriter({
      rootDir: this.getOutputLogRoot(),
      serverName: key,
      username: config.username,
      command: cmdString,
      runId,
      startedAt,
    });
    const state: BackgroundCommandState = {
      runId,
      status: "running",
      serverName: key,
      command: cmdString,
      startedAt: startedAt.toISOString(),
      logPath: writer.getPath(),
    };

    this.backgroundCommands.set(runId, state);
    this.backgroundCommandOffsets.set(runId, 0);

    void this.runBackgroundCommand(runId, cmdString, key, options, writer, startedAt);
    return { ...state };
  }

  public getBackgroundCommandStatus(
    runId: string,
    maxOutputBytes = SSHConnectionManager.DEFAULT_MAX_OUTPUT_BYTES,
    offset?: number,
    incremental = true,
  ): BackgroundCommandStatus {
    const state = this.backgroundCommands.get(runId);
    if (!state) {
      throw new ToolError(
        "BACKGROUND_COMMAND_NOT_FOUND",
        `Background command runId '${runId}' was not found in this MCP server process`,
        false,
      );
    }
    const useIncremental = incremental !== false;
    const storedOffset = this.backgroundCommandOffsets.get(runId) ?? 0;
    const effectiveOffset = useIncremental
      ? offset ?? storedOffset
      : undefined;
    const output = this.readBackgroundOutput(state.logPath, maxOutputBytes, effectiveOffset);
    const committedOffset = output.readSucceeded ? output.nextOffset : storedOffset;
    if (output.readSucceeded) {
      this.backgroundCommandOffsets.set(runId, committedOffset);
    }
    const status: BackgroundCommandStatus = {
      ...state,
      incremental: useIncremental,
      outputTruncated: output.truncated,
      outputStartOffset: output.readSucceeded ? output.startOffset : storedOffset,
      nextOffset: committedOffset,
      fileSize: output.fileSize,
      hasMore: output.hasMore,
    };
    if (!output.readSucceeded) {
      status.outputUnavailable = true;
    }
    if (output.cursorReset) {
      status.cursorReset = true;
    }
    if (useIncremental) {
      status.outputChunk = output.text;
    } else {
      status.outputTail = output.text;
    }
    return status;
  }

  private async runBackgroundCommand(
    runId: string,
    cmdString: string,
    key: string,
    options: BackgroundCommandStartOptions,
    writer: BackgroundCommandLogWriter,
    startedAt: Date,
  ): Promise<void> {
    const timeoutMs = this.resolveBackgroundCommandTimeout(options.timeout);
    writer.appendLine(`[mcp] background command started: ${runId}`);
    try {
      await this.executeBackgroundCommandValidated(cmdString, key, options, writer, timeoutMs);

      const finishedAt = new Date();
      writer.close({
        status: "completed",
        durationMs: finishedAt.getTime() - startedAt.getTime(),
        finishedAt,
      });
      this.updateBackgroundCommand(runId, {
        status: "completed",
        finishedAt: finishedAt.toISOString(),
      });
    } catch (error) {
      const err = error as Error;
      const finishedAt = new Date();
      const message = err.message || String(err);
      const errorText = err instanceof ToolError ? `${err.code}: ${message}` : message;
      writer.appendLine(`\n[ERROR] ${errorText}`);
      writer.close({
        status: "failed",
        durationMs: finishedAt.getTime() - startedAt.getTime(),
        finishedAt,
        error: errorText,
      });
      this.updateBackgroundCommand(runId, {
        status: "failed",
        finishedAt: finishedAt.toISOString(),
        error: errorText,
      });
      Logger.log(`Background command ${runId} failed on [${key}]: ${errorText}`, "error");
    }
  }

  private async executeBackgroundCommandValidated(
    cmdString: string,
    key: string,
    options: BackgroundCommandStartOptions,
    writer: CommandLogSink,
    timeoutMs: number,
  ): Promise<void> {
    const maxRetries = options.maxRetries ?? 2;
    const reuseConnection = options.reuseConnection !== false;
    const { collector: debugCollector, debug } = this.createDebugCollector(options.vvv === true);
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      let commandConnection: AcquiredSshClient | null = null;
      let closeCommandConnection: (() => void) | null = null;
      let acquiredClient: Client | null = null;
      let timedOut = false;
      try {
        debug?.(`[mcp] background command attempt ${attempt + 1}/${maxRetries + 1} on [${key}], reuseConnection=${reuseConnection}`);
        const runAttempt = (async () => {
          commandConnection = await this.acquireSshClient(key, {
            reuseConnection,
            timeout: timeoutMs,
            debug,
            purpose: "command",
          });
          closeCommandConnection = commandConnection.close;
          acquiredClient = commandConnection.client;
          if (timedOut) {
            closeCommandConnection();
            if (reuseConnection) {
              this.closeClientIfCurrent(key, acquiredClient, true);
            }
            return;
          }
          await this.runCommandStream(cmdString, commandConnection.client, timeoutMs, {
            logWriter: writer,
            debug,
            channelOpenTimeout: this.resolveChannelOpenTimeout(this.getConfig(key)),
          });
        })();

        await this.withBackgroundCommandTimeout(
          runAttempt,
          timeoutMs,
          () => {
            timedOut = true;
            if (closeCommandConnection) {
              closeCommandConnection();
              if (reuseConnection && acquiredClient) {
                this.closeClientIfCurrent(key, acquiredClient, true);
              }
            }
          },
        );

        if (attempt > 0) {
          Logger.log(`Background command succeeded on retry attempt ${attempt} for [${key}]`, "info");
        }
        return;
      } catch (error) {
        lastError = error as Error;
        const connectionError = this.isConnectionError(lastError);

        if (connectionError && this.canRetryCommandConnectionError(lastError) && attempt < maxRetries) {
          const backoffMs = 500 * Math.pow(2, attempt);
          Logger.log(
            `Connection error on background attempt ${attempt + 1}/${maxRetries + 1} for [${key}]: ${lastError.message}. Retrying in ${backoffMs}ms...`,
            "info",
          );
          await this.sleep(backoffMs);

          if (reuseConnection) {
            try {
              await this.reconnect(key);
            } catch (reconnectError) {
              Logger.log(
                `Reconnect failed for [${key}]: ${(reconnectError as Error).message}`,
                "error",
              );
            }
          }
          continue;
        }

        if (connectionError && reuseConnection) {
          if (acquiredClient) {
            this.closeClientIfCurrent(key, acquiredClient, true);
          }
        }
        break;
      } finally {
        const close = closeCommandConnection as (() => void) | null;
        close?.();
      }
    }

    throw this.appendDebugToError(
      lastError || new Error("Background command execution failed after all retries"),
      debugCollector,
    );
  }

  private resolveBackgroundCommandTimeout(timeout?: number): number {
    if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0) {
      return 300000;
    }
    return Math.floor(timeout);
  }

  private resolveBackgroundWatchdogTimeout(timeoutMs: number): number {
    const graceMs = Math.min(1000, Math.max(10, Math.ceil(timeoutMs * 0.1)));
    return timeoutMs + graceMs;
  }

  private withBackgroundCommandTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    onTimeout?: () => void,
  ): Promise<T> {
    const watchdogMs = this.resolveBackgroundWatchdogTimeout(timeoutMs);
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          onTimeout?.();
        } catch {
          // Ignore watchdog cleanup errors; the timeout is the primary failure.
        }
        reject(new ToolError(
          "COMMAND_TIMEOUT",
          `Background command watchdog fired after ${watchdogMs}ms (command timeout ${timeoutMs}ms)`,
          false,
        ));
      }, watchdogMs);
      timer.unref?.();

      promise.then(
        (value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  private updateBackgroundCommand(runId: string, patch: Partial<BackgroundCommandState>): void {
    const current = this.backgroundCommands.get(runId);
    if (!current) return;
    this.backgroundCommands.set(runId, { ...current, ...patch });
  }

  private createBackgroundRunId(date: Date): string {
    const ts = date.toISOString()
      .replace(/[-:.]/g, "")
      .replace(/(\d{8}T\d{6})\d*Z$/, "$1Z");
    return `cmd_${ts}_${crypto.randomBytes(4).toString("hex")}`;
  }

  private pruneBackgroundCommands(maxEntries = 100): void {
    if (this.backgroundCommands.size <= maxEntries) return;
    for (const [runId, state] of this.backgroundCommands) {
      if (this.backgroundCommands.size <= maxEntries) return;
      if (state.status !== "running") {
        this.backgroundCommands.delete(runId);
        this.backgroundCommandOffsets.delete(runId);
      }
    }
  }

  private countRunningBackgroundCommands(): number {
    let count = 0;
    for (const state of this.backgroundCommands.values()) {
      if (state.status === "running") count++;
    }
    return count;
  }

  private completeUtf8End(data: Buffer, start: number, end: number): number {
    if (end <= start || end < data.length) {
      return end;
    }

    let leadIndex = end - 1;
    while (leadIndex >= start && (data[leadIndex] & 0xc0) === 0x80) {
      leadIndex -= 1;
    }
    if (leadIndex < start) {
      return end;
    }

    const lead = data[leadIndex];
    const expectedLength = lead >= 0xc2 && lead <= 0xdf
      ? 2
      : lead >= 0xe0 && lead <= 0xef
        ? 3
        : lead >= 0xf0 && lead <= 0xf4
          ? 4
          : 1;
    return end - leadIndex < expectedLength ? leadIndex : end;
  }

  private readBackgroundOutput(
    filePath: string,
    maxBytes: number,
    offset?: number,
  ): {
    text: string;
    truncated: boolean;
    startOffset: number;
    nextOffset: number;
    fileSize: number;
    hasMore: boolean;
    cursorReset: boolean;
    readSucceeded: boolean;
  } {
    const cap = Number.isFinite(maxBytes)
      ? Math.max(0, Math.floor(maxBytes))
      : SSHConnectionManager.DEFAULT_MAX_OUTPUT_BYTES;
    const requestedOffset = typeof offset === "number" && Number.isFinite(offset)
      ? Math.max(0, Math.floor(offset))
      : undefined;
    try {
      const stat = fs.statSync(filePath);
      const fileSize = stat.size;
      const cursorReset = requestedOffset !== undefined && requestedOffset > fileSize;
      const start = requestedOffset === undefined
        ? Math.max(0, fileSize - cap)
        : cursorReset
          ? 0
          : requestedOffset;

      if (cap === 0) {
        const incrementalRead = requestedOffset !== undefined;
        return {
          text: "",
          truncated: !incrementalRead && fileSize > start,
          startOffset: start,
          nextOffset: incrementalRead ? start : fileSize,
          fileSize,
          hasMore: incrementalRead && start < fileSize,
          cursorReset,
          readSucceeded: true,
        };
      }

      const cappedEnd = Math.min(fileSize, start + cap);
      // Read up to three extra bytes so a chunk ending inside a UTF-8 code point
      // can include the complete character without losing or corrupting output.
      const readEnd = Math.min(fileSize, cappedEnd + 3);
      const length = readEnd - start;
      const fd = fs.openSync(filePath, "r");
      try {
        const buffer = Buffer.alloc(length);
        const bytesRead = fs.readSync(fd, buffer, 0, length, start);
        const data = buffer.subarray(0, bytesRead);
        const cappedLength = Math.min(cappedEnd - start, bytesRead);

        let sliceStart = 0;
        while (sliceStart < data.length && (data[sliceStart] & 0xc0) === 0x80) {
          sliceStart += 1;
        }

        let sliceEnd = cappedLength;
        while (sliceEnd < data.length && (data[sliceEnd] & 0xc0) === 0x80) {
          sliceEnd += 1;
        }
        sliceEnd = this.completeUtf8End(data, sliceStart, sliceEnd);

        const startOffset = start + sliceStart;
        const nextOffset = start + sliceEnd;
        return {
          text: data.subarray(sliceStart, sliceEnd).toString("utf8"),
          truncated: requestedOffset === undefined && startOffset > 0,
          startOffset,
          nextOffset,
          fileSize,
          hasMore: nextOffset < fileSize,
          cursorReset,
          readSucceeded: true,
        };
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      const startOffset = requestedOffset ?? 0;
      return {
        text: "",
        truncated: false,
        startOffset,
        nextOffset: startOffset,
        fileSize: 0,
        hasMore: false,
        cursorReset: false,
        readSucceeded: false,
      };
    }
  }

  /**
   * Build an OutputLogWriter for a given server. Returns null if we cannot
   * resolve the configured username (in which case the command still runs
   * but its full output is not persisted to disk).
   */
  private createLogWriter(serverName: string, command: string): OutputLogWriter | null {
    const config = this.getServerConfig(serverName);
    if (!config) return null;
    return new OutputLogWriter({
      rootDir: this.getOutputLogRoot(),
      serverName,
      username: config.username,
      command,
    });
  }

  /**
   * Validate a local filesystem path for SFTP transfer.
   *
   * The path must be inside the MCP working directory OR inside one of the
   * server's `allowedLocalDirectories` entries. The working directory is
   * always allowed implicitly for backward compatibility.
   */
  private validateLocalPath(localPath: string, name?: string): string {
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

    const config = name ? this.getServerConfig(name) : undefined;

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
  private validateRemotePath(remotePath: string, name: string): string {
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

    const config = this.getConfig(name);
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
    const resolvedName = name || this.defaultName;
    const reuseConnection = options?.reuseConnection !== false;
    const { collector: debugCollector, debug } = this.createDebugCollector(options?.vvv === true);
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

    const isShellScript = SSHConnectionManager.SHELL_SCRIPT_EXTENSIONS.has(
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
      crlfFixed = SSHConnectionManager.maybeFixShellScriptLineEndings(
        validatedLocalPath,
        payload,
      );
      payload = crlfFixed.buffer;
    }

    const crlfNote = crlfFixed.fixed
      ? ` (CRLF→LF auto-fix: converted ${crlfFixed.replacedCount} line endings to LF before upload because target is a shell script).`
      : "";

    debug?.(`[mcp] sftp upload on [${resolvedName}], reuseConnection=${reuseConnection}`);
    let connection: AcquiredSshClient | null = null;
    try {
      connection = await this.acquireSshClient(resolvedName, {
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
          return this.appendDebugOutput(
            `Upload skipped: remote file '${validatedRemotePath}' is already identical to local ` +
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
      return this.appendDebugOutput(
        `File uploaded successfully (${uploadedBytes} bytes${modeNote})${crlfNote}`,
        debugCollector,
      );
    } catch (error) {
      if (reuseConnection && this.isConnectionError(error as Error)) {
        this.closeClient(resolvedName, true);
      }
      throw this.appendDebugToError(error as Error, debugCollector);
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
    if (!SSHConnectionManager.SHELL_SCRIPT_EXTENSIONS.has(ext)) {
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
      if (remoteSize > SSHConnectionManager.SKIP_IF_IDENTICAL_HASH_THRESHOLD) {
        // Shell scripts this large are pathological; just re-upload.
        return { skip: false, reason: `shell-script-too-large-for-content-compare(${remoteSize} bytes)` };
      }
      let remoteBuf: Buffer;
      try {
        remoteBuf = await this.sftpReadBuffer(client, remotePath, remoteSize, timeout, debug);
      } catch {
        return { skip: false, reason: "remote-read-failed-during-content-compare" };
      }
      const remoteNormalized = SSHConnectionManager.normalizeCrlfToLf(remoteBuf);
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

    if (remoteSize <= SSHConnectionManager.SKIP_IF_IDENTICAL_HASH_THRESHOLD) {
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
              const end = Math.min(offset + SSHConnectionManager.SFTP_WRITE_CHUNK_BYTES, payload.length);
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
    const resolvedName = name || this.defaultName;
    const reuseConnection = options?.reuseConnection !== false;
    const { collector: debugCollector, debug } = this.createDebugCollector(options?.vvv === true);
    const validatedLocalPath = this.validateLocalPath(localPath, resolvedName);
    const validatedRemotePath = this.validateRemotePath(remotePath, resolvedName);
    debug?.(`[mcp] sftp download on [${resolvedName}], reuseConnection=${reuseConnection}`);
    let connection: AcquiredSshClient | null = null;
    try {
      connection = await this.acquireSshClient(resolvedName, {
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
        return this.appendDebugOutput(
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
      return this.appendDebugOutput("File downloaded successfully", debugCollector);
    } catch (error) {
      if (reuseConnection && this.isConnectionError(error as Error)) {
        this.closeClient(resolvedName, true);
      }
      throw this.appendDebugToError(error as Error, debugCollector);
    } finally {
      connection?.close();
    }
  }


  /**
   * Get basic information of all configured servers.
   *
   * Lean by default — returns only identity + connection state. Pass
   * `verbose: true` to include the cached `status` block (hostname, CPU,
   * memory, disk, GPUs, etc.). The status block is large and rarely useful
   * for routing decisions, so the LLM should opt in.
   */
  public getAllServerInfos(opts: { verbose?: boolean } = {}): Array<{
    name: string;
    host: string;
    port: number;
    username: string;
    connected: boolean;
    enabled: boolean;
    jumpHost?: string;
    status?: ServerStatus;
  }> {
    const verbose = opts.verbose === true;
    return Object.keys(this.configs).map((key) => {
      const config = this.configs[key];
      const info: {
        name: string;
        host: string;
        port: number;
        username: string;
        connected: boolean;
        enabled: boolean;
        jumpHost?: string;
        status?: ServerStatus;
      } = {
        name: key,
        host: config.host,
        port: config.port,
        username: config.username,
        connected: this.connected.get(key) === true,
        enabled: this.isServerEnabled(key),
      };
      if (config.jumpHost) {
        info.jumpHost = config.jumpHost;
      }
      if (verbose) {
        const status = this.statusCache.get(key);
        if (status) info.status = status;
      }
      return info;
    });
  }

  /**
   * Default budget for refreshStatus connect + probe. Kept short so
   * list-servers {refresh:true} cannot hang the MCP tool call for minutes
   * when a host is unreachable or a status probe stalls.
   */
  private static readonly DEFAULT_STATUS_REFRESH_CONNECT_TIMEOUT_MS = 15_000;

  /**
   * Refresh system status for a server (or all enabled servers).
   *
   * Each server is independently time-bounded (connect + probe). Failures
   * yield reachable:false cache entries and never block other servers or
   * the list-servers tool call indefinitely.
   */
  public async refreshStatus(name?: string): Promise<Record<string, ServerStatus>> {
    const results: Record<string, ServerStatus> = {};
    const names = name
      ? [name]
      : (this.enabledServers ?? Object.keys(this.configs));

    await Promise.allSettled(
      names.map(async (key) => {
        try {
          // Bound both the connect phase (readyTimeout + withConnectionTimeout)
          // and the probe. Previously ensureConnected() had NO default timeout,
          // so a dead host made list-servers {refresh:true} hang forever.
          const client = await this.ensureConnected(
            key,
            SSHConnectionManager.DEFAULT_STATUS_REFRESH_CONNECT_TIMEOUT_MS,
          );
          const status = await collectSystemStatus(client, key, {
            timeoutMs: DEFAULT_STATUS_COLLECT_TIMEOUT_MS,
          });
          this.statusCache.set(key, status);
          results[key] = status;
        } catch (error) {
          const fallback: ServerStatus = {
            reachable: false,
            lastUpdated: new Date().toISOString(),
          };
          this.statusCache.set(key, fallback);
          results[key] = fallback;
          Logger.log(
            `Status refresh failed for [${key}]: ${(error as Error).message}`,
            "error",
          );
        }
      }),
    );

    return results;
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
    const { collector: debugCollector, debug } = this.createDebugCollector(options?.vvv === true);

    debug?.(
      `[mcp] sftp relay ${sourceName} -> ${destName}, reuseConnection=${reuseConnection}`,
    );
    let srcConnection: AcquiredSshClient | null = null;
    let dstConnection: AcquiredSshClient | null = null;
    let srcSftp: SFTPWrapper | null = null;
    let dstSftp: SFTPWrapper | null = null;

    try {
      srcConnection = await this.acquireSshClient(sourceName, {
        reuseConnection,
        timeout: options?.timeout,
        debug,
        purpose: "sftp",
      });
      // Same host on both ends: reuse the one SSH client (two SFTP channels are
      // still opened below) so we never open or close a second connection.
      dstConnection = selfRelay
        ? srcConnection
        : await this.acquireSshClient(destName, {
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
            const srcConfig = this.getConfig(sourceName);
            const dstConfig = this.getConfig(destName);
            return this.appendDebugOutput(
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

      const srcConfig = this.getConfig(sourceName);
      const dstConfig = this.getConfig(destName);
      return this.appendDebugOutput(
        `Transfer complete (windowed via SFTP, verified: ${verification.join(", ")}): ` +
          `${srcConfig.username}@${srcConfig.host}:${sourceRemotePath}` +
          ` → ${dstConfig.username}@${dstConfig.host}:${destRemotePath}`,
        debugCollector,
      );
    } catch (error) {
      if (reuseConnection && this.isConnectionError(error as Error)) {
        this.closeClient(sourceName, true);
        if (!selfRelay) this.closeClient(destName, true);
      }
      throw this.appendDebugToError(error as Error, debugCollector);
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
    const resolvedName = name || this.defaultName;
    const validatedSource = this.validateLocalPath(localSourcePath, resolvedName);
    const validatedDestination = this.validateRemotePath(remoteDestinationDirectory, resolvedName);
    this.assertLocalArchiveSource(validatedSource);
    const { collector: debugCollector, debug } = this.createDebugCollector(options?.vvv === true);
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
      return this.appendDebugOutput(
        `Archive upload complete (${compression}): '${validatedSource}' → ${resolvedName}:'${validatedDestination}'`,
        debugCollector,
      );
    } catch (error) {
      throw this.appendDebugToError(error as Error, debugCollector);
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
    const resolvedName = name || this.defaultName;
    const validatedSource = this.validateRemotePath(remoteSourcePath, resolvedName);
    const validatedDestination = this.validateLocalPath(localDestinationDirectory, resolvedName);
    this.ensureLocalDestinationDirectory(validatedDestination);
    this.assertArchiveBasename(path.posix.basename(validatedSource), validatedSource);
    const { collector: debugCollector, debug } = this.createDebugCollector(options?.vvv === true);
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
      return this.appendDebugOutput(
        `Archive download complete (${compression}): ${resolvedName}:'${validatedSource}' → '${validatedDestination}'`,
        debugCollector,
      );
    } catch (error) {
      throw this.appendDebugToError(error as Error, debugCollector);
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
    const { collector: debugCollector, debug } = this.createDebugCollector(options?.vvv === true);
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
      return this.appendDebugOutput(
        `Archive relay complete (${compression}): ${sourceName}:'${validatedSource}' → ${destName}:'${validatedDestination}'`,
        debugCollector,
      );
    } catch (error) {
      throw this.appendDebugToError(error as Error, debugCollector);
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
      const stderr = new OutputCollector(SSHConnectionManager.ARCHIVE_ERROR_OUTPUT_BYTES);
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
      connection = await this.acquireSshClient(name, {
        reuseConnection,
        timeout: options?.timeout,
        debug,
        purpose: "command",
      });
      const command = ["tar", ...args].map((arg) => this.shellQuote(arg)).join(" ");
      debug?.(`[mcp] remote archive command on [${name}]: tar ${args[0] ?? ""}`);
      const stream = await this.withConnectionTimeout(
        new Promise<ClientChannel>((resolve, reject) => {
          connection!.client.exec(command, (error, channel) => {
            if (error) {
              reject(this.isConnectionShapedMessage(error.message)
                ? new ToolError("SSH_CONNECTION_FAILED", `Failed to open remote archive command: ${error.message}`, true)
                : new ToolError("COMMAND_EXECUTION_ERROR", `Failed to open remote archive command: ${error.message}`, false));
              return;
            }
            resolve(channel);
          });
        }),
        this.normalizeConnectTimeout(options?.timeout),
        `Remote archive command channel open on [${name}]`,
        debug,
      );
      await new Promise<void>((resolve, reject) => {
        const stderr = new OutputCollector(SSHConnectionManager.ARCHIVE_ERROR_OUTPUT_BYTES);
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
      if (reuseConnection && this.isConnectionError(error as Error)) {
        this.closeClient(name, true);
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
      connection = await this.acquireSshClient(name, {
        reuseConnection,
        timeout: options?.timeout,
        debug,
        purpose: "sftp",
      });
      await this.sftpMkdirRecursive(connection.client, remoteDirectory, options?.timeout, debug);
    } catch (error) {
      if (reuseConnection && this.isConnectionError(error as Error)) {
        this.closeClient(name, true);
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
      connection = await this.acquireSshClient(name, {
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
    return this.withConnectionTimeout(
      open,
      this.normalizeConnectTimeout(timeout),
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
    const resolvedName = name || this.defaultName;
    const reuseConnection = options?.reuseConnection !== false;
    const { collector: debugCollector, debug } = this.createDebugCollector(options?.vvv === true);
    debug?.(`[mcp] sftp list on [${resolvedName}], reuseConnection=${reuseConnection}`);
    let connection: AcquiredSshClient | null = null;

    try {
      connection = await this.acquireSshClient(resolvedName, {
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
      if (reuseConnection && this.isConnectionError(error as Error)) {
        this.closeClient(resolvedName, true);
      }
      throw this.appendDebugToError(error as Error, debugCollector);
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
    const resolvedName = name || this.defaultName;
    const resolvedLocal = this.validateLocalPath(localDir, resolvedName);
    const validatedRemoteDir = this.validateRemotePath(remoteDir, resolvedName);
    if (!fs.statSync(resolvedLocal).isDirectory()) {
      throw new ToolError("LOCAL_FILE_READ_FAILED", `Not a directory: ${localDir}`, false);
    }
    const fileConcurrency = this.resolveRecursiveFileConcurrency(options);

    const reuseConnection = options?.reuseConnection !== false;
    const { collector: debugCollector, debug } = this.createDebugCollector(options?.vvv === true);
    debug?.(`[mcp] sftp recursive upload mkdir on [${resolvedName}], reuseConnection=${reuseConnection}`);
    let connection: AcquiredSshClient | null = null;
    try {
      connection = await this.acquireSshClient(resolvedName, {
        reuseConnection,
        timeout: options?.timeout,
        debug,
        purpose: "sftp",
      });
      await this.sftpMkdirRecursive(connection.client, validatedRemoteDir, options?.timeout, debug);
    } catch (error) {
      if (reuseConnection && this.isConnectionError(error as Error)) {
        this.closeClient(resolvedName, true);
      }
      throw this.appendDebugToError(error as Error, debugCollector);
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
        directoryConnection = await this.acquireSshClient(resolvedName, {
          reuseConnection,
          timeout: options?.timeout,
          debug,
          purpose: "sftp",
        });
        await this.sftpMkdirMany(directoryConnection.client, directories, options?.timeout, debug);
      } catch (error) {
        if (reuseConnection && this.isConnectionError(error as Error)) {
          this.closeClient(resolvedName, true);
        }
        throw this.appendDebugToError(error as Error, debugCollector);
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
   * Download a remote directory recursively to a local path. First enumerate
   * and create the local directory tree, then pull independent files through a
   * bounded worker pool to amortize small-file SFTP round trips.
   */
  public async downloadDirectory(
    remoteDir: string,
    localDir: string,
    name?: string,
    options?: SftpOptions,
  ): Promise<string[]> {
    const resolvedName = name || this.defaultName;
    const resolvedLocal = this.validateLocalPath(localDir, resolvedName);
    const validatedRemoteDir = this.validateRemotePath(remoteDir, resolvedName);
    const fileConcurrency = this.resolveRecursiveFileConcurrency(options);

    if (!fs.existsSync(resolvedLocal)) {
      fs.mkdirSync(resolvedLocal, { recursive: true });
    }

    const files: Array<{ remotePath: string; localPath: string }> = [];
    const collect = async (currentRemote: string, currentLocal: string): Promise<void> => {
      const entries = await this.listRemoteDir(currentRemote, resolvedName, options);
      for (const entry of entries) {
        if (entry.filename === "." || entry.filename === "..") continue;

        const remotePath = path.posix.join(currentRemote, entry.filename);
        const localPath = path.join(currentLocal, entry.filename);
        if (entry.isDirectory) {
          fs.mkdirSync(localPath, { recursive: true });
          await collect(remotePath, localPath);
        } else {
          files.push({ remotePath, localPath });
        }
      }
    };
    await collect(validatedRemoteDir, resolvedLocal);

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
          if (err && this.isConnectionShapedMessage(err.message)) {
            return reject(this.makeSftpError("Remote mkdir failed", err));
          }
          mkdirNext(index + 1);
        });
      };

      mkdirNext(0);
    });

    try {
      await this.withConnectionTimeout(
        walk,
        this.normalizeConnectTimeout(timeout),
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
        await this.withConnectionTimeout(
          new Promise<void>((resolve, reject) => {
            sftp.mkdir(remoteDirectory, (error?: Error | null) => {
              if (error && this.isConnectionShapedMessage(error.message)) {
                reject(this.makeSftpError(`Remote mkdir failed for '${remoteDirectory}'`, error));
                return;
              }
              resolve();
            });
          }),
          this.normalizeConnectTimeout(timeout),
          `SFTP mkdir ${remoteDirectory}`,
          debug,
        );
      }
    } finally {
      try { sftp.end(); } catch { /* ignore late cleanup errors */ }
    }
  }
}
