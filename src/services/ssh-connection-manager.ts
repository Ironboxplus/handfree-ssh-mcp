import { Client, ClientChannel } from "ssh2";
import {
  SshConnectionPool,
  type SshDebugSink,
  type AcquiredSshClient,
  type SshAcquireOptions,
} from "../connection/ssh-connection-pool.js";
import { TransferService, type ArchiveCompression, type SftpOptions } from "./transfer-service.js";
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
import {
  createDebugCollector as sharedCreateDebugCollector,
  appendDebugOutput as sharedAppendDebugOutput,
  appendDebugToError as sharedAppendDebugToError,
} from "../utils/debug-output.js";
import fs from "fs";
import path from "path";
import crypto from "crypto";

// Re-exported for backward compatibility: transfer-real.test.ts and any
// other external caller imports these from ssh-connection-manager.js.
// PLAN.MD P0-04 moved the physical declarations into transfer-service.ts
// alongside their only consumer (runLocalTar / the archive tool surface).
export { buildLocalTarArgv, type ArchiveCompression } from "./transfer-service.js";

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
  private readonly pool: SshConnectionPool = new SshConnectionPool();
  private readonly transferService: TransferService = new TransferService(this.pool);

  private constructor() {}

  /**
   * Get singleton instance
   */
  /**
   * PLAN.MD P0-04: expose the shared TransferService instance so the
   * upload/download/transfer tools can call it directly instead of routing
   * through this manager's own upload/download/... facade methods. The
   * service is still owned and constructed here (bound to this manager's
   * SshConnectionPool) so every caller shares the same connection state.
   */
  public getTransferService(): TransferService {
    return this.transferService;
  }

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

  /**
   * Public so callers outside this class -- currently src/run/remote-sftp.ts
   * -- can get the same reuseConnection=false one-shot-client escape hatch
   * that executeCommand/upload/download/transfer already have (see
   * SshConnectionPool.acquireSshClient), instead of the run-* tools being
   * permanently stuck on a cached client with no way to force a fresh one.
   */
  public async acquireSshClient(
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

  // ---------------------------------------------------------------------
  // Transfer-service facade (PLAN.MD P0-04): TransferService
  // (src/services/transfer-service.ts) now owns single-file and recursive
  // SFTP upload/download, remote-to-remote relay transfer, and tar-archive
  // packaging/extraction. These are thin, behavior-preserving delegates so
  // every existing internal call site in this file (and every external
  // caller: tools, tests) keeps working unchanged. This is a
  // characterization/refactor step per §7.1 -- no logic below is new, it is
  // 1:1 delegation to the extracted service.
  //
  // createDebugCollector / appendDebugOutput / appendDebugToError are kept
  // here too (as thin wrappers around the shared, stateless functions in
  // src/utils/debug-output.ts) because command execution (executeCommand and
  // friends, which stay on this class) also calls them.
  // ---------------------------------------------------------------------

  private createDebugCollector(enabled: boolean): {
    collector: OutputCollector | null;
    debug?: SshDebugSink;
  } {
    return sharedCreateDebugCollector(enabled);
  }

  private appendDebugOutput(result: string, collector: OutputCollector | null): string {
    return sharedAppendDebugOutput(result, collector);
  }

  private appendDebugToError(error: Error, collector: OutputCollector | null): Error {
    return sharedAppendDebugToError(error, collector);
  }

  private validateLocalPath(localPath: string, name?: string): string {
    return this.transferService.validateLocalPath(localPath, name);
  }

  private validateRemotePath(remotePath: string, name: string): string {
    return this.transferService.validateRemotePath(remotePath, name);
  }

  public async upload(
    localPath: string,
    remotePath: string,
    name?: string,
    options?: SftpOptions & { skipIfIdentical?: boolean },
  ): Promise<string> {
    return this.transferService.upload(localPath, remotePath, name, options);
  }

  public async download(
    remotePath: string,
    localPath: string,
    name?: string,
    options?: SftpOptions,
  ): Promise<string> {
    return this.transferService.download(remotePath, localPath, name, options);
  }

  public async transferBetweenServers(
    sourceName: string,
    sourceRemotePath: string,
    destName: string,
    destRemotePath: string,
    options?: SftpOptions & { skipIfIdentical?: boolean },
  ): Promise<string> {
    return this.transferService.transferBetweenServers(sourceName, sourceRemotePath, destName, destRemotePath, options);
  }

  public async uploadArchive(
    localSourcePath: string,
    remoteDestinationDirectory: string,
    name?: string,
    compression: ArchiveCompression = "none",
    options?: SftpOptions,
  ): Promise<string> {
    return this.transferService.uploadArchive(localSourcePath, remoteDestinationDirectory, name, compression, options);
  }

  public async downloadArchive(
    remoteSourcePath: string,
    localDestinationDirectory: string,
    name?: string,
    compression: ArchiveCompression = "none",
    options?: SftpOptions,
  ): Promise<string> {
    return this.transferService.downloadArchive(remoteSourcePath, localDestinationDirectory, name, compression, options);
  }

  public async transferArchiveBetweenServers(
    sourceName: string,
    sourceRemotePath: string,
    destName: string,
    destRemoteDirectory: string,
    compression: ArchiveCompression = "none",
    options?: SftpOptions,
  ): Promise<string> {
    return this.transferService.transferArchiveBetweenServers(sourceName, sourceRemotePath, destName, destRemoteDirectory, compression, options);
  }

  public async listRemoteDir(
    remotePath: string,
    name?: string,
    options?: SftpOptions,
  ): Promise<Array<{ filename: string; isDirectory: boolean; size: number }>> {
    return this.transferService.listRemoteDir(remotePath, name, options);
  }

  public async uploadDirectory(
    localDir: string,
    remoteDir: string,
    name?: string,
    options?: SftpOptions & { skipIfIdentical?: boolean },
  ): Promise<string[]> {
    return this.transferService.uploadDirectory(localDir, remoteDir, name, options);
  }

  public async downloadDirectory(
    remoteDir: string,
    localDir: string,
    name?: string,
    options?: SftpOptions,
  ): Promise<string[]> {
    return this.transferService.downloadDirectory(remoteDir, localDir, name, options);
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

}
