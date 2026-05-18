import fs from "fs";
import path from "path";
import os from "os";
import yaml from "js-yaml";
import { SSHConfig, SshConnectionConfigMap, ParsedArgs } from "../models/types.js";
import { Logger } from "../utils/logger.js";

/**
 * YAML config file structure
 */
interface YamlServerConfig {
  host: string;
  port?: number;
  username: string;
  password?: string;
  privateKey?: string;
  passphrase?: string;
  socksProxy?: string;
  whitelist?: string[];
  blacklist?: string[];
  safeDirectory?: string;
  allowedRemoteDirectories?: string[];
  allowedLocalDirectories?: string[];
}

interface YamlConfig {
  defaultServer?: string;
  preConnect?: boolean;
  outputLogDir?: string;
  servers: Record<string, YamlServerConfig>;
}

/**
 * Expand ~ to home directory in paths
 */
function expandTilde(filePath: string): string {
  if (filePath.startsWith("~")) {
    return path.join(os.homedir(), filePath.slice(1));
  }
  return filePath;
}

/**
 * Load and parse YAML config file
 */
export function loadConfigFromYaml(configPath: string): ParsedArgs {
  const expandedPath = expandTilde(configPath);
  const absolutePath = path.isAbsolute(expandedPath)
    ? expandedPath
    : path.resolve(process.cwd(), expandedPath);

  Logger.log(`Loading config from: ${absolutePath}`, "info");

  if (!fs.existsSync(absolutePath)) {
    throw new Error(`Config file not found: ${absolutePath}`);
  }

  const fileContent = fs.readFileSync(absolutePath, "utf8");
  
  let config: YamlConfig;
  try {
    config = yaml.load(fileContent) as YamlConfig;
  } catch (error) {
    throw new Error(`Failed to parse YAML config: ${(error as Error).message}`);
  }

  if (!config || !config.servers) {
    throw new Error("Invalid config: 'servers' section is required");
  }

  const configMap: SshConnectionConfigMap = {};

  for (const [name, serverConfig] of Object.entries(config.servers)) {
    // Validate required fields
    if (!serverConfig.host) {
      throw new Error(`Server '${name}': 'host' is required`);
    }
    if (!serverConfig.username) {
      throw new Error(`Server '${name}': 'username' is required`);
    }
    if (!serverConfig.password && !serverConfig.privateKey) {
      throw new Error(`Server '${name}': either 'password' or 'privateKey' is required`);
    }

    const port = serverConfig.port || 22;

    // Expand ~ in privateKey path
    const privateKey = serverConfig.privateKey
      ? expandTilde(serverConfig.privateKey)
      : undefined;

    // Normalize and validate allowedRemoteDirectories (must be absolute POSIX paths)
    const allowedRemoteDirectories = serverConfig.allowedRemoteDirectories
      ? normalizeAllowedRemoteDirectories(name, serverConfig.allowedRemoteDirectories)
      : undefined;

    // Normalize allowedLocalDirectories (resolve to absolute, expand ~)
    const allowedLocalDirectories = serverConfig.allowedLocalDirectories
      ? normalizeAllowedLocalDirectories(name, serverConfig.allowedLocalDirectories)
      : undefined;

    configMap[name] = {
      name,
      host: serverConfig.host,
      port,
      username: serverConfig.username,
      password: serverConfig.password,
      privateKey,
      passphrase: serverConfig.passphrase,
      socksProxy: serverConfig.socksProxy,
      commandWhitelist: serverConfig.whitelist,
      commandBlacklist: serverConfig.blacklist,
      safeDirectory: serverConfig.safeDirectory,
      allowedRemoteDirectories,
      allowedLocalDirectories,
    };

    Logger.log(
      `Loaded server config: ${name} -> ${serverConfig.username}@${serverConfig.host}:${port}`,
      "info"
    );
  }

  if (Object.keys(configMap).length === 0) {
    throw new Error("No servers defined in config file");
  }

  Logger.log(`Total servers loaded: ${Object.keys(configMap).length}`, "info");

  // Resolve outputLogDir if provided. Default applied later (in ssh-connection-manager)
  // so it always tracks the current cwd at execution time.
  let outputLogDir: string | undefined;
  if (config.outputLogDir !== undefined) {
    if (typeof config.outputLogDir !== "string" || config.outputLogDir.length === 0) {
      throw new Error("'outputLogDir' must be a non-empty string");
    }
    outputLogDir = path.resolve(expandTilde(config.outputLogDir));
    Logger.log(`Output log dir (from YAML): ${outputLogDir}`, "info");
  }

  return {
    configs: configMap,
    preConnect: config.preConnect === true,
    outputLogDir,
  };
}

/**
 * Check if --config argument is provided
 */
export function getConfigPath(args: string[]): string | null {
  const configIndex = args.indexOf("--config");
  if (configIndex !== -1 && args[configIndex + 1]) {
    return args[configIndex + 1];
  }
  return null;
}

/**
 * Get --enable-servers argument if provided
 * Returns array of enabled server names, or null if not specified
 */
export function getEnabledServersArg(args: string[]): string[] | null {
  const index = args.indexOf("--enable-servers");
  if (index !== -1 && args[index + 1]) {
    return args[index + 1].split(",").map(s => s.trim()).filter(Boolean);
  }
  return null;
}

/**
 * Check if --pre-connect flag is present on the CLI.
 * Overrides the YAML `preConnect` setting when set.
 */
export function getPreConnectFlag(args: string[]): boolean {
  return args.includes("--pre-connect");
}

/**
 * Normalize and validate allowedRemoteDirectories.
 * Each entry must be an absolute POSIX path. Trailing slashes are stripped
 * (except for the root "/"). ".." segments are rejected after normalization.
 */
function normalizeAllowedRemoteDirectories(serverName: string, raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    throw new Error(`Server '${serverName}': 'allowedRemoteDirectories' must be a list of absolute POSIX paths`);
  }
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string" || entry.length === 0) {
      throw new Error(`Server '${serverName}': 'allowedRemoteDirectories' entries must be non-empty strings`);
    }
    if (entry.includes("\0")) {
      throw new Error(`Server '${serverName}': 'allowedRemoteDirectories' entry contains a null byte: ${entry}`);
    }
    if (!path.posix.isAbsolute(entry)) {
      throw new Error(`Server '${serverName}': 'allowedRemoteDirectories' entry must be an absolute POSIX path, got: ${entry}`);
    }
    // Reject '..' BEFORE normalization, otherwise '/a/../b' would silently collapse to '/b'.
    if (entry.split("/").includes("..")) {
      throw new Error(`Server '${serverName}': 'allowedRemoteDirectories' entry must not contain '..' segments: ${entry}`);
    }
    const normalized = path.posix.normalize(entry);
    const trimmed = normalized.length > 1 && normalized.endsWith("/")
      ? normalized.slice(0, -1)
      : normalized;
    out.push(trimmed);
  }
  return out;
}

/**
 * Normalize allowedLocalDirectories. Resolves each entry to an absolute
 * host path (with ~ expansion). The MCP working directory is implicitly
 * allowed and does NOT need to appear here.
 */
function normalizeAllowedLocalDirectories(serverName: string, raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    throw new Error(`Server '${serverName}': 'allowedLocalDirectories' must be a list of paths`);
  }
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string" || entry.length === 0) {
      throw new Error(`Server '${serverName}': 'allowedLocalDirectories' entries must be non-empty strings`);
    }
    const expanded = expandTilde(entry);
    const resolved = path.resolve(expanded);
    out.push(resolved);
  }
  return out;
}
