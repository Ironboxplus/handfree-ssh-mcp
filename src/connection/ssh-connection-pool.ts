import { Client } from "ssh2";
import { SocksClient } from "socks";
import { SSHConfig, SshConnectionConfigMap, ServerStatus } from "../models/types.js";
import { Logger } from "../utils/logger.js";
import {
  collectSystemStatus,
  DEFAULT_STATUS_COLLECT_TIMEOUT_MS,
} from "../utils/status-collector.js";
import { ToolError } from "../utils/tool-error.js";
import fs from "fs";
import crypto from "crypto";

// PLAN.MD P0-04: extracted from SSHConnectionManager (src/services/ssh-connection-manager.ts),
// which now holds an instance of this class and delegates every connection-lifecycle
// public/internal call to it. This is a behavior-preserving extraction: the logic below
// is unchanged from the original methods (only 'private'->'public' visibility changed
// on the members SSHConnectionManager's facade needs to call, and self-references to
// the enclosing class's static constants were renamed to match the new class name).
//
// Owns: the SSH client cache and its generation/connected/status bookkeeping, server
// config storage and resolution, connect/reconnect/close lifecycle, one-shot and
// cached client acquisition, jump-host tunnel chains, and connection-shaped error
// classification. Does NOT own: background command tracking, output log
// configuration, or any transfer/archive/SFTP logic -- those remain on
// SSHConnectionManager (transfer/archive extraction is a later P0-04 step).

export type SshDebugSink = (line: string) => void;
export type AcquiredSshClient = { client: Client; close: () => void };
export type SshClientPurpose = "command" | "sftp";
export type SshAcquireOptions = {
  reuseConnection?: boolean;
  timeout?: number;
  debug?: SshDebugSink;
  purpose?: SshClientPurpose;
};

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

export class SshConnectionPool {
  private static readonly CLOSED_CLIENT_ERROR_SINK = () => {};
  public clients: Map<string, Client> = new Map();
  public configs: SshConnectionConfigMap = {};
  public connected: Map<string, boolean> = new Map();
  public statusCache: Map<string, ServerStatus> = new Map();
  public connectionGenerations: Map<string, number> = new Map();

  public pendingClients: Map<string, Client> = new Map();
  // In-flight connect() promises, keyed by server name. Used to dedupe
  // concurrent connect attempts so we never create two SSH clients for the
  // same server and leak the loser.
  public connecting: Map<string, Promise<void>> = new Map();
  // Dedicated tunneling clients for targets that use a `jumpHost`. Keyed by
  // target server name (NOT jump name), so each target that jumps through the
  // same bastion still gets its own jump client. This keeps tunnel lifetimes
  // tied 1:1 to the target connection and avoids cross-target interference.
  public jumpClients: Map<string, Client[]> = new Map();

  public defaultName: string = "default";
  public enabledServers: string[] | null = null; // null = all servers enabled

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

  private connectionFieldsChanged(oldConfig: SSHConfig, nextConfig: SSHConfig): boolean {
    return CONNECTION_RESET_FIELDS.some((key) => oldConfig[key] !== nextConfig[key]);
  }

  public closeClient(name: string, bumpGeneration = false): void {
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

  public closeClientIfCurrent(name: string, client: Client, bumpGeneration = false): void {
    if (this.clients.get(name) !== client) {
      return;
    }
    this.closeClient(name, bumpGeneration);
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
  public isServerEnabled(name: string): boolean {
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

        // 延迟执行系统状态收集，避免与用户的第一个命令竞争 SSH 通道。
        // Status collection is time-bounded (see DEFAULT_STATUS_COLLECT_TIMEOUT_MS)
        // and uses a single exec channel so a wedged remote probe (e.g. nvidia-smi)
        // cannot hang forever or exhaust MaxSessions and starve later tools.
        setTimeout(() => {
          // Bail out if this client was already replaced/closed.
          if (this.clients.get(key) !== client) {
            return;
          }
          collectSystemStatus(client, key, {
            timeoutMs: DEFAULT_STATUS_COLLECT_TIMEOUT_MS,
          })
            .then((status) => {
              if (this.clients.get(key) !== client) return;
              this.statusCache.set(key, status);
              Logger.log(
                `System status collected for [${key}]`,
                "info"
              );
            })
            .catch((error) => {
              if (this.clients.get(key) !== client) return;
              Logger.log(
                `Failed to collect system status for [${key}]: ${(error as Error).message}`,
                "error"
              );
              // Set basic status even if collection fails
              this.statusCache.set(key, {
                reachable: false,
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
      // For a jump target the SSH handshake runs over the tunnel and should be
      // fast; bound it by the short circuit-open timeout so a dead target behind a
      // live bastion fails fast instead of hanging the whole command timeout. Jump
      // targets always get the short bound (even when no explicit command timeout
      // was passed, e.g. a status refresh) so a dead peer never stalls on ssh2's
      // implicit default. Direct connections keep the full connect timeout.
      const circuitOpenTimeout = this.resolveCircuitOpenTimeout(config, connectTimeout);
      if (config.jumpHost) {
        sshConfig.readyTimeout = circuitOpenTimeout;
      } else if (connectTimeout) {
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
            this.openJumpTunnel(key, config, undefined, circuitOpenTimeout),
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

  public async acquireSshClient(
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
      client.on("error", SshConnectionPool.CLOSED_CLIENT_ERROR_SINK);
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
      // Bound a jump target's handshake-over-tunnel and the tunnel establishment
      // by the short circuit-open timeout so a dead reused bastion fails fast
      // instead of hanging up to the full command timeout. See doConnect.
      const circuitOpenTimeout = this.resolveCircuitOpenTimeout(config, connectTimeout);
      const sshConfig: any = {
        host: config.host,
        port: config.port,
        username: config.username,
        readyTimeout: config.jumpHost ? circuitOpenTimeout : connectTimeout,
      };
      Object.assign(sshConfig, this.resolveKeepalive(config));
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
            this.openJumpTunnel(jumpChainKey, config, debug, circuitOpenTimeout),
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

  public withConnectionTimeout<T>(
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
  private static readonly DEFAULT_KEEPALIVE_INTERVAL_MS = 5_000;
  /** Default max unanswered keepalive probes before ssh2 declares death. */
  private static readonly DEFAULT_KEEPALIVE_COUNT_MAX = 2;
  /** Default short timeout (ms) for the exec-channel-OPEN phase. */
  private static readonly DEFAULT_CHANNEL_OPEN_TIMEOUT_MS = 10_000;

  /**
   * Resolve ssh2 keepalive options for a server. Keepalive is ON by default so a
   * silently-dead cached connection is detected proactively; a server can tune
   * the interval/count or disable it entirely with keepaliveInterval <= 0.
   * Returns an empty object when disabled (no keepalive keys on the ssh config).
   */
  public resolveKeepalive(config: SSHConfig): {
    keepaliveInterval?: number;
    keepaliveCountMax?: number;
  } {
    const interval =
      typeof config.keepaliveInterval === "number" && Number.isFinite(config.keepaliveInterval)
        ? config.keepaliveInterval
        : SshConnectionPool.DEFAULT_KEEPALIVE_INTERVAL_MS;
    if (interval <= 0) {
      return {}; // Explicitly disabled.
    }
    const countMax =
      typeof config.keepaliveCountMax === "number" &&
      Number.isFinite(config.keepaliveCountMax) &&
      config.keepaliveCountMax > 0
        ? config.keepaliveCountMax
        : SshConnectionPool.DEFAULT_KEEPALIVE_COUNT_MAX;
    return { keepaliveInterval: interval, keepaliveCountMax: countMax };
  }

  /**
   * Resolve the short exec-channel-open timeout (ms) for a server. Kept separate
   * from the command run timeout so a dead reused connection fails fast on open.
   */
  public resolveChannelOpenTimeout(config: SSHConfig): number {
    const t = config.channelOpenTimeout;
    return typeof t === "number" && Number.isFinite(t) && t > 0
      ? t
      : SshConnectionPool.DEFAULT_CHANNEL_OPEN_TIMEOUT_MS;
  }

  /**
   * Resolve the short timeout (ms) that bounds establishing a jump CIRCUIT — each
   * bastion hop's SSH handshake, the forwardOut between hops, and the target's
   * handshake over the tunnel. Kept separate from (and capped by) the full command
   * timeout: a reused-but-dead bastion can accept TCP yet never complete the
   * handshake/forward, and bounding that by the whole command timeout is exactly
   * the multi-second-to-300s hang. Derived from the TARGET server's
   * channelOpenTimeout (the same knob as the exec-channel-open timeout) and used
   * for every hop of that target's circuit, so a target whose bastion is legitimately
   * slow is tuned by bumping the target's channelOpenTimeout.
   */
  public resolveCircuitOpenTimeout(config: SSHConfig, connectTimeout?: number): number {
    const short = this.resolveChannelOpenTimeout(config);
    if (typeof connectTimeout === "number" && Number.isFinite(connectTimeout) && connectTimeout > 0) {
      return Math.max(1, Math.min(short, connectTimeout));
    }
    return Math.max(1, short);
  }

  public normalizeConnectTimeout(timeout?: number): number | undefined {
    if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0) {
      return undefined;
    }
    return Math.max(1, timeout);
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
          jumpClient.on("error", SshConnectionPool.CLOSED_CLIENT_ERROR_SINK);
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
  public async ensureConnected(name?: string, timeout?: number): Promise<Client> {
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
  public isConnectionError(error: Error): boolean {
    if (error instanceof ToolError) {
      return error.code === "SSH_CONNECTION_FAILED";
    }

    return this.isConnectionShapedMessage(error.message);
  }

  public canRetryCommandConnectionError(error: Error): boolean {
    const msg = error.message.toLowerCase();
    return !(
      msg.includes("while running command") ||
      msg.startsWith("stream error:")
    );
  }

  public isConnectionShapedMessage(message: string): boolean {
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

  /**
   * Force reconnect to SSH server
   * @private
   */
  public async reconnect(name?: string): Promise<void> {
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

}
