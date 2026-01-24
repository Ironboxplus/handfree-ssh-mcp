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
}

interface YamlConfig {
  defaultServer?: string;
  preConnect?: boolean;
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

  return {
    configs: configMap,
    preConnect: config.preConnect === true,
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
