import { Client, ClientChannel } from "ssh2";
import type { SFTPWrapper, TransferOptions } from "ssh2";
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

const CONNECTION_RESET_FIELDS: Array<keyof SSHConfig> = [
  "host",
  "port",
  "username",
  "password",
  "privateKey",
  "passphrase",
  "agent",
  "identitiesOnly",
  "authOptional",
  "socksProxy",
  "jumpHost",
];

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

export const BUILT_IN_DESTRUCTIVE_GUARDS: Array<{ regex: RegExp; reason: string }> = [
  { regex: /(?<![0-9])>\s*\/(?!dev\/null)/, reason: "output redirection to absolute path" },
  { regex: />\s*~/, reason: "output redirection to home path" },
];

type SshDebugSink = (line: string) => void;
type AcquiredSshClient = { client: Client; close: () => void };
type SshClientPurpose = "command" | "sftp";
type SshAcquireOptions = {
  reuseConnection?: boolean;
  timeout?: number;
  debug?: SshDebugSink;
  purpose?: SshClientPurpose;
};
type SftpOptions = {
  reuseConnection?: boolean;
  timeout?: number;
  vvv?: boolean;
  fast?: boolean;
  sftpConcurrency?: number;
  chunkSize?: number;
};

/**
 * SSH Connection Manager class
 */
export class SSHConnectionManager {
  private static instance: SSHConnectionManager;
  private static readonly CLOSED_CLIENT_ERROR_SINK = () => {};
  private clients: Map<string, Client> = new Map();
  private configs: SshConnectionConfigMap = {};
  private connected: Map<string, boolean> = new Map();
  private statusCache: Map<string, ServerStatus> = new Map();
  private connectionGenerations: Map<string, number> = new Map();
  private pendingClients: Map<string, Client> = new Map();
  // In-flight connect() promises, keyed by server name. Used to dedupe
  // concurrent connect attempts so we never create two SSH clients for the
  // same server and leak the loser.
  private connecting: Map<string, Promise<void>> = new Map();
  // Dedicated tunneling clients for targets that use a `jumpHost`. Keyed by
  // target server name (NOT jump name), so each target that jumps through the
  // same bastion still gets its own jump client. This keeps tunnel lifetimes
  // tied 1:1 to the target connection and avoids cross-target interference.
  private jumpClients: Map<string, Client[]> = new Map();
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

    // Only single-server deployments have a meaningful "default". When >1
    // server is enabled, every tool call must specify connectionName
    // (enforced by resolveServer), so a default would just hide bugs.
    const effectiveNames = enabledServers && enabledServers.length > 0
      ? enabledServers
      : Object.keys(configs);
    if (effectiveNames.length === 1) {
      this.defaultName = effectiveNames[0];
    } else {
      this.defaultName = "";
    }

    if (this.enabledServers) {
      Logger.log(`Enabled servers: ${this.enabledServers.join(", ")}`, "info");
      if (this.defaultName) {
        Logger.log(`Default server: ${this.defaultName}`, "info");
      }
    }
  }

  /**
   * Replace the full config map during hot-reload. Connections whose host,
   * port, username, authentication, or proxy settings changed are closed so
   * the next tool call reconnects with the fresh OpenSSH/YAML values.
   */
  public replaceConfig(
    configs: SshConnectionConfigMap,
    enabledServers?: string[],
  ): void {
    const previous = this.configs;

    // Pass 1: servers whose own connection fields changed (or that vanished).
    const directlyChanged = new Set<string>();
    for (const [name, oldConfig] of Object.entries(previous)) {
      const nextConfig = configs[name];
      if (!nextConfig || this.connectionFieldsChanged(oldConfig, nextConfig)) {
        directlyChanged.add(name);
      }
    }

    // Pass 2: a target must ALSO reset if any hop in its jump chain directly
    // changed — otherwise it keeps tunneling through a stale intermediate hop.
    // Walk both the old and new chains so topology shifts (added/removed hops)
    // are covered too.
    const toReset = new Set<string>(directlyChanged);
    for (const name of Object.keys(previous)) {
      if (toReset.has(name)) continue;
      if (
        this.jumpChainTouchesChanged(name, previous, directlyChanged) ||
        this.jumpChainTouchesChanged(name, configs, directlyChanged)
      ) {
        toReset.add(name);
      }
    }

    this.closeClientSet(toReset, true);

    this.setConfig(configs, enabledServers);
    Logger.log(
      `Hot-reloaded SSH config: ${Object.keys(configs).length} server(s), ` +
      `${toReset.size} connection(s) reset`,
      "info",
    );
  }

  /**
   * Walk `name`'s jump chain in `configMap` and report whether any hop is in the
   * `changed` set. Guards against cycles defensively (config load rejects them).
   * @private
   */
  private jumpChainTouchesChanged(
    name: string,
    configMap: SshConnectionConfigMap,
    changed: Set<string>,
  ): boolean {
    const seen = new Set<string>([name]);
    let hop = configMap[name]?.jumpHost;
    while (hop !== undefined) {
      if (changed.has(hop)) return true;
      if (seen.has(hop)) break;
      seen.add(hop);
      hop = configMap[hop]?.jumpHost;
    }
    return false;
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

  private connectionFieldsChanged(oldConfig: SSHConfig, nextConfig: SSHConfig): boolean {
    return CONNECTION_RESET_FIELDS.some((key) => oldConfig[key] !== nextConfig[key]);
  }

  private closeClient(name: string, bumpGeneration = false): void {
    if (bumpGeneration) {
      this.bumpConnectionGeneration(name);
    }
    const pendingClient = this.pendingClients.get(name);
    if (pendingClient) {
      try {
        pendingClient.end();
      } catch {
        // Ignore close errors for dead pending clients.
      }
      this.pendingClients.delete(name);
    }

    const client = this.clients.get(name);
    if (client) {
      try {
        client.end();
      } catch {
        // Ignore close errors for dead clients.
      }
      this.clients.delete(name);
    }
    this.teardownJumpChain(name);
    this.connected.set(name, false);
    this.connecting.delete(name);
  }

  private closeClientSet(names: Iterable<string>, bumpGeneration = true): void {
    for (const name of names) {
      this.closeClient(name, bumpGeneration);
      this.statusCache.delete(name);
    }
  }

  public closeConnection(name?: string): { requested: string; closed: string[] } {
    const key = this.resolveServer(name);
    this.getConfig(key);

    const affected = new Set<string>([key]);
    const changed = new Set<string>([key]);
    for (const target of Object.keys(this.configs)) {
      if (target === key) continue;
      if (this.jumpChainTouchesChanged(target, this.configs, changed)) {
        affected.add(target);
      }
    }

    this.closeClientSet(affected, true);

    return {
      requested: key,
      closed: Array.from(affected),
    };
  }

  private bumpConnectionGeneration(name: string): void {
    this.connectionGenerations.set(
      name,
      (this.connectionGenerations.get(name) ?? 0) + 1,
    );
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
   * Connect to SSH with specified name.
   *
   * Concurrent callers for the same server share a single in-flight promise,
   * so we never create two SSH clients and leak the loser.
   */
  public async connect(name?: string, timeout?: number): Promise<void> {
    const key = name || this.defaultName;
    if (this.connected.get(key) && this.clients.get(key)) {
      return;
    }
    const inFlight = this.connecting.get(key);
    if (inFlight) {
      return inFlight;
    }
    let trackedPromise!: Promise<void>;
    trackedPromise = this.doConnect(key, timeout).finally(() => {
      if (this.connecting.get(key) === trackedPromise) {
        this.connecting.delete(key);
      }
    });
    this.connecting.set(key, trackedPromise);
    return trackedPromise;
  }

  /**
   * Actual SSH connect implementation. Callers must go through `connect()`
   * so concurrent requests are deduped.
   * @private
   */
  private async doConnect(key: string, timeout?: number): Promise<void> {
    const config = this.getConfig(key);
    const client = new Client();
    const generation = this.connectionGenerations.get(key) ?? 0;
    const connectTimeout = this.normalizeConnectTimeout(timeout);
    this.pendingClients.set(key, client);
    try {
      await new Promise<void>(async (resolve, reject) => {
        client.on("ready", () => {
          if ((this.connectionGenerations.get(key) ?? 0) !== generation) {
            try {
              client.end();
            } catch {
              // Ignore stale-client close errors.
          }
          reject(new ToolError(
            "SSH_CONNECTION_FAILED",
            `SSH connection [${key}] was superseded by a config reload`,
            true,
          ));
            return;
          }
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
        if ((this.connectionGenerations.get(key) ?? 0) === generation) {
          this.connected.set(key, false);
        }
        reject(new ToolError("SSH_CONNECTION_FAILED", `SSH connection [${key}] failed: ${err.message}`, true));
      });
      client.on("close", () => {
        if (
          (this.connectionGenerations.get(key) ?? 0) === generation &&
          this.clients.get(key) === client
        ) {
          this.connected.set(key, false);
        }
        Logger.log(`SSH connection [${key}] closed`, "info");
      });
      const sshConfig: any = {
        host: config.host,
        port: config.port,
        username: config.username,
      };
      if (connectTimeout) {
        sshConfig.readyTimeout = connectTimeout;
      }
      // Keepalive on the long-lived cached connection: ssh2 probes the peer so a
      // silently-dead connection surfaces as a close/error event (flipping the
      // connected flag) and self-heals on the next reuse, instead of only being
      // discovered when a later command hangs opening a channel.
      Object.assign(sshConfig, this.resolveKeepalive(config));
      const agent = config.agent === false
        ? undefined
        : config.agent || (config.identitiesOnly ? undefined : process.env.SSH_AUTH_SOCK);
      if (agent) {
        sshConfig.agent = agent;
      }
      // Add jump-host tunnel if provided. Mutually exclusive with socksProxy
      // (enforced at config load time).
      if (config.jumpHost) {
        try {
          const sock = await this.withConnectionTimeout(
            this.openJumpTunnel(key, config, undefined, connectTimeout),
            connectTimeout,
            `jump tunnel for [${key}] via '${config.jumpHost}'`,
            undefined,
            () => this.teardownJumpChain(key),
            (stream) => {
              try {
                (stream as NodeJS.ReadWriteStream & { destroy?: () => void }).destroy?.();
              } catch {
                // Ignore late stream cleanup errors.
              }
              this.teardownJumpChain(key);
            },
          );
          sshConfig.sock = sock;
          Logger.log(
            `Using jump host '${config.jumpHost}' for [${key}]`,
            "info",
          );
        } catch (err) {
          // A multi-hop chain may have partially connected (e.g. an inner hop
          // came up but a later hop or the final forwardOut failed) before
          // this rejected. Those already-connected hops were recorded in
          // jumpClients as each one came up, so tear them down now instead of
          // leaking live SSH sessions until the next connect attempt.
          this.teardownJumpChain(key);
          return reject(
            new ToolError(
              "SSH_CONNECTION_FAILED",
              `Failed to open jump tunnel for [${key}] via '${config.jumpHost}': ${(err as Error).message}`,
              true,
            ),
          );
        }
      }
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
          const { socket } = await this.withConnectionTimeout(
            SocksClient.createConnection({
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
              timeout: connectTimeout,
            }),
            connectTimeout,
            `SOCKS proxy connection for [${key}]`,
            undefined,
            undefined,
            (event) => {
              try {
                event.socket.destroy();
              } catch {
                // Ignore late socket cleanup errors.
              }
            },
          );

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
      } else if (agent || config.authOptional) {
        Logger.log(
          `Using SSH agent/default authentication for [${key}]`,
          "info",
        );
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
    } finally {
      if (this.pendingClients.get(key) === client) {
        this.pendingClients.delete(key);
      }
    }
    if ((this.connectionGenerations.get(key) ?? 0) !== generation) {
      try {
        client.end();
      } catch {
        // Ignore stale-client close errors.
      }
      throw new ToolError(
        "SSH_CONNECTION_FAILED",
        `SSH connection [${key}] was superseded by a config reload`,
        true,
      );
    }
    this.clients.set(key, client);
  }

  private async acquireSshClient(
    key: string,
    options: SshAcquireOptions = {},
  ): Promise<AcquiredSshClient> {
    const reuseConnection = options.reuseConnection !== false;
    const purpose = options.purpose ?? "command";
    if (reuseConnection) {
      const client = await this.ensureConnected(key, options.timeout);
      options.debug?.(
        `[mcp] using cached SSH connection for [${key}]; set reuseConnection=false to capture SSH handshake debug`,
      );
      return { client, close: () => {} };
    }
    if (purpose === "command") {
      return this.connectCommandClient(key, options.timeout ?? 30000, options.debug);
    }
    return this.connectOneShotClient(key, options.timeout ?? 30000, options.debug, purpose);
  }

  /**
   * Compatibility wrapper for tests and existing command call sites.
   */
  private async connectCommandClient(
    key: string,
    timeout: number,
    debug?: SshDebugSink,
  ): Promise<AcquiredSshClient> {
    return this.connectOneShotClient(key, timeout, debug, "command");
  }

  /**
   * Open a one-shot SSH client for a single operation. Used when the caller
   * disables connection reuse after a timeout or when a fresh TCP/SSH
   * handshake is more important than latency.
   */
  private async connectOneShotClient(
    key: string,
    timeout: number,
    debug?: SshDebugSink,
    purpose: SshClientPurpose = "command",
  ): Promise<AcquiredSshClient> {
    const config = this.getConfig(key);
    const client = new Client();
    const jumpChainKey = `__${purpose}__:${key}:${Date.now()}:${crypto.randomBytes(4).toString("hex")}`;
    const connectTimeout = this.normalizeConnectTimeout(timeout) ?? 30000;
    let settled = false;
    let closed = false;

    const onLateError = (err: Error) => {
      if (!settled) {
        return;
      }
      debug?.(`[mcp] one-shot SSH client emitted error after ready/settle: ${err.message}`);
      Logger.log(
        `One-shot SSH ${purpose} client [${key}] emitted error after settle: ${err.message}`,
        "error",
      );
    };
    client.on("error", onLateError);

    const close = () => {
      if (closed) {
        return;
      }
      closed = true;
      client.on("error", SSHConnectionManager.CLOSED_CLIENT_ERROR_SINK);
      client.removeListener("error", onLateError);
      try {
        client.end();
      } catch {
        // Ignore close errors for per-command clients.
      }
      this.connected.delete(jumpChainKey);
      this.connecting.delete(jumpChainKey);
      this.teardownJumpChain(jumpChainKey);
    };

    try {
      const sshConfig: any = {
        host: config.host,
        port: config.port,
        username: config.username,
        readyTimeout: connectTimeout,
      };
      if (debug) {
        sshConfig.debug = (line: string) => debug(`[ssh2] ${line}`);
      }
      const agent = config.agent === false
        ? undefined
        : config.agent || (config.identitiesOnly ? undefined : process.env.SSH_AUTH_SOCK);
      if (agent) {
        sshConfig.agent = agent;
      }

      if (config.jumpHost) {
        try {
          sshConfig.sock = await this.withConnectionTimeout(
            this.openJumpTunnel(jumpChainKey, config, debug, connectTimeout),
            connectTimeout,
            `one-shot jump tunnel for [${key}] via '${config.jumpHost}'`,
            debug,
            () => this.teardownJumpChain(jumpChainKey),
            (stream) => {
              try {
                (stream as NodeJS.ReadWriteStream & { destroy?: () => void }).destroy?.();
              } catch {
                // Ignore late stream cleanup errors.
              }
              this.teardownJumpChain(jumpChainKey);
            },
          );
          Logger.log(
            `Using one-shot jump host '${config.jumpHost}' for ${purpose} on [${key}]`,
            "info",
          );
        } catch (err) {
          this.teardownJumpChain(jumpChainKey);
          throw new ToolError(
            "SSH_CONNECTION_FAILED",
            `Failed to open one-shot jump tunnel for ${purpose} [${key}] via '${config.jumpHost}': ${(err as Error).message}`,
            true,
          );
        }
      }

      if (config.socksProxy) {
        try {
          const proxyUrl = new URL(config.socksProxy);
          const { socket } = await this.withConnectionTimeout(
            SocksClient.createConnection({
              proxy: {
                host: proxyUrl.hostname,
                port: parseInt(proxyUrl.port, 10),
                type: 5,
              },
              command: "connect",
              destination: {
                host: config.host,
                port: config.port,
              },
              timeout: connectTimeout,
            }),
            connectTimeout,
            `SOCKS proxy connection for one-shot command [${key}]`,
            debug,
            undefined,
            (event) => {
              try {
                event.socket.destroy();
              } catch {
                // Ignore late socket cleanup errors.
              }
            },
          );
          sshConfig.sock = socket;
        } catch (err) {
          throw new ToolError(
            "SSH_CONNECTION_FAILED",
            `Failed to create SOCKS proxy connection for one-shot command [${key}]: ${(err as Error).message}`,
            true,
          );
        }
      }

      if (config.privateKey) {
        try {
          sshConfig.privateKey = fs.readFileSync(config.privateKey, "utf8");
          if (config.passphrase) {
            sshConfig.passphrase = config.passphrase;
          }
        } catch (err) {
          throw new ToolError(
            "LOCAL_FILE_READ_FAILED",
            `Failed to read private key file for [${key}]: ${(err as Error).message}`,
            false,
          );
        }
      } else if (config.password) {
        sshConfig.password = config.password;
      } else if (agent || config.authOptional) {
        Logger.log(
          `Using SSH agent/default authentication for one-shot ${purpose} [${key}]`,
          "info",
        );
      } else {
        throw new ToolError(
          "SSH_AUTHENTICATION_MISSING",
          `No valid authentication method provided for [${key}] (password or private key)`,
          false,
        );
      }

      await new Promise<void>((resolve, reject) => {
        const done = (err?: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeoutId);
          client.removeListener("ready", onReady);
          client.removeListener("error", onError);
          client.removeListener("close", onClose);
          if (err) reject(err);
          else resolve();
        };
        const onReady = () => done();
        const onError = (err: Error) => done(new ToolError(
          "SSH_CONNECTION_FAILED",
          `SSH ${purpose} connection [${key}] failed: ${err.message}`,
          true,
        ));
        const onClose = () => done(new ToolError(
          "SSH_CONNECTION_FAILED",
          `SSH ${purpose} connection [${key}] closed before ready`,
          true,
        ));
        const timeoutId = setTimeout(() => {
          done(new ToolError(
            "SSH_CONNECTION_FAILED",
            `SSH ${purpose} connection [${key}] timed out after ${connectTimeout}ms`,
            true,
          ));
          close();
        }, connectTimeout);

        debug?.(`[mcp] opening one-shot SSH ${purpose} connection for [${key}]`);
        client.once("ready", onReady);
        client.once("error", onError);
        client.once("close", onClose);
        client.connect(sshConfig);
      });

      Logger.log(`Opened one-shot SSH ${purpose} connection for [${key}]`, "info");
      return { client, close };
    } catch (err) {
      close();
      throw err;
    }
  }

  private withConnectionTimeout<T>(
    operation: Promise<T>,
    timeoutMs: number | undefined,
    description: string,
    debug?: SshDebugSink,
    onTimeout?: () => void,
    onLateResolve?: (value: T) => void,
  ): Promise<T> {
    if (!timeoutMs || timeoutMs <= 0) {
      return operation;
    }

    return new Promise<T>((resolve, reject) => {
      let settled = false;
      let timedOut = false;
      const timeoutId = setTimeout(() => {
        if (settled) return;
        settled = true;
        timedOut = true;
        debug?.(`[mcp] ${description} timed out after ${timeoutMs}ms`);
        try {
          onTimeout?.();
        } catch {
          // Ignore cleanup failures after timeout.
        }
        reject(new ToolError(
          "SSH_CONNECTION_FAILED",
          `${description} timed out after ${timeoutMs}ms`,
          true,
        ));
      }, timeoutMs);

      operation.then(
        (value) => {
          if (timedOut) {
            try {
              onLateResolve?.(value);
            } catch {
              // Ignore cleanup failures for a late result.
            }
            return;
          }
          if (settled) return;
          settled = true;
          clearTimeout(timeoutId);
          resolve(value);
        },
        (err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeoutId);
          reject(err);
        },
      );
    });
  }

  /** Default ssh2 keepalive probe interval (ms) when a server doesn't set one. */
  private static readonly DEFAULT_KEEPALIVE_INTERVAL_MS = 15_000;
  /** Default max unanswered keepalive probes before ssh2 declares death. */
  private static readonly DEFAULT_KEEPALIVE_COUNT_MAX = 3;
  /** Default short timeout (ms) for the exec-channel-OPEN phase. */
  private static readonly DEFAULT_CHANNEL_OPEN_TIMEOUT_MS = 10_000;

  /**
   * Resolve ssh2 keepalive options for a server. Keepalive is ON by default so a
   * silently-dead cached connection is detected proactively; a server can tune
   * the interval/count or disable it entirely with keepaliveInterval <= 0.
   * Returns an empty object when disabled (no keepalive keys on the ssh config).
   */
  private resolveKeepalive(config: SSHConfig): {
    keepaliveInterval?: number;
    keepaliveCountMax?: number;
  } {
    const interval =
      typeof config.keepaliveInterval === "number" && Number.isFinite(config.keepaliveInterval)
        ? config.keepaliveInterval
        : SSHConnectionManager.DEFAULT_KEEPALIVE_INTERVAL_MS;
    if (interval <= 0) {
      return {}; // Explicitly disabled.
    }
    const countMax =
      typeof config.keepaliveCountMax === "number" &&
      Number.isFinite(config.keepaliveCountMax) &&
      config.keepaliveCountMax > 0
        ? config.keepaliveCountMax
        : SSHConnectionManager.DEFAULT_KEEPALIVE_COUNT_MAX;
    return { keepaliveInterval: interval, keepaliveCountMax: countMax };
  }

  /**
   * Resolve the short exec-channel-open timeout (ms) for a server. Kept separate
   * from the command run timeout so a dead reused connection fails fast on open.
   */
  private resolveChannelOpenTimeout(config: SSHConfig): number {
    const t = config.channelOpenTimeout;
    return typeof t === "number" && Number.isFinite(t) && t > 0
      ? t
      : SSHConnectionManager.DEFAULT_CHANNEL_OPEN_TIMEOUT_MS;
  }

  private normalizeConnectTimeout(timeout?: number): number | undefined {
    if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0) {
      return undefined;
    }
    return Math.max(1, timeout);
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

      const clear = () => {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
      };

      const arm = () => {
        clear();
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
        if (!settled) arm();
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
   * Open a TCP tunnel from the target's jump chain to `config.host:config.port`
   * and return the duplex stream to be used as `sock` for the target SSH client.
   *
   * Supports chained jumps to any depth: `target -> J1 -> J2 -> ...` where each
   * hop's `jumpHost` names the next hop. The chain is built innermost-first —
   * the deepest, directly-reachable hop connects normally, and each outer hop is
   * connected through the previous hop's forwarded stream.
   *
   * Every hop's SSH client is cached (in order) under the target key so the whole
   * chain can be torn down with the target connection. A hop's own client tracked
   * in `this.clients` is intentionally NOT reused — jump usage and direct tool
   * calls against a bastion stay isolated.
   * @private
   */
  private async openJumpTunnel(
    targetKey: string,
    config: SSHConfig,
    debug?: SshDebugSink,
    timeout?: number,
  ): Promise<NodeJS.ReadWriteStream> {
    // Tear down any stale jump chain for this target before opening a new one.
    this.teardownJumpChain(targetKey);
    this.jumpClients.set(targetKey, []);

    const jumpClient = await this.connectJumpChain(targetKey, config.jumpHost!, debug, timeout);
    return this.forwardOutStream(jumpClient, config.host, config.port, timeout);
  }

  /**
   * Recursively connect the SSH client for `jumpName`, tunneling through its own
   * `jumpHost` first when set. Each connected hop is appended (innermost-first)
   * to the target's jump-client chain. Returns the connected client for this hop.
   * @private
   */
  private async connectJumpChain(
    targetKey: string,
    jumpName: string,
    debug?: SshDebugSink,
    timeout?: number,
  ): Promise<Client> {
    const jumpConfig = this.configs[jumpName];
    if (!jumpConfig) {
      // Should be caught at config load, but guard at runtime too.
      throw new Error(`jump host '${jumpName}' not found in config`);
    }

    // If this hop is itself reached through another jump, build that inner
    // tunnel first and hand its stream to this hop as `sock`.
    let sock: NodeJS.ReadWriteStream | undefined;
    if (jumpConfig.jumpHost) {
      const innerClient = await this.connectJumpChain(targetKey, jumpConfig.jumpHost, debug, timeout);
      sock = await this.forwardOutStream(innerClient, jumpConfig.host, jumpConfig.port, timeout);
    }

    const jumpClient = await this.connectJumpClient(targetKey, jumpName, jumpConfig, sock, debug, timeout);
    const chain = this.jumpClients.get(targetKey);
    if (chain) {
      chain.push(jumpClient);
    } else {
      this.jumpClients.set(targetKey, [jumpClient]);
    }
    return jumpClient;
  }

  /**
   * Connect a single jump-host SSH client, optionally through `sock` (the stream
   * from the previous hop). Wires a close handler that tears the whole target
   * chain down so a dead hop surfaces as a clear failure on the next op.
   * @private
   */
  private connectJumpClient(
    targetKey: string,
    jumpName: string,
    jumpConfig: SSHConfig,
    sock: NodeJS.ReadWriteStream | undefined,
    debug?: SshDebugSink,
    timeout?: number,
  ): Promise<Client> {
    return new Promise<Client>((resolve, reject) => {
      const jumpClient = new Client();
      let settled = false;
      let timeoutId: NodeJS.Timeout | null = null;
      let closedErrorSinkInstalled = false;

      const installClosedErrorSink = () => {
        if (!closedErrorSinkInstalled) {
          closedErrorSinkInstalled = true;
          jumpClient.on("error", SSHConnectionManager.CLOSED_CLIENT_ERROR_SINK);
        }
      };
      const onLateError = (err: Error) => {
        Logger.log(
          `Jump SSH client '${jumpName}' for [${targetKey}] emitted error after ready: ${err.message}`,
          "error",
        );
        this.teardownTargetViaJump(targetKey);
      };

      const cleanup = () => {
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }
        jumpClient.removeListener("ready", onReady);
        jumpClient.removeListener("error", onError);
      };
      const done = (err?: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (err) {
          installClosedErrorSink();
          reject(err);
          return;
        }
        jumpClient.on("error", onLateError);
        resolve(jumpClient);
      };
      const onReady = () => done();
      const onError = (err: Error) => {
        done(new Error(`jump SSH connect failed for '${jumpName}': ${err.message}`));
      };

      jumpClient.on("ready", onReady);
      jumpClient.on("error", onError);
      jumpClient.on("close", () => {
        if (!settled) {
          done(new Error(`jump SSH connect closed for '${jumpName}' before ready`));
          return;
        }
        jumpClient.removeListener("error", onError);
        jumpClient.removeListener("error", onLateError);
        installClosedErrorSink();
        // If any hop dies, kill the target too so callers get a clear failure on
        // the next op and reconnect through a fresh chain.
        this.teardownTargetViaJump(targetKey);
      });
      const jumpSsh: any = {
        host: jumpConfig.host,
        port: jumpConfig.port,
        username: jumpConfig.username,
      };
      // Keepalive on the long-lived jump hop too, so a dead bastion is detected
      // proactively and tears down the target chain instead of hanging later.
      Object.assign(jumpSsh, this.resolveKeepalive(jumpConfig));
      if (sock) {
        jumpSsh.sock = sock;
      }
      if (timeout) {
        jumpSsh.readyTimeout = timeout;
        timeoutId = setTimeout(() => {
          done(new Error(`jump SSH connect timed out for '${jumpName}' after ${timeout}ms`));
          try {
            jumpClient.end();
          } catch {
            // Ignore close errors after timeout.
          }
        }, timeout);
      }
      if (debug) {
        jumpSsh.debug = (line: string) => debug(`[ssh2:${jumpName}] ${line}`);
      }
      const jumpAgent = jumpConfig.agent === false
        ? undefined
        : jumpConfig.agent || (jumpConfig.identitiesOnly ? undefined : process.env.SSH_AUTH_SOCK);
      if (jumpAgent) {
        jumpSsh.agent = jumpAgent;
      }
      if (jumpConfig.privateKey) {
        try {
          jumpSsh.privateKey = fs.readFileSync(jumpConfig.privateKey, "utf8");
          if (jumpConfig.passphrase) jumpSsh.passphrase = jumpConfig.passphrase;
        } catch (err) {
          return reject(new Error(`read jump private key failed: ${(err as Error).message}`));
        }
      } else if (jumpConfig.password) {
        jumpSsh.password = jumpConfig.password;
      } else if (jumpAgent || jumpConfig.authOptional) {
        Logger.log(
          `Using SSH agent/default authentication for jump host '${jumpName}'`,
          "info",
        );
      } else {
        return reject(new Error(`jump host '${jumpName}' has no password, privateKey, or default authentication`));
      }
      jumpClient.connect(jumpSsh);
    });
  }

  /**
   * Open a forwarded TCP stream from `client` to `host:port`.
   * @private
   */
  private forwardOutStream(
    client: Client,
    host: string,
    port: number,
    timeout?: number,
  ): Promise<NodeJS.ReadWriteStream> {
    return new Promise<NodeJS.ReadWriteStream>((resolve, reject) => {
      let settled = false;
      let timeoutId: NodeJS.Timeout | null = null;
      const done = (err?: Error | null, stream?: NodeJS.ReadWriteStream) => {
        if (settled) return;
        settled = true;
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
        if (err) {
          reject(err);
          return;
        }
        resolve(stream!);
      };
      if (timeout) {
        timeoutId = setTimeout(() => {
          done(new Error(`forwardOut to ${host}:${port} timed out after ${timeout}ms`));
        }, timeout);
      }
      client.forwardOut("127.0.0.1", 0, host, port, (err, ch) => {
        if (settled) {
          try {
            ch?.close();
          } catch {
            // Ignore cleanup failures for a late forwarded channel.
          }
          return;
        }
        done(err, ch as unknown as NodeJS.ReadWriteStream);
      });
    });
  }

  /**
   * End and forget every jump client in a target's chain (no target teardown).
   * @private
   */
  private teardownJumpChain(targetKey: string): void {
    const chain = this.jumpClients.get(targetKey);
    if (!chain) {
      return;
    }
    this.jumpClients.delete(targetKey);
    for (const client of chain) {
      try { client.end(); } catch { /* ignore */ }
    }
  }

  /**
   * Tear the target connection and its whole jump chain down together. Idempotent
   * so re-entrant close events (ending one hop closes the next) settle quietly.
   * @private
   */
  private teardownTargetViaJump(targetKey: string): void {
    const chain = this.jumpClients.get(targetKey);
    const target = this.clients.get(targetKey);
    if (!chain && !target) {
      return; // already torn down
    }
    this.connected.set(targetKey, false);
    if (target) {
      this.clients.delete(targetKey);
      try { target.end(); } catch { /* ignore */ }
    }
    this.teardownJumpChain(targetKey);
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
  private async ensureConnected(name?: string, timeout?: number): Promise<Client> {
    const key = name || this.defaultName;
    if (!this.connected.get(key) || !this.clients.get(key)) {
      const connectTimeout = this.normalizeConnectTimeout(timeout);
      await this.withConnectionTimeout(
        this.connect(key, timeout),
        connectTimeout,
        `cached SSH connection [${key}]`,
        undefined,
        () => this.closeClient(key, true),
      );
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

    return this.isConnectionShapedMessage(error.message);
  }

  private isConnectionShapedMessage(message: string): boolean {
    const msg = message.toLowerCase();
    return (
      msg.includes("not connected") ||
      msg.includes("connection") ||
      msg.includes("socket") ||
      msg.includes("econnreset") ||
      msg.includes("econnrefused") ||
      msg.includes("epipe") ||
      msg.includes("closed") ||
      msg.includes("end of stream") ||
      msg.includes("channel") ||
      msg.includes("no response from server") ||
      msg.includes("timed out")
    );
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
    const pendingClient = this.pendingClients.get(key);
    if (pendingClient) {
      try {
        pendingClient.end();
      } catch (e) {
        // Ignore errors when closing dead connection
      }
      this.pendingClients.delete(key);
    }
    this.bumpConnectionGeneration(key);
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
      logWriter?: OutputLogWriter;
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
        if (activeStream) {
          closeLateStream(activeStream);
        }
        settle(new ToolError(
          "SSH_CONNECTION_FAILED",
          `SSH connection ${event} while ${phase}${detail}`,
          true,
        ));
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
      try {
        debug?.(`[mcp] command attempt ${attempt + 1}/${maxRetries + 1} on [${key}], reuseConnection=${reuseConnection}`);
        const commandConnection = await this.acquireSshClient(key, {
          reuseConnection,
          timeout,
          debug,
          purpose: "command",
        });
        const client = commandConnection.client;

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
        
        // Check if this is a connection error that can be retried
        if (this.isConnectionError(lastError) && attempt < maxRetries) {
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
    options: {
      timeout?: number;
      maxRetries?: number;
      maxOutputBytes?: number;
      reuseConnection?: boolean;
      vvv?: boolean;
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
    const reuseConnection = options.reuseConnection !== false;
    const key = name || this.defaultName;
    const { collector: debugCollector, debug } = this.createDebugCollector(options.vvv === true);

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        debug?.(`[mcp] streaming command attempt ${attempt + 1}/${maxRetries + 1} on [${key}], reuseConnection=${reuseConnection}`);
        const commandConnection = await this.acquireSshClient(key, {
          reuseConnection,
          timeout,
          debug,
          purpose: "command",
        });
        const client = commandConnection.client;

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

        // Check if this is a connection error that can be retried
        if (this.isConnectionError(lastError) && attempt < maxRetries) {
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

        break;
      }
    }

    throw this.appendDebugToError(
      lastError || new Error("Streaming command execution failed after all retries"),
      debugCollector,
    );
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
    const mustReadPayload = skipIfIdentical || !fastUpload || isShellScript;
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
        const decision = await this.shouldSkipUpload(
          client,
          payload!,
          validatedRemotePath,
          isShellScript,
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
   * Disconnect SSH connection
   */
  public disconnect(): void {
    if (this.clients.size > 0) {
      for (const client of this.clients.values()) {
        client.end();
      }
      this.clients.clear();
    }
    if (this.jumpClients.size > 0) {
      for (const chain of this.jumpClients.values()) {
        for (const client of chain) {
          try { client.end(); } catch { /* ignore */ }
        }
      }
      this.jumpClients.clear();
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

      await this.pipeWithInactivityTimeout(
        srcSftp.createReadStream(validatedSourcePath),
        dstSftp.createWriteStream(validatedDestPath),
        this.transferStallTimeout(options?.timeout),
        `relay ${sourceName}:${validatedSourcePath} -> ${destName}:${validatedDestPath}`,
        debug,
        (err) => this.makeSftpError("Source read error", err),
        (err) => this.makeSftpError("Dest write error", err),
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
        `Transfer complete (streamed via SFTP, verified: ${verification.join(", ")}): ` +
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
   * Upload a local directory recursively to a remote server
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

    const results: string[] = [];

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
    options?: SftpOptions,
  ): Promise<string[]> {
    const resolvedName = name || this.defaultName;
    const resolvedLocal = this.validateLocalPath(localDir, resolvedName);
    const validatedRemoteDir = this.validateRemotePath(remoteDir, resolvedName);

    if (!fs.existsSync(resolvedLocal)) {
      fs.mkdirSync(resolvedLocal, { recursive: true });
    }

    const results: string[] = [];
    const entries = await this.listRemoteDir(validatedRemoteDir, resolvedName, options);

    for (const entry of entries) {
      if (entry.filename === "." || entry.filename === "..") continue;

      const remotePath = `${validatedRemoteDir}/${entry.filename}`;
      const localPath = path.join(localDir, entry.filename);

      if (entry.isDirectory) {
        const subResults = await this.downloadDirectory(remotePath, localPath, resolvedName, options);
        results.push(...subResults);
      } else {
        await this.download(remotePath, localPath, resolvedName, options);
        results.push(localPath);
      }
    }

    return results;
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
}
