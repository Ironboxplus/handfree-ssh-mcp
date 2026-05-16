import { Client, ClientChannel } from "ssh2";
import { SocksClient } from "socks";
import { SSHConfig, SshConnectionConfigMap, ServerStatus } from "../models/types.js";
import { Logger } from "../utils/logger.js";
import { collectSystemStatus } from "../utils/status-collector.js";
import { ToolError } from "../utils/tool-error.js";
import { OutputCollector } from "../utils/output-collector.js";
import { OutputLogWriter } from "../utils/output-log-writer.js";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { SFTPWrapper } from "ssh2";

/**
 * Default command whitelist - only allow safe Linux commands
 * These patterns are regex strings that match allowed commands
 */
/**
 * Default command whitelist - only allow safe Linux commands
 * These patterns are regex strings that match allowed commands
 * 
 * SECURITY: Commands not matching any pattern will be BLOCKED with an error message
 */
const DEFAULT_COMMAND_WHITELIST: string[] = [
  // Basic file operations (READ-ONLY)
  "^ls( .*)?$",
  "^cat .*$",
  "^head .*$",
  "^tail .*$",
  "^less .*$",
  "^more .*$",
  "^wc .*$",
  "^file .*$",
  "^stat .*$",
  "^find .*$",
  "^grep .*$",
  "^awk .*$",
  "^sed .*$",
  // Directory navigation
  "^pwd$",
  "^cd .*$",
  // System info (read-only)
  "^echo .*$",
  "^hostname$",
  "^whoami$",
  "^id$",
  "^uname .*$",
  "^df .*$",
  "^du .*$",
  "^free .*$",
  "^top -bn1.*$",
  "^ps .*$",
  "^uptime$",
  "^date$",
  "^env$",
  "^printenv.*$",
  // Network diagnostics (read-only)
  "^ping -c \\d+ .*$",
  "^curl .*$",
  "^wget .*$",
  "^netstat .*$",
  "^ss .*$",
  "^ip .*$",
  // Git operations
  "^git .*$",
  // Systemctl (read-only)
  "^systemctl status .*$",
  "^systemctl list-.*$",
  "^journalctl .*$",
  // Docker (read-only)
  "^docker ps.*$",
  "^docker logs.*$",
  "^docker images.*$",
  "^docker inspect.*$",
  
  // ============================================
  // DANGEROUS COMMANDS - EXPLICITLY BANNED:
  // - rm, rmdir (delete files/dirs)
  // - mv (can overwrite/move files)
  // - cp (can overwrite files)
  // - chmod, chown (change permissions)
  // - kill, pkill (terminate processes)
  // - mkdir, touch (create files/dirs)
  // - >, >> (redirect/overwrite files)
  // - wget -O, curl -o (download and overwrite)
  // ============================================
];

/**
 * SSH Connection Manager class
 */
export class SSHConnectionManager {
  private static instance: SSHConnectionManager;
  private clients: Map<string, Client> = new Map();
  private configs: SshConnectionConfigMap = {};
  private connected: Map<string, boolean> = new Map();
  private statusCache: Map<string, ServerStatus> = new Map();
  private defaultName: string = "default";
  private enabledServers: string[] | null = null; // null = all servers enabled
  private outputLogRoot: string | null = null; // null = use <cwd>/.handfree-output at write time

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

  /**
   * Batch set SSH configurations
   * @param configs - Server configurations
   * @param enabledServers - List of enabled server names (null = all enabled)
   */
  public setConfig(
    configs: SshConnectionConfigMap,
    enabledServers?: string[]
  ): void {
    this.configs = configs;
    this.enabledServers = enabledServers || null;
    
    // Set default to first enabled server, or first server if none specified
    if (enabledServers && enabledServers.length > 0) {
      this.defaultName = enabledServers[0];
    } else if (Object.keys(configs).length > 0) {
      this.defaultName = Object.keys(configs)[0];
    }
    
    if (this.enabledServers) {
      Logger.log(`Enabled servers: ${this.enabledServers.join(", ")}`, "info");
      Logger.log(`Default server: ${this.defaultName}`, "info");
    }
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
   * Hot-reload mutable policy fields from a fresh config map.
   * Only updates whitelist, blacklist, safeDirectory, allowedRemoteDirectories,
   * and allowedLocalDirectories for servers that already exist. Does NOT touch
   * SSH connections or credentials.
   */
  public updatePolicies(freshConfigs: SshConnectionConfigMap): void {
    let changed = 0;

    for (const [name, existing] of Object.entries(this.configs)) {
      const fresh = freshConfigs[name];
      if (!fresh) continue;

      const wlChanged =
        JSON.stringify(existing.commandWhitelist) !==
        JSON.stringify(fresh.commandWhitelist);
      const blChanged =
        JSON.stringify(existing.commandBlacklist) !==
        JSON.stringify(fresh.commandBlacklist);
      const sdChanged = existing.safeDirectory !== fresh.safeDirectory;
      const ardChanged =
        JSON.stringify(existing.allowedRemoteDirectories) !==
        JSON.stringify(fresh.allowedRemoteDirectories);
      const aldChanged =
        JSON.stringify(existing.allowedLocalDirectories) !==
        JSON.stringify(fresh.allowedLocalDirectories);

      if (wlChanged || blChanged || sdChanged || ardChanged || aldChanged) {
        existing.commandWhitelist = fresh.commandWhitelist;
        existing.commandBlacklist = fresh.commandBlacklist;
        existing.safeDirectory = fresh.safeDirectory;
        existing.allowedRemoteDirectories = fresh.allowedRemoteDirectories;
        existing.allowedLocalDirectories = fresh.allowedLocalDirectories;
        changed++;

        const parts: string[] = [];
        if (wlChanged) parts.push(`whitelist(${(fresh.commandWhitelist ?? []).length})`);
        if (blChanged) parts.push(`blacklist(${(fresh.commandBlacklist ?? []).length})`);
        if (sdChanged) parts.push(`safeDirectory(${fresh.safeDirectory ?? "none"})`);
        if (ardChanged) parts.push(`allowedRemoteDirectories(${(fresh.allowedRemoteDirectories ?? []).length})`);
        if (aldChanged) parts.push(`allowedLocalDirectories(${(fresh.allowedLocalDirectories ?? []).length})`);
        Logger.log(
          `Hot-reloaded policies for [${name}]: ${parts.join(", ")}`,
          "info",
        );
      }
    }

    if (changed === 0) {
      Logger.log("Config file changed but no policy updates detected", "info");
    }
  }

  /**
   * Check if a server is enabled for use
   */
  private isServerEnabled(name: string): boolean {
    if (!this.enabledServers) {
      return true; // All servers enabled
    }
    return this.enabledServers.includes(name);
  }

  /**
   * Returns true when more than one server is enabled,
   * meaning callers MUST specify connectionName explicitly.
   */
  public isMultiServer(): boolean {
    const count = this.enabledServers
      ? this.enabledServers.length
      : Object.keys(this.configs).length;
    return count > 1;
  }

  /**
   * Resolve the target server name.
   * When multiple servers are enabled, connectionName is mandatory.
   */
  public resolveServer(connectionName?: string): string {
    if (this.isMultiServer() && !connectionName) {
      const names = this.enabledServers ?? Object.keys(this.configs);
      throw new ToolError(
        "INVALID_CONFIGURATION",
        `Multiple servers are enabled (${names.join(", ")}). You must specify connectionName explicitly. Call list-servers to see available names.`,
        false,
      );
    }
    return connectionName || this.defaultName;
  }

  /**
   * Get specified connection configuration
   * Throws error if server is not enabled
   */
  public getConfig(name?: string): SSHConfig {
    const key = name || this.defaultName;
    
    // Check if server exists
    if (!this.configs[key]) {
      throw new ToolError("INVALID_CONFIGURATION", `SSH configuration for '${key}' not set`, false);
    }
    
    // Check if server is enabled
    if (!this.isServerEnabled(key)) {
      throw new ToolError(
        "INVALID_CONFIGURATION",
        `SSH server '${key}' is not enabled. Enabled servers: ${this.enabledServers?.join(", ") || "none"}`,
        false,
      );
    }
    
    return this.configs[key];
  }

  /**
   * Get server config without throwing (returns null if not found/enabled)
   * Useful for tools that want to inspect config without failing
   */
  public getServerConfig(name?: string): SSHConfig | null {
    const key = name || this.defaultName;
    
    if (!this.configs[key]) {
      return null;
    }
    
    if (!this.isServerEnabled(key)) {
      return null;
    }
    
    return this.configs[key];
  }

  /**
   * Batch connect all configured SSH connections
   */
  public async connectAll(): Promise<void> {
    const names = this.enabledServers ?? Object.keys(this.configs);
    const results = await Promise.allSettled(
      names.map((name) => this.connect(name)),
    );
    const failures = results
      .map((r, i) => (r.status === "rejected" ? `${names[i]}: ${(r.reason as Error).message}` : null))
      .filter(Boolean);
    if (failures.length > 0) {
      Logger.log(`Pre-connect failures: ${failures.join("; ")}`, "error");
    }
  }

  /**
   * Connect to SSH with specified name
   */
  public async connect(name?: string): Promise<void> {
    const key = name || this.defaultName;
    if (this.connected.get(key) && this.clients.get(key)) {
      return;
    }
    const config = this.getConfig(key);
    const client = new Client();
    await new Promise<void>(async (resolve, reject) => {
      client.on("ready", () => {
        this.connected.set(key, true);
        Logger.log(
          `Successfully connected to SSH server [${key}] ${config.host}:${config.port}`
        );

        // 先 resolve，让用户命令可以立即执行
        resolve();

        // 延迟执行系统状态收集，避免与用户的第一个命令竞争 SSH 通道
        // 这修复了首次连接后第一个命令失败的竞态条件问题
        // See: https://github.com/classfang/ssh-mcp-server/issues/XX
        setTimeout(() => {
          collectSystemStatus(client, key)
            .then((status) => {
              this.statusCache.set(key, status);
              Logger.log(
                `System status collected for [${key}]`,
                "info"
              );
            })
            .catch((error) => {
              Logger.log(
                `Failed to collect system status for [${key}]: ${(error as Error).message}`,
                "error"
              );
              // Set basic status even if collection fails
              this.statusCache.set(key, {
                reachable: true,
                lastUpdated: new Date().toISOString(),
              });
            });
        }, 1000); // 延迟 1 秒，确保用户命令有足够的时间窗口
      });
      client.on("error", (err: Error) => {
        this.connected.set(key, false);
        reject(new ToolError("SSH_CONNECTION_FAILED", `SSH connection [${key}] failed: ${err.message}`, true));
      });
      client.on("close", () => {
        this.connected.set(key, false);
        Logger.log(`SSH connection [${key}] closed`, "info");
      });
      const sshConfig: any = {
        host: config.host,
        port: config.port,
        username: config.username,
      };
      // Add SOCKS proxy configuration if provided
      if (config.socksProxy) {
        try {
          // Parse SOCKS proxy URL
          const proxyUrl = new URL(config.socksProxy);
          const proxyHost = proxyUrl.hostname;
          const proxyPort = parseInt(proxyUrl.port, 10);

          Logger.log(
            `Using SOCKS proxy for [${key}]: ${config.socksProxy}`,
            "info"
          );

          // Create SOCKS connection
          const { socket } = await SocksClient.createConnection({
            proxy: {
              host: proxyHost,
              port: proxyPort,
              type: 5,
            },
            command: "connect",
            destination: {
              host: config.host,
              port: config.port,
            },
          });

          // Set the socket as the sock for SSH connection
          sshConfig.sock = socket;
          Logger.log(
            `SSH config object with SOCKS proxy: ${JSON.stringify(
              sshConfig,
              (k, v) => (k === "sock" ? "[Socket object]" : v)
            )}`,
            "info"
          );
        } catch (err) {
          return reject(
            new ToolError(
              "SSH_CONNECTION_FAILED",
              `Failed to create SOCKS proxy connection for [${key}]: ${
                (err as Error).message
              }`,
              true,
            )
          );
        }
      }
      if (config.privateKey) {
        try {
          sshConfig.privateKey = fs.readFileSync(config.privateKey, "utf8");
          if (config.passphrase) {
            sshConfig.passphrase = config.passphrase;
          }
          Logger.log(
            `Using SSH private key authentication for [${key}]`,
            "info"
          );
        } catch (err) {
          return reject(
            new ToolError(
              "LOCAL_FILE_READ_FAILED",
              `Failed to read private key file for [${key}]: ${
                (err as Error).message
              }`,
              false,
            )
          );
        }
      } else if (config.password) {
        sshConfig.password = config.password;
        Logger.log(`Using password authentication for [${key}]`, "info");
      } else {
        return reject(
          new ToolError(
            "SSH_AUTHENTICATION_MISSING",
            `No valid authentication method provided for [${key}] (password or private key)`,
            false,
          )
        );
      }
      client.connect(sshConfig);
    });
    this.clients.set(key, client);
  }

  /**
   * Get SSH Client with specified name
   */
  public getClient(name?: string): Client {
    const key = name || this.defaultName;
    const client = this.clients.get(key);
    if (!client) {
      throw new ToolError("SSH_CONNECTION_FAILED", `SSH client for '${key}' not connected`, true);
    }
    return client;
  }

  /**
   * Ensure SSH client is connected
   * @private
   */
  private async ensureConnected(name?: string): Promise<Client> {
    const key = name || this.defaultName;
    if (!this.connected.get(key) || !this.clients.get(key)) {
      await this.connect(key);
    }
    const client = this.clients.get(key);
    if (!client) {
      throw new ToolError("SSH_CONNECTION_FAILED", `SSH client for '${key}' not initialized`, true);
    }
    return client;
  }

  /**
   * Check if an error is a connection-related error that can be retried
   * @private
   */
  private isConnectionError(error: Error): boolean {
    if (error instanceof ToolError) {
      return error.code === "SSH_CONNECTION_FAILED";
    }

    const msg = error.message.toLowerCase();
    return (
      msg.includes("not connected") ||
      msg.includes("connection") ||
      msg.includes("socket") ||
      msg.includes("econnreset") ||
      msg.includes("econnrefused") ||
      msg.includes("epipe") ||
      msg.includes("closed") ||
      msg.includes("end of stream") ||
      msg.includes("channel")
    );
  }

  /**
   * Force reconnect to SSH server
   * @private
   */
  private async reconnect(name?: string): Promise<void> {
    const key = name || this.defaultName;
    Logger.log(`Attempting to reconnect SSH [${key}]...`, "info");
    
    // Close existing connection if any
    const existingClient = this.clients.get(key);
    if (existingClient) {
      try {
        existingClient.end();
      } catch (e) {
        // Ignore errors when closing dead connection
      }
      this.clients.delete(key);
    }
    this.connected.set(key, false);
    
    // Reconnect
    await this.connect(key);
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
    const destructivePatterns: Array<{ regex: RegExp; reason: string }> = [
      { regex: /\brm\b/, reason: "rm in command chain" },
      { regex: /\brmdir\b/, reason: "rmdir in command chain" },
      { regex: /\bunlink\b/, reason: "unlink in command chain" },
      { regex: /\bshred\b/, reason: "shred in command chain" },
      { regex: /\btruncate\b/, reason: "truncate in command chain" },
      { regex: /-delete\b/, reason: "find -delete detected" },
      { regex: /-exec\s+rm\b/, reason: "find -exec rm detected" },
      { regex: /\bdd\b.*\bof=/, reason: "dd with of= (can overwrite files)" },
      { regex: /\bmv\b/, reason: "mv detected (can overwrite)" },
      { regex: /\bcp\b.*-f/, reason: "cp -f detected (force overwrite)" },
      // Allow stderr redirection to /dev/null (2>/dev/null, 2>&1>/dev/null, etc.)
      // Block dangerous writes like: echo x > /etc/passwd, cat > /bin/bash
      { regex: /(?<![0-9])>\s*\/(?!dev\/null)/, reason: "output redirection to absolute path" },
      { regex: />\s*~/, reason: "output redirection to home path" },
    ];
    
    for (const { regex, reason } of destructivePatterns) {
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
    // Must be absolute path starting with safe directory
    if (!filePath.startsWith(safeDir)) {
      return false;
    }
    
    // Check for path traversal attempts
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
    
    // After normalization, must still be inside safe directory
    return normalizedPath.startsWith(safeDir);
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
    const destructiveReason = this.getDestructiveMatch(command);
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
    // LAYER 2: Whitelist check for non-destructive commands
    // ========================================
    
    // Use config whitelist if provided, otherwise use default whitelist
    const whitelist = (config.commandWhitelist && config.commandWhitelist.length > 0)
      ? config.commandWhitelist
      : DEFAULT_COMMAND_WHITELIST;
    
    // Check whitelist - command must match one of the patterns to be allowed
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
    
    // ========================================
    // LAYER 3: Blacklist check
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
      logWriter?: OutputLogWriter;
      onProgress?: (chunk: string) => void;
    }
  ): Promise<number | null> {
    return new Promise<number | null>((resolve, reject) => {
      let timeoutId: NodeJS.Timeout;
      const cleanup = () => {
        if (timeoutId) clearTimeout(timeoutId);
      };

      client.exec(cmdString, (err: Error | undefined, stream: ClientChannel) => {
        if (err) {
          cleanup();
          reject(new ToolError("COMMAND_EXECUTION_ERROR", `Command execution error: ${err.message}`, false));
          return;
        }

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
          cleanup();
          resolve(code ?? null);
        });

        stream.on("error", (err: Error) => {
          cleanup();
          reject(new ToolError("COMMAND_EXECUTION_ERROR", `Stream error: ${err.message}`, false));
        });

        timeoutId = setTimeout(() => {
          cleanup();
          try {
            stream.signal("KILL");
          } catch (e) {
            // Ignore errors when sending signal
          }
          try {
            stream.close();
          } catch (e) {
            // Ignore errors when closing streams during timeout
          }
          reject(new ToolError(
            "COMMAND_TIMEOUT",
            `Command timeout: execution exceeded ${timeout}ms limit. Remote process killed.`,
            false,
          ));
        }, timeout);
      });
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
   * - Validates command against whitelist/blacklist before execution
   * - Auto-reconnects and retries on connection failures
   * - Exponential backoff between retries (500ms, 1000ms, 2000ms)
   * - Configurable timeout per command
   */
  public async executeCommand(
    cmdString: string,
    name?: string,
    options: { timeout?: number; maxRetries?: number; maxOutputBytes?: number } = {}
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
    const key = name || this.defaultName;

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        // Ensure SSH connection is established
        const client = await this.ensureConnected(name);

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
          });
        } finally {
          logWriter?.close({ exitCode, durationMs: Date.now() - startedMs });
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

        return result;
      } catch (error) {
        lastError = error as Error;
        
        // Check if this is a connection error that can be retried
        if (this.isConnectionError(lastError) && attempt < maxRetries) {
          const backoffMs = 500 * Math.pow(2, attempt); // 500ms, 1000ms, 2000ms
          Logger.log(
            `Connection error on attempt ${attempt + 1}/${maxRetries + 1} for [${key}]: ${lastError.message}. Retrying in ${backoffMs}ms...`,
            "info"
          );
          
          // Wait with exponential backoff
          await this.sleep(backoffMs);
          
          // Force reconnect before retry
          try {
            await this.reconnect(name);
          } catch (reconnectError) {
            Logger.log(
              `Reconnect failed for [${key}]: ${(reconnectError as Error).message}`,
              "error"
            );
            // Continue to next retry attempt anyway
          }
          
          continue;
        }
        
        // Non-retryable error or max retries reached
        break;
      }
    }
    
    // All retries exhausted
    throw lastError || new Error("Command execution failed after all retries");
  }

  /**
   * Execute SSH command with real-time streaming output via progress callback
   * 
   * Features:
   * - Validates command against whitelist/blacklist before execution
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
    options: {
      timeout?: number;
      maxRetries?: number;
      maxOutputBytes?: number;
      onProgress?: (chunk: string) => void;
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

    const timeout = options.timeout || 300000; // Default 5 minutes for streaming
    const maxRetries = options.maxRetries ?? 2; // Default 2 retries
    const maxOutputBytes = options.maxOutputBytes ?? SSHConnectionManager.DEFAULT_MAX_OUTPUT_BYTES;
    const key = name || this.defaultName;

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        // Ensure SSH connection is established
        const client = await this.ensureConnected(name);

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
          });
        } finally {
          logWriter?.close({ exitCode, durationMs: Date.now() - startedMs });
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

        return result;
      } catch (error) {
        lastError = error as Error;

        // Check if this is a connection error that can be retried
        if (this.isConnectionError(lastError) && attempt < maxRetries) {
          const backoffMs = 500 * Math.pow(2, attempt);
          Logger.log(
            `Connection error on streaming attempt ${attempt + 1}/${maxRetries + 1} for [${key}]: ${lastError.message}. Retrying in ${backoffMs}ms...`,
            "info"
          );

          await this.sleep(backoffMs);

          try {
            await this.reconnect(name);
          } catch (reconnectError) {
            Logger.log(
              `Reconnect failed for [${key}]: ${(reconnectError as Error).message}`,
              "error"
            );
          }

          continue;
        }

        break;
      }
    }

    throw lastError || new Error("Streaming command execution failed after all retries");
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
    const allowedRoots = new Set<string>([process.cwd()]);

    // Add per-server allowedLocalDirectories if a server is targeted
    if (name) {
      const config = this.getServerConfig(name);
      if (config?.allowedLocalDirectories) {
        for (const dir of config.allowedLocalDirectories) {
          allowedRoots.add(dir);
        }
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

    if (allowedRoots.length === 0) {
      throw new ToolError(
        "REMOTE_PATH_NOT_ALLOWED",
        `SFTP is disabled for server '${name}': no 'allowedRemoteDirectories' configured. ` +
          `Add at least one absolute POSIX directory to 'allowedRemoteDirectories' in the YAML config to permit upload/download.`,
        false,
      );
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
    options?: { skipIfIdentical?: boolean },
  ): Promise<string> {
    const resolvedName = name || this.defaultName;
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

    let payload: Buffer;
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
    const crlfFixed = SSHConnectionManager.maybeFixShellScriptLineEndings(
      validatedLocalPath,
      payload,
    );
    payload = crlfFixed.buffer;
    const crlfNote = crlfFixed.fixed
      ? ` (CRLF→LF auto-fix: converted ${crlfFixed.replacedCount} line endings to LF before upload because target is a shell script).`
      : "";

    const client = await this.ensureConnected(resolvedName);

    // ---- Skip-if-identical check ----
    const isShellScript = SSHConnectionManager.SHELL_SCRIPT_EXTENSIONS.has(
      path.extname(validatedLocalPath).toLowerCase(),
    );
    if (skipIfIdentical) {
      const decision = await this.shouldSkipUpload(
        client,
        payload,
        validatedRemotePath,
        isShellScript,
      );
      if (decision.skip) {
        return (
          `Upload skipped: remote file '${validatedRemotePath}' is already identical to local ` +
          `'${validatedLocalPath}' (${decision.reason}).${crlfNote}`
        );
      }
    }

    // ---- Actually upload ----
    await this.sftpWriteBuffer(client, validatedRemotePath, payload);

    return `File uploaded successfully (${payload.length} bytes)${crlfNote}`;
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
  ): Promise<{ skip: boolean; reason: string }> {
    let remoteSize: number;
    try {
      const sftp = await this.openSftp(client, "dest");
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
        remoteBuf = await this.sftpReadBuffer(client, remotePath, remoteSize);
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
        remoteBuf = await this.sftpReadBuffer(client, remotePath, remoteSize);
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
   */
  private async sftpReadBuffer(
    client: Client,
    remotePath: string,
    expectedSize: number,
  ): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      client.sftp((err, sftp) => {
        if (err) {
          return reject(
            new ToolError("SFTP_ERROR", `SFTP open failed: ${err.message}`, true),
          );
        }
        const chunks: Buffer[] = [];
        let received = 0;
        const stream = sftp.createReadStream(remotePath);
        stream.on("data", (chunk: Buffer) => {
          chunks.push(chunk);
          received += chunk.length;
        });
        stream.on("error", (e: Error) => {
          sftp.end();
          reject(new ToolError("SFTP_ERROR", `Remote read failed: ${e.message}`, false));
        });
        stream.on("end", () => {
          sftp.end();
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
      });
    });
  }

  /**
   * Write a Buffer to an SFTP path (overwrites if exists).
   */
  private async sftpWriteBuffer(
    client: Client,
    remotePath: string,
    payload: Buffer,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      client.sftp((err, sftp) => {
        if (err) {
          return reject(
            new ToolError("SFTP_ERROR", `SFTP open failed: ${err.message}`, true),
          );
        }
        const writeStream = sftp.createWriteStream(remotePath);
        writeStream.on("close", () => {
          sftp.end();
          resolve();
        });
        writeStream.on("error", (e: Error) => {
          sftp.end();
          reject(new ToolError("SFTP_ERROR", `File upload failed: ${e.message}`, false));
        });
        writeStream.end(payload);
      });
    });
  }

  /**
   * Download file
   */
  public async download(
    remotePath: string,
    localPath: string,
    name?: string
  ): Promise<string> {
    const resolvedName = name || this.defaultName;
    const validatedLocalPath = this.validateLocalPath(localPath, resolvedName);
    const validatedRemotePath = this.validateRemotePath(remotePath, resolvedName);
    const client = await this.ensureConnected(resolvedName);

    return new Promise<string>((resolve, reject) => {
      client.sftp((err: Error | undefined, sftp: SFTPWrapper) => {
        if (err) {
          return reject(new ToolError("SFTP_ERROR", `SFTP connection failed: ${err.message}`, true));
        }

        const readStream = sftp.createReadStream(validatedRemotePath);
        const writeStream = fs.createWriteStream(validatedLocalPath);

        const cleanup = () => {
          sftp.end();
        };

        writeStream.on("finish", () => {
          cleanup();
          resolve("File downloaded successfully");
        });

        writeStream.on("error", (err: Error) => {
          cleanup();
          reject(new ToolError("LOCAL_FILE_WRITE_FAILED", `Failed to save file: ${err.message}`, false));
        });

        readStream.on("error", (err: Error) => {
          cleanup();
          reject(new ToolError("SFTP_ERROR", `File download failed: ${err.message}`, false));
        });

        readStream.pipe(writeStream);
      });
    });
  }

  /**
   * Disconnect SSH connection
   */
  public disconnect(): void {
    if (this.clients.size > 0) {
      for (const client of this.clients.values()) {
        client.end();
      }
      this.clients.clear();
    }
  }

  /**
   * Get basic information of all configured servers
   */
  public getAllServerInfos(): Array<{
    name: string;
    host: string;
    port: number;
    username: string;
    connected: boolean;
    enabled: boolean;
    status?: ServerStatus;
  }> {
    return Object.keys(this.configs).map((key) => {
      const config = this.configs[key];
      const status = this.statusCache.get(key);
      return {
        name: key,
        host: config.host,
        port: config.port,
        username: config.username,
        connected: this.connected.get(key) === true,
        enabled: this.isServerEnabled(key),
        status: status,
      };
    });
  }

  /**
   * Refresh system status for a server (or all enabled servers)
   */
  public async refreshStatus(name?: string): Promise<Record<string, ServerStatus>> {
    const results: Record<string, ServerStatus> = {};
    const names = name
      ? [name]
      : (this.enabledServers ?? Object.keys(this.configs));

    await Promise.allSettled(
      names.map(async (key) => {
        try {
          const client = await this.ensureConnected(key);
          const status = await collectSystemStatus(client, key);
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
  ): Promise<string> {
    const validatedSourcePath = this.validateRemotePath(sourceRemotePath, sourceName);
    const validatedDestPath = this.validateRemotePath(destRemotePath, destName);

    const srcClient = await this.ensureConnected(sourceName);
    const dstClient = await this.ensureConnected(destName);

    const srcSftp = await this.openSftp(srcClient, "source");
    const dstSftp = await this.openSftp(dstClient, "dest");

    try {
      // Get source file size before transfer
      const srcStat = await this.sftpStat(srcSftp, validatedSourcePath, "source");

      const readStream = srcSftp.createReadStream(validatedSourcePath);
      const writeStream = dstSftp.createWriteStream(validatedDestPath);
      // Bind the validated paths into the rest of the verification flow so
      // we never accidentally fall back to the un-validated originals.
      sourceRemotePath = validatedSourcePath;
      destRemotePath = validatedDestPath;

      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const settle = (err?: Error) => {
          if (settled) return;
          settled = true;
          err ? reject(err) : resolve();
        };

        writeStream.on("close", () => settle());
        writeStream.on("error", (err: Error) =>
          settle(new ToolError("SFTP_ERROR", `Dest write error: ${err.message}`, false)),
        );
        readStream.on("error", (err: Error) =>
          settle(new ToolError("SFTP_ERROR", `Source read error: ${err.message}`, false)),
        );

        readStream.pipe(writeStream);
      });

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
      return (
        `Transfer complete (streamed via SFTP, verified: ${verification.join(", ")}): ` +
        `${srcConfig.username}@${srcConfig.host}:${sourceRemotePath}` +
        ` → ${dstConfig.username}@${dstConfig.host}:${destRemotePath}`
      );
    } finally {
      srcSftp.end();
      dstSftp.end();
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
            new ToolError("SFTP_ERROR", `Failed to stat ${label} file: ${err.message}`, false),
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

  /**
   * Open an SFTP session from an existing SSH client.
   */
  private openSftp(client: Client, label: string): Promise<SFTPWrapper> {
    return new Promise((resolve, reject) => {
      client.sftp((err: Error | undefined, sftp: SFTPWrapper) => {
        if (err) {
          return reject(
            new ToolError("SFTP_ERROR", `SFTP connection failed (${label}): ${err.message}`, true),
          );
        }
        resolve(sftp);
      });
    });
  }

  /**
   * List remote files/directories via SFTP readdir
   */
  public async listRemoteDir(
    remotePath: string,
    name?: string,
  ): Promise<Array<{ filename: string; isDirectory: boolean; size: number }>> {
    const client = await this.ensureConnected(name);

    return new Promise((resolve, reject) => {
      client.sftp((err: Error | undefined, sftp: SFTPWrapper) => {
        if (err) {
          return reject(new ToolError("SFTP_ERROR", `SFTP connection failed: ${err.message}`, true));
        }

        sftp.readdir(remotePath, (err, list) => {
          sftp.end();
          if (err) {
            return reject(new ToolError("SFTP_ERROR", `Failed to list remote directory: ${err.message}`, false));
          }
          const entries = list.map((entry) => ({
            filename: entry.filename,
            isDirectory: (entry.attrs.mode & 0o40000) !== 0,
            size: entry.attrs.size,
          }));
          resolve(entries);
        });
      });
    });
  }

  /**
   * Upload a local directory recursively to a remote server
   */
  public async uploadDirectory(
    localDir: string,
    remoteDir: string,
    name?: string,
    options?: { skipIfIdentical?: boolean },
  ): Promise<string[]> {
    const resolvedName = name || this.defaultName;
    const resolvedLocal = this.validateLocalPath(localDir, resolvedName);
    const validatedRemoteDir = this.validateRemotePath(remoteDir, resolvedName);
    if (!fs.statSync(resolvedLocal).isDirectory()) {
      throw new ToolError("LOCAL_FILE_READ_FAILED", `Not a directory: ${localDir}`, false);
    }

    const results: string[] = [];

    const client = await this.ensureConnected(resolvedName);
    await this.sftpMkdirRecursive(client, validatedRemoteDir);

    const entries = fs.readdirSync(resolvedLocal, { withFileTypes: true });
    for (const entry of entries) {
      const localPath = path.join(localDir, entry.name);
      const remoteSub = `${validatedRemoteDir}/${entry.name}`;

      if (entry.isDirectory()) {
        const subResults = await this.uploadDirectory(localPath, remoteSub, resolvedName, options);
        results.push(...subResults);
      } else {
        await this.upload(localPath, remoteSub, resolvedName, options);
        results.push(remoteSub);
      }
    }

    return results;
  }

  /**
   * Download a remote directory recursively to a local path
   */
  public async downloadDirectory(
    remoteDir: string,
    localDir: string,
    name?: string,
  ): Promise<string[]> {
    const resolvedName = name || this.defaultName;
    const resolvedLocal = this.validateLocalPath(localDir, resolvedName);
    const validatedRemoteDir = this.validateRemotePath(remoteDir, resolvedName);

    if (!fs.existsSync(resolvedLocal)) {
      fs.mkdirSync(resolvedLocal, { recursive: true });
    }

    const results: string[] = [];
    const entries = await this.listRemoteDir(validatedRemoteDir, resolvedName);

    for (const entry of entries) {
      if (entry.filename === "." || entry.filename === "..") continue;

      const remotePath = `${validatedRemoteDir}/${entry.filename}`;
      const localPath = path.join(localDir, entry.filename);

      if (entry.isDirectory) {
        const subResults = await this.downloadDirectory(remotePath, localPath, resolvedName);
        results.push(...subResults);
      } else {
        await this.download(remotePath, localPath, resolvedName);
        results.push(localPath);
      }
    }

    return results;
  }

  /**
   * Create remote directory recursively via SFTP
   */
  private async sftpMkdirRecursive(client: Client, remotePath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      client.sftp((err: Error | undefined, sftp: SFTPWrapper) => {
        if (err) {
          return reject(new ToolError("SFTP_ERROR", `SFTP connection failed: ${err.message}`, true));
        }

        const parts = remotePath.split("/").filter(Boolean);
        let current = "";

        const mkdirNext = (index: number) => {
          if (index >= parts.length) {
            sftp.end();
            return resolve();
          }

          current += "/" + parts[index];
          sftp.mkdir(current, (err) => {
            // EEXIST is fine
            mkdirNext(index + 1);
          });
        };

        mkdirNext(0);
      });
    });
  }
}
