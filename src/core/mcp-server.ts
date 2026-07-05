import fs from "fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSHConnectionManager } from "../services/ssh-connection-manager.js";
import { Logger } from "../utils/logger.js";
import { registerAllTools } from "../tools/index.js";
import { SERVER_CONFIG, SERVER_INSTRUCTIONS } from "../config/server.js";
import {
  getConfigPath,
  getEnabledServersArg,
  getLoadUserSshConfigFlag,
  getPreConnectFlag,
  getSshConfigPathsArg,
  type ConfigSourceOptions,
  type LoadedConfig,
  loadConfigFromSources,
} from "../config/config-loader.js";

/**
 * MCP Server class
 * 
 * handfree-ssh-mcp: Configure once via YAML, let the LLM handle the rest.
 */
export class SshMcpServer {
  private server: McpServer;
  private sshManager: SSHConnectionManager;
  private configWatchers: Map<string, fs.FSWatcher> = new Map();
  private configWatchersToRefresh: Set<string> = new Set();
  private configReloadTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.server = new McpServer(SERVER_CONFIG, {
      instructions: SERVER_INSTRUCTIONS,
    });
    this.sshManager = SSHConnectionManager.getInstance();
  }

  /**
   * Register tools
   */
  private registerTools(): void {
    registerAllTools(this.server);
  }

  /**
   * Load configuration from OpenSSH config and optional YAML overlay.
   * 
   * Optional: --config <path-to-yaml>
   * Optional: --ssh-config <path-to-openssh-config>
   * Optional: --enable-servers <server1,server2,...>
   */
  private loadConfig(): LoadedConfig {
    const args = process.argv.slice(2);
    const parsedArgs = loadConfigFromSources(this.getConfigSourceOptions(args));

    const enabledServers = getEnabledServersArg(args);
    if (enabledServers && enabledServers.length > 0) {
      // Validate that all enabled servers exist in config
      for (const serverName of enabledServers) {
        if (!parsedArgs.configs[serverName]) {
          throw new Error(
            `Server '${serverName}' not found in config.\n\n` +
            "Available servers: " + Object.keys(parsedArgs.configs).join(", ")
          );
        }
      }

      Logger.log(`Enabled servers: ${enabledServers.join(", ")}`, "info");
      parsedArgs.enabledServers = enabledServers;
    } else {
      Logger.log("No --enable-servers provided; all loaded servers are enabled", "info");
    }

    // CLI --pre-connect overrides YAML preConnect (CLI wins when present)
    if (getPreConnectFlag(args)) {
      parsedArgs.preConnect = true;
    }
    
    return parsedArgs;
  }

  private getConfigSourceOptions(args: string[]): ConfigSourceOptions {
    return {
      yamlConfigPath: getConfigPath(args),
      sshConfigPaths: getSshConfigPathsArg(args),
      loadUserSshConfig: getLoadUserSshConfigFlag(args),
    };
  }

  /**
   * Watch loaded config files for changes and hot-reload connection settings
   * plus policies without restarting the MCP process.
   */
  private watchConfig(config: LoadedConfig): void {
    const args = process.argv.slice(2);
    const enabledServers = config.enabledServers;
    const scheduleReload = () => {
      if (this.configReloadTimer) clearTimeout(this.configReloadTimer);
      this.configReloadTimer = setTimeout(reload, 500);
    };
    const reload = () => {
      try {
        Logger.log("Config file changed, hot-reloading SSH config...", "info");
        const fresh = loadConfigFromSources(this.getConfigSourceOptions(args));
        if (enabledServers) {
          for (const serverName of enabledServers) {
            if (!fresh.configs[serverName]) {
              throw new Error(
                `Enabled server '${serverName}' no longer exists after reload. Available servers: ${Object.keys(fresh.configs).join(", ")}`,
              );
            }
          }
          fresh.enabledServers = enabledServers;
        }
        this.sshManager.replaceConfig(fresh.configs, fresh.enabledServers);
        this.sshManager.setOutputLogRoot(fresh.outputLogDir);
        this.reconcileConfigWatchers(fresh.watchPaths, scheduleReload);
      } catch (error) {
        Logger.log(
          `Failed to hot-reload config: ${(error as Error).message}`,
          "error",
        );
      }
    };

    this.reconcileConfigWatchers(config.watchPaths, scheduleReload);
  }

  private reconcileConfigWatchers(
    watchPaths: string[],
    scheduleReload: () => void,
  ): void {
    if (watchPaths.length === 0) {
      Logger.log("No config files to watch for live updates", "info");
    }

    const nextPaths = new Set(watchPaths);
    for (const [configPath, watcher] of this.configWatchers) {
      if (
        nextPaths.has(configPath) &&
        !this.configWatchersToRefresh.has(configPath)
      ) {
        continue;
      }
      try {
        watcher.close();
      } catch {
        // Ignore close errors for already-dead watchers.
      }
      this.configWatchers.delete(configPath);
    }

    for (const configPath of nextPaths) {
      if (this.configWatchers.has(configPath)) continue;
      try {
        const watcher = fs.watch(configPath, (eventType) => {
          if (eventType !== "change" && eventType !== "rename") return;
          if (eventType === "rename") {
            this.configWatchersToRefresh.add(configPath);
          }
          scheduleReload();
        });
        this.configWatchers.set(configPath, watcher);
        this.configWatchersToRefresh.delete(configPath);

        Logger.log(`Watching config file for live updates: ${configPath}`, "info");
      } catch (error) {
        Logger.log(
          `Could not watch config file ${configPath} (hot-reload disabled for this file): ${(error as Error).message}`,
          "error",
        );
      }
    }
  }

  /**
   * Run the server
   */
  public async run(): Promise<void> {
    // Initialize SSH configuration
    const parsedArgs = this.loadConfig();
    this.sshManager.setConfig(parsedArgs.configs, parsedArgs.enabledServers);
    this.sshManager.setOutputLogRoot(parsedArgs.outputLogDir);

    // Pre-connect to enabled servers if flag is set
    if (parsedArgs.preConnect) {
      Logger.log("Pre-connecting to enabled SSH servers...", "info");
      try {
        await this.sshManager.connectAll();
        Logger.log("Successfully pre-connected to enabled SSH servers", "info");
      } catch (error) {
        Logger.log(
          `Warning: Some SSH connections failed during pre-connect: ${(error as Error).message}`,
          "error"
        );
      }
    }

    // Watch config files for live hot-reload
    this.watchConfig(parsedArgs);

    // Register tools
    this.registerTools();

    // Create transport instance and connect
    const transport = new StdioServerTransport();
    await this.server.connect(transport);

    Logger.log("MCP server connection established");
  }
}
