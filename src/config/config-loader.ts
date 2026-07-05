import fs from "fs";
import path from "path";
import os from "os";
import yaml from "js-yaml";
import { SSHConfig, SshConnectionConfigMap, ParsedArgs } from "../models/types.js";
import { Logger } from "../utils/logger.js";
import {
  getDefaultUserSshConfigPath,
  loadSshConfigFiles,
  SshConfigLoadResult,
} from "./ssh-config-loader.js";

/**
 * YAML config file structure
 */
interface YamlServerConfig {
  host?: string;
  port?: number;
  username?: string;
  password?: string;
  privateKey?: string;
  passphrase?: string;
  agent?: string;
  socksProxy?: string;
  whitelist?: string[];
  blacklist?: string[];
  safeDirectory?: string;
  allowedRemoteDirectories?: string[];
  allowedLocalDirectories?: string[];
}

interface YamlSshConfigOptions {
  enabled?: boolean;
  paths?: string[];
}

interface YamlConfig {
  defaultServer?: string;
  preConnect?: boolean;
  outputLogDir?: string;
  sshConfig?: boolean | YamlSshConfigOptions;
  servers?: Record<string, YamlServerConfig>;
}

interface YamlParseResult extends ParsedArgs {
  sshConfig?: boolean | YamlSshConfigOptions;
}

export interface ConfigSourceOptions {
  yamlConfigPath?: string | null;
  sshConfigPaths?: string[] | null;
  loadUserSshConfig?: boolean;
}

export interface LoadedConfig extends ParsedArgs {
  watchPaths: string[];
  loadedSshConfigPaths: string[];
  loadedYamlConfigPath?: string;
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
  return loadYamlConfig(configPath, { requireServers: true });
}

export function loadConfigFromSources(options: ConfigSourceOptions = {}): LoadedConfig {
  const yamlConfigPath = options.yamlConfigPath ?? null;
  const yamlParsed = yamlConfigPath
    ? loadYamlConfig(yamlConfigPath, { requireServers: false })
    : null;
  const resolvedYamlConfigPath = yamlConfigPath ? resolveConfigPath(yamlConfigPath) : undefined;

  const sshConfigEnabled = resolveSshConfigEnabled(options, yamlParsed);
  const sshConfigPaths = sshConfigEnabled
    ? resolveSshConfigPaths(options.sshConfigPaths, yamlParsed)
    : [];
  const sshConfigResult: SshConfigLoadResult = sshConfigEnabled
    ? loadSshConfigFiles(sshConfigPaths)
    : { configs: {}, files: [] };

  const configs = mergeConfigMaps(sshConfigResult.configs, yamlParsed?.configs ?? {});
  if (Object.keys(configs).length === 0) {
    throw new Error(
      "No SSH servers loaded. Add Host entries to ~/.ssh/config, pass --ssh-config <path>, or provide --config <servers.yaml>.",
    );
  }
  validateMergedConfigs(configs);

  return {
    configs,
    preConnect: yamlParsed?.preConnect === true,
    outputLogDir: yamlParsed?.outputLogDir,
    watchPaths: [
      ...(resolvedYamlConfigPath ? [resolvedYamlConfigPath] : []),
      ...sshConfigResult.files,
    ],
    loadedSshConfigPaths: sshConfigResult.files,
    loadedYamlConfigPath: resolvedYamlConfigPath,
  };
}

function loadYamlConfig(configPath: string, options: { requireServers: boolean }): YamlParseResult {
  const expandedPath = expandTilde(configPath);
  const absolutePath = resolveConfigPath(expandedPath);

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

  if (!config || (options.requireServers && !config.servers)) {
    throw new Error("Invalid config: 'servers' section is required");
  }

  const configMap: SshConnectionConfigMap = {};

  for (const [name, serverConfig] of Object.entries(config.servers ?? {})) {
    configMap[name] = buildYamlServerConfig(name, serverConfig, {
      allowPartial: !options.requireServers,
    });
  }

  if (options.requireServers && Object.keys(configMap).length === 0) {
    throw new Error("No servers defined in config file");
  }

  Logger.log(`Total YAML servers loaded: ${Object.keys(configMap).length}`, "info");

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
    sshConfig: config.sshConfig,
  };
}

function buildYamlServerConfig(
  name: string,
  serverConfig: YamlServerConfig,
  options: { allowPartial?: boolean } = {},
): SSHConfig {
  const allowPartial = options.allowPartial === true;
  if (!allowPartial && !serverConfig.host) {
    throw new Error(`Server '${name}': 'host' is required`);
  }
  if (!allowPartial && !serverConfig.username) {
    throw new Error(`Server '${name}': 'username' is required`);
  }
  if (
    !allowPartial &&
    !serverConfig.password &&
    !serverConfig.privateKey &&
    !serverConfig.agent
  ) {
    throw new Error(`Server '${name}': either 'password', 'privateKey', or 'agent' is required`);
  }

  const merged: Partial<SSHConfig> = { name };
  const port = serverConfig.port ?? (allowPartial ? undefined : 22);

  if (serverConfig.host !== undefined) merged.host = serverConfig.host ?? undefined;
  if (port !== undefined) merged.port = port;
  if (serverConfig.username !== undefined) merged.username = serverConfig.username ?? undefined;
  if (serverConfig.password !== undefined) merged.password = serverConfig.password ?? undefined;
  if (serverConfig.privateKey) merged.privateKey = expandTilde(serverConfig.privateKey);
  if (serverConfig.passphrase !== undefined) merged.passphrase = serverConfig.passphrase ?? undefined;
  if (serverConfig.agent !== undefined) {
    merged.agent = serverConfig.agent ? expandTilde(serverConfig.agent) : undefined;
  }
  if (serverConfig.password || serverConfig.privateKey || serverConfig.agent) {
    merged.authOptional = false;
  }
  if (serverConfig.socksProxy !== undefined) merged.socksProxy = serverConfig.socksProxy ?? undefined;
  if (serverConfig.whitelist !== undefined) {
    merged.commandWhitelist = serverConfig.whitelist ?? undefined;
  }
  if (serverConfig.blacklist !== undefined) {
    merged.commandBlacklist = serverConfig.blacklist ?? undefined;
  }
  if (serverConfig.safeDirectory !== undefined) {
    merged.safeDirectory = serverConfig.safeDirectory ?? undefined;
  }
  if (serverConfig.allowedRemoteDirectories !== undefined) {
    merged.allowedRemoteDirectories = normalizeAllowedRemoteDirectories(
      name,
      serverConfig.allowedRemoteDirectories,
    );
  }
  if (serverConfig.allowedLocalDirectories !== undefined) {
    merged.allowedLocalDirectories = normalizeAllowedLocalDirectories(
      name,
      serverConfig.allowedLocalDirectories,
    );
  }

  if (!allowPartial) {
    Logger.log(
      `Loaded server config: ${name} -> ${merged.username}@${merged.host}:${merged.port}`,
      "info"
    );
  }

  return merged as SSHConfig;
}

function mergeConfigMaps(
  sshConfigs: SshConnectionConfigMap,
  yamlConfigs: SshConnectionConfigMap,
): SshConnectionConfigMap {
  const merged: SshConnectionConfigMap = { ...sshConfigs };
  for (const [name, yamlConfig] of Object.entries(yamlConfigs)) {
    merged[name] = {
      ...merged[name],
      ...yamlConfig,
      name,
      allowedRemoteDirectories: yamlConfig.allowedRemoteDirectories ?? merged[name]?.allowedRemoteDirectories,
      allowedLocalDirectories: yamlConfig.allowedLocalDirectories ?? merged[name]?.allowedLocalDirectories,
      commandWhitelist: yamlConfig.commandWhitelist ?? merged[name]?.commandWhitelist,
      commandBlacklist: yamlConfig.commandBlacklist ?? merged[name]?.commandBlacklist,
      safeDirectory: yamlConfig.safeDirectory ?? merged[name]?.safeDirectory,
    };
  }
  return merged;
}

function validateMergedConfigs(configs: SshConnectionConfigMap): void {
  for (const [name, config] of Object.entries(configs)) {
    if (typeof config.host !== "string" || config.host.length === 0) {
      throw new Error(`Server '${name}': 'host' is required`);
    }
    if (typeof config.username !== "string" || config.username.length === 0) {
      throw new Error(`Server '${name}': 'username' is required`);
    }
    if (
      !Number.isInteger(config.port) ||
      config.port <= 0 ||
      config.port > 65535
    ) {
      throw new Error(`Server '${name}': 'port' must be an integer from 1 to 65535`);
    }
    if (
      !config.authOptional &&
      !config.password &&
      !config.privateKey &&
      !config.agent
    ) {
      throw new Error(
        `Server '${name}': either 'password', 'privateKey', 'agent', or OpenSSH/default authentication is required`,
      );
    }
  }
}

function resolveSshConfigEnabled(
  options: ConfigSourceOptions,
  yamlParsed: YamlParseResult | null,
): boolean {
  if (options.loadUserSshConfig !== undefined) {
    return options.loadUserSshConfig;
  }
  if (options.sshConfigPaths && options.sshConfigPaths.length > 0) {
    return true;
  }
  if (typeof yamlParsed?.sshConfig === "boolean") {
    return yamlParsed.sshConfig;
  }
  if (typeof yamlParsed?.sshConfig === "object" && yamlParsed.sshConfig.enabled !== undefined) {
    return yamlParsed.sshConfig.enabled;
  }
  return true;
}

function resolveSshConfigPaths(
  cliPaths: string[] | null | undefined,
  yamlParsed: YamlParseResult | null,
): string[] {
  if (cliPaths && cliPaths.length > 0) {
    return cliPaths;
  }
  if (typeof yamlParsed?.sshConfig === "object" && yamlParsed.sshConfig.paths?.length) {
    return yamlParsed.sshConfig.paths;
  }
  return [getDefaultUserSshConfigPath()];
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
 * Get optional --ssh-config paths. Accepts comma-separated values and can be repeated.
 */
export function getSshConfigPathsArg(args: string[]): string[] | null {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== "--ssh-config") continue;
    const value = args[i + 1];
    if (!value) continue;
    out.push(...value.split(",").map((s) => s.trim()).filter(Boolean));
    i++;
  }
  return out.length > 0 ? out : null;
}

/**
 * Disable automatic ~/.ssh/config loading.
 */
export function getNoSshConfigFlag(args: string[]): boolean {
  return args.includes("--no-ssh-config");
}

/**
 * Return the CLI override for user OpenSSH config loading.
 * undefined means "let YAML/defaults decide"; false is the explicit
 * --no-ssh-config override.
 */
export function getLoadUserSshConfigFlag(args: string[]): boolean | undefined {
  return getNoSshConfigFlag(args) ? false : undefined;
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

function resolveConfigPath(configPath: string): string {
  const expandedPath = expandTilde(configPath);
  return path.isAbsolute(expandedPath)
    ? path.normalize(expandedPath)
    : path.resolve(process.cwd(), expandedPath);
}
