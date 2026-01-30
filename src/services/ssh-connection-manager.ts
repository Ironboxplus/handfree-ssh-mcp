import { Client, ClientChannel } from "ssh2";
import { SocksClient } from "socks";
import { SSHConfig, SshConnectionConfigMap, ServerStatus } from "../models/types.js";
import { Logger } from "../utils/logger.js";
import { collectSystemStatus } from "../utils/status-collector.js";
import fs from "fs";
import path from "path";
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
  // Python execution via conda (main use case - must use full path)
  "^/home/devuser/miniforge3/bin/conda run -n my-env.*python.*$",
  // Direct Python execution from conda env (for deploy scripts, etc.)
  "^/home/devuser/miniforge3/envs/my-env/(bin/)?python.*$",
  // Pip via conda run (no direct pip/pip3)
  "^/home/devuser/miniforge3/bin/conda run -n my-env.*pip.*$",
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
   * Check if a server is enabled for use
   */
  private isServerEnabled(name: string): boolean {
    if (!this.enabledServers) {
      return true; // All servers enabled
    }
    return this.enabledServers.includes(name);
  }

  /**
   * Get specified connection configuration
   * Throws error if server is not enabled
   */
  public getConfig(name?: string): SSHConfig {
    const key = name || this.defaultName;
    
    // Check if server exists
    if (!this.configs[key]) {
      throw new Error(`SSH configuration for '${key}' not set`);
    }
    
    // Check if server is enabled
    if (!this.isServerEnabled(key)) {
      throw new Error(`SSH server '${key}' is not enabled. Enabled servers: ${this.enabledServers?.join(", ") || "none"}`);
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
    const names = Object.keys(this.configs);
    for (const name of names) {
      await this.connect(name);
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
        reject(new Error(`SSH connection [${key}] failed: ${err.message}`));
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
            new Error(
              `Failed to create SOCKS proxy connection for [${key}]: ${
                (err as Error).message
              }`
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
            new Error(
              `Failed to read private key file for [${key}]: ${
                (err as Error).message
              }`
            )
          );
        }
      } else if (config.password) {
        sshConfig.password = config.password;
        Logger.log(`Using password authentication for [${key}]`, "info");
      } else {
        return reject(
          new Error(
            `No valid authentication method provided for [${key}] (password or private key)`
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
      throw new Error(`SSH client for '${key}' not connected`);
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
      throw new Error(`SSH client for '${key}' not initialized`);
    }
    return client;
  }

  /**
   * Check if an error is a connection-related error that can be retried
   * @private
   */
  private isConnectionError(error: Error): boolean {
    const msg = error.message.toLowerCase();
    return (
      msg.includes("not connected") ||
      msg.includes("connection") ||
      msg.includes("socket") ||
      msg.includes("timeout") ||
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
      
      // If it starts with rm, validate it properly
      if (trimmed.startsWith('rm ') || trimmed === 'rm') {
        const rmValidation = this.validateRmCommand(trimmed, safeDir);
        if (!rmValidation.valid) {
          Logger.log(`SECURITY: rm command blocked: ${rmValidation.reason}`, "error");
          return {
            isAllowed: false,
            reason: rmValidation.reason,
          };
        }
        // rm is valid and within safe directory - allow it
        Logger.log(`SECURITY: rm command allowed within safe directory (${safeDir}): ${command}`, "info");
        return { isAllowed: true };
      } else {
        // Destructive pattern detected somewhere in the command (chained, subshell, redirection, etc.)
        Logger.log(`SECURITY: Destructive pattern detected (${destructiveReason}): ${command}`, "error");
        return {
          isAllowed: false,
          reason: `Blocked destructive pattern: ${destructiveReason}. Command: "${command}"` ,
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
   * Execute SSH command (internal implementation without retry)
   * Returns combined stdout and stderr output with exit code information
   * @private
   */
  private async executeCommandInternal(
    cmdString: string,
    client: Client,
    timeout: number
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      let timeoutId: NodeJS.Timeout;

      // Cleanup function to clear timeout and prevent memory leaks
      const cleanup = () => {
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
      };

      // Execute command via SSH exec
      client.exec(
        cmdString,
        (err: Error | undefined, stream: ClientChannel) => {
          // Handle immediate execution errors
          if (err) {
            cleanup();
            reject(new Error(`Command execution error: ${err.message}`));
            return;
          }

          // Initialize data buffers for stdout and stderr
          let stdout = "";
          let stderr = "";

          // Set up event listeners for command output streams
          stream.on("data", (chunk: Buffer) => (stdout += chunk.toString())); // Collect stdout data
          stream.stderr.on(
            "data",
            (chunk: Buffer) => (stderr += chunk.toString()) // Collect stderr data
          );

          // Handle command completion and exit code
          stream.on("close", (code: number) => {
            cleanup();
            
            // Build combined output with both stdout and stderr
            let result = "";
            
            if (stdout.trim()) {
              result += stdout;
            }
            
            if (stderr.trim()) {
              // Add separator if we have both stdout and stderr
              if (result) {
                result += "\n";
              }
              result += `[STDERR]\n${stderr}`;
            }
            
            // Add exit code info if command failed (non-zero exit)
            if (code !== 0 && code !== null) {
              if (result) {
                result += "\n";
              }
              result += `[EXIT CODE: ${code}]`;
            }
            
            // If no output at all, provide a message
            if (!result.trim()) {
              result = code === 0 
                ? "(Command completed successfully with no output)" 
                : `(Command exited with code ${code} and no output)`;
            }
            
            resolve(result);
          });

          // Handle stream errors during execution
          stream.on("error", (err: Error) => {
            cleanup();
            reject(new Error(`Stream error: ${err.message}`));
          });

          // Set timeout for command execution
          timeoutId = setTimeout(() => {
            cleanup();
            try {
              // Send SIGKILL to forcefully terminate the remote process
              // signal() sends a signal to the remote process
              stream.signal("KILL");
            } catch (e) {
              // Ignore errors when sending signal
            }
            try {
              // Close the stream to release resources
              stream.close();
            } catch (e) {
              // Ignore errors when closing streams during timeout
            }
            reject(new Error(`Command timeout: execution exceeded ${timeout}ms limit. Remote process killed.`));
          }, timeout);
        }
      );
    });
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
    options: { timeout?: number; maxRetries?: number } = {}
  ): Promise<string> {
    // Validate command input and security
    const validationResult = this.validateCommand(cmdString, name);
    if (!validationResult.isAllowed) {
      throw new Error(`Command validation failed: ${validationResult.reason}`);
    }

    const timeout = options.timeout || 30000; // Default 30 seconds timeout
    const maxRetries = options.maxRetries ?? 2; // Default 2 retries
    const key = name || this.defaultName;
    
    let lastError: Error | null = null;
    
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        // Ensure SSH connection is established
        const client = await this.ensureConnected(name);
        
        // Execute command
        const result = await this.executeCommandInternal(cmdString, client, timeout);
        
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
      onProgress?: (chunk: string) => void;
    } = {}
  ): Promise<string> {
    // Validate command input and security
    const validationResult = this.validateCommand(cmdString, name);
    if (!validationResult.isAllowed) {
      throw new Error(`Command validation failed: ${validationResult.reason}`);
    }

    const timeout = options.timeout || 300000; // Default 5 minutes for streaming
    const maxRetries = options.maxRetries ?? 2; // Default 2 retries
    const key = name || this.defaultName;

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        // Ensure SSH connection is established
        const client = await this.ensureConnected(name);

        // Execute command with streaming
        const result = await this.executeCommandStreamInternal(
          cmdString,
          client,
          timeout,
          options.onProgress
        );

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
   * Execute SSH command with streaming (internal implementation)
   * Streams stdout/stderr chunks to the onProgress callback in real-time
   * @private
   */
  private async executeCommandStreamInternal(
    cmdString: string,
    client: Client,
    timeout: number,
    onProgress?: (chunk: string) => void
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      let timeoutId: NodeJS.Timeout;

      const cleanup = () => {
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
      };

      client.exec(
        cmdString,
        (err: Error | undefined, stream: ClientChannel) => {
          if (err) {
            cleanup();
            reject(new Error(`Command execution error: ${err.message}`));
            return;
          }

          // Initialize data buffers for stdout and stderr
          let stdout = "";
          let stderr = "";

          // Stream stdout chunks in real-time
          stream.on("data", (chunk: Buffer) => {
            const text = chunk.toString();
            stdout += text;
            // Send progress notification with the output chunk
            if (onProgress) {
              onProgress(text);
            }
          });

          // Stream stderr chunks in real-time
          stream.stderr.on("data", (chunk: Buffer) => {
            const text = chunk.toString();
            stderr += text;
            // Send progress notification with stderr prefix
            if (onProgress) {
              onProgress(`[STDERR] ${text}`);
            }
          });

          // Handle command completion and exit code
          stream.on("close", (code: number) => {
            cleanup();

            // Build combined output with both stdout and stderr
            let result = "";

            if (stdout.trim()) {
              result += stdout;
            }

            if (stderr.trim()) {
              if (result) {
                result += "\n";
              }
              result += `[STDERR]\n${stderr}`;
            }

            // Add exit code info if command failed (non-zero exit)
            if (code !== 0 && code !== null) {
              if (result) {
                result += "\n";
              }
              result += `[EXIT CODE: ${code}]`;
            }

            // If no output at all, provide a message
            if (!result.trim()) {
              result =
                code === 0
                  ? "(Command completed successfully with no output)"
                  : `(Command exited with code ${code} and no output)`;
            }

            resolve(result);
          });

          // Handle stream errors during execution
          stream.on("error", (err: Error) => {
            cleanup();
            reject(new Error(`Stream error: ${err.message}`));
          });

          // Set timeout for command execution
          timeoutId = setTimeout(() => {
            cleanup();
            try {
              // Send SIGKILL to forcefully terminate the remote process
              stream.signal("KILL");
            } catch (e) {
              // Ignore errors when sending signal
            }
            try {
              stream.close();
            } catch (e) {
              // Ignore errors when closing streams during timeout
            }
            reject(new Error(`Command timeout: execution exceeded ${timeout}ms limit. Remote process killed.`));
          }, timeout);
        }
      );
    });
  }

  /**
   * Upload file
   */
  private validateLocalPath(localPath: string): string {
    const resolvedPath = path.resolve(localPath);
    const workingDir = process.cwd();
    if (!resolvedPath.startsWith(workingDir)) {
      throw new Error(
        `Path traversal detected. Local path must be within the working directory.`
      );
    }
    return resolvedPath;
  }

  /**
   * Upload file
   */
  public async upload(
    localPath: string,
    remotePath: string,
    name?: string
  ): Promise<string> {
    const validatedLocalPath = this.validateLocalPath(localPath);
    const client = await this.ensureConnected(name);

    return new Promise<string>((resolve, reject) => {
      client.sftp((err: Error | undefined, sftp: SFTPWrapper) => {
        if (err) {
          return reject(new Error(`SFTP connection failed: ${err.message}`));
        }

        const readStream = fs.createReadStream(validatedLocalPath);
        const writeStream = sftp.createWriteStream(remotePath);

        const cleanup = () => {
          sftp.end();
        };

        writeStream.on("close", () => {
          cleanup();
          resolve("File uploaded successfully");
        });

        writeStream.on("error", (err: Error) => {
          cleanup();
          reject(new Error(`File upload failed: ${err.message}`));
        });

        readStream.on("error", (err: Error) => {
          cleanup();
          reject(new Error(`Failed to read local file: ${err.message}`));
        });

        readStream.pipe(writeStream);
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
    const validatedLocalPath = this.validateLocalPath(localPath);
    const client = await this.ensureConnected(name);

    return new Promise<string>((resolve, reject) => {
      client.sftp((err: Error | undefined, sftp: SFTPWrapper) => {
        if (err) {
          return reject(new Error(`SFTP connection failed: ${err.message}`));
        }

        const readStream = sftp.createReadStream(remotePath);
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
          reject(new Error(`Failed to save file: ${err.message}`));
        });

        readStream.on("error", (err: Error) => {
          cleanup();
          reject(new Error(`File download failed: ${err.message}`));
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
}
