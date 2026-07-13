/**
 * SSH connection configuration interface
 */
export interface SSHConfig {
  name?: string; // Connection name, optional, compatible with single connection
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKey?: string;
  passphrase?: string;
  agent?: string | false;
  identitiesOnly?: boolean; // True when OpenSSH IdentitiesOnly=yes disables default identity/agent fallback.
  authOptional?: boolean; // True for OpenSSH config entries that may rely on agent/default identities.
  commandMode?: "blacklist" | "whitelist"; // Default: blacklist. Legacy whitelist configs opt into whitelist mode.
  commandWhitelist?: string[]; // Command whitelist (array of regex strings)
  commandBlacklist?: string[]; // Command blacklist (array of regex strings)
  disableBuiltinGuards?: boolean; // When true, skip the built-in destructive command guards for this server.
  disableBuiltinBlacklist?: boolean; // When true, skip the built-in dangerous-command blacklist for this server.
  socksProxy?: string; // SOCKS proxy URL, e.g. 'socks://user:pass@host:port'
  // Name of another server in the same config to use as an SSH jump host (ProxyJump).
  // Chains to any depth (the referenced jump host may itself set `jumpHost`); only
  // cycles are rejected. Mutually exclusive with `socksProxy`. The target uses its
  // own credentials and policy (whitelists, allowed directories); the jump host is
  // purely transport.
  jumpHost?: string;
  safeDirectory?: string; // Optional per-server safe directory for destructive ops (rm, etc.)
  // SFTP-only path allowlists. Apply to upload/download/transfer tools.
  // execute-command is NOT affected by these.
  allowedRemoteDirectories?: string[]; // Absolute POSIX dirs that SFTP remotePath may live under. If unset/empty, SFTP is rejected unless disableSftpPathPolicy is set.
  allowedLocalDirectories?: string[]; // Absolute host dirs (in addition to process.cwd()) that SFTP localPath may live under.
  disableSftpPathPolicy?: boolean; // When true, skip allowedRemoteDirectories/allowedLocalDirectories containment checks entirely (any absolute remote path, any local path allowed).
  // ssh2 keepalive on the cached connection so a silently-dead peer is detected
  // proactively (ssh2 emits close/error → the connection self-heals on the next
  // reuse) instead of only being discovered when a later command hangs.
  // Defaults ON. Set keepaliveInterval to 0 to disable.
  keepaliveInterval?: number; // ms between keepalive probes. Default 5000. 0 disables keepalive.
  keepaliveCountMax?: number; // max unanswered probes before ssh2 declares the connection dead. Default 2.
  // Timeout (ms) for the exec-channel-OPEN phase only, kept separate from the
  // command run timeout. A reused-but-dead connection can accept but never open
  // a channel; a short open timeout fails fast (retriable) and drops the stale
  // connection so the next call reconnects, instead of hanging until the full
  // command timeout. Default 10000.
  channelOpenTimeout?: number;
}

/**
 * Multiple SSH connection configuration Map
 */
export type SshConnectionConfigMap = Record<string, SSHConfig>;

/**
 * Log levels
 */
export type LogLevel = "info" | "error" | "debug";

/**
 * System status information
 */
export interface ServerStatus {
  reachable: boolean;
  hostname?: string;
  ipAddresses?: string[];
  osName?: string;
  osVersion?: string;
  kernelVersion?: string;
  uptime?: string;
  diskSpace?: {
    free: string;
    total: string;
  };
  drives?: Array<{
    device: string;
    mountPoint: string;
    total: string;
    used: string;
    free: string;
    usagePercent: string;
    filesystem?: string;
  }>;
  memory?: {
    free: string;
    total: string;
  };
  cpu?: {
    name?: string;
    usage?: string;
  };
  gpus?: Array<{
    name: string;
    usage?: string;
    path?: string;
  }>;
  processes?: {
    running: number;
    threads: number;
  };
  services?: {
    running: number;
    installed: number;
  };
  lastUpdated?: string;
}

/**
 * Parsed command line arguments result
 */
export interface ParsedArgs {
  configs: SshConnectionConfigMap;
  preConnect: boolean;
  enabledServers?: string[]; // List of enabled server names (if not set, all servers are enabled)
  outputLogDir?: string; // Absolute host path; root dir for execute-command full-output logs. Defaults to <cwd>/.handfree-output
}
