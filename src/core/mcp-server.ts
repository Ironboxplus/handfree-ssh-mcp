import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSHConnectionManager } from "../services/ssh-connection-manager.js";
import { CommandLineParser } from "../cli/command-line-parser.js";
import { Logger } from "../utils/logger.js";
import { registerAllTools } from "../tools/index.js";
import { SERVER_CONFIG } from "../config/server.js";
import { getConfigPath, getEnabledServersArg, loadConfigFromYaml } from "../config/config-loader.js";
import { ParsedArgs } from "../models/types.js";

/**
 * MCP Server class
 */
export class SshMcpServer {
  private server: McpServer;
  private sshManager: SSHConnectionManager;

  constructor() {
    this.server = new McpServer(SERVER_CONFIG);

    this.sshManager = SSHConnectionManager.getInstance();
  }

  /**
   * Register tools
   */
  private registerTools(): void {
    registerAllTools(this.server);
  }

  /**
   * Load configuration from YAML file or CLI arguments
   */
  private loadConfig(): ParsedArgs {
    const args = process.argv.slice(2);
    
    // Check for --config argument first
    const configPath = getConfigPath(args);
    
    if (configPath) {
      Logger.log(`Using YAML config file: ${configPath}`, "info");
      const parsedArgs = loadConfigFromYaml(configPath);
      
      // Check for --enable-servers to restrict access
      const enabledServers = getEnabledServersArg(args);
      if (enabledServers) {
        // Validate that all enabled servers exist in config
        for (const serverName of enabledServers) {
          if (!parsedArgs.configs[serverName]) {
            throw new Error(`Enabled server '${serverName}' not found in config`);
          }
        }
        Logger.log(`Enabled servers (via --enable-servers): ${enabledServers.join(", ")}`, "info");
        parsedArgs.enabledServers = enabledServers;
      }
      
      return parsedArgs;
    }
    
    // Fall back to CLI arguments for backward compatibility
    Logger.log("Using CLI arguments for configuration", "info");
    return CommandLineParser.parseArgs();
  }

  /**
   * Run the server
   */
  public async run(): Promise<void> {
    // Initialize SSH configuration
    const parsedArgs = this.loadConfig();
    this.sshManager.setConfig(parsedArgs.configs, parsedArgs.enabledServers);

    // Security warning
    const allConfigs = Object.values(parsedArgs.configs);
    if (
      allConfigs.some(
        (c) => !c.commandWhitelist || c.commandWhitelist.length === 0
      )
    ) {
      Logger.log(
        "WARNING: Running without a command whitelist is strongly discouraged. Please configure a whitelist to restrict the commands that can be executed.",
        "info"
      );
    }

    // Pre-connect to all servers if flag is set
    if (parsedArgs.preConnect) {
      Logger.log("Pre-connecting to all configured SSH servers...", "info");
      try {
        await this.sshManager.connectAll();
        Logger.log("Successfully pre-connected to all SSH servers", "info");
      } catch (error) {
        Logger.log(
          `Warning: Some SSH connections failed during pre-connect: ${(error as Error).message}`,
          "error"
        );
      }
    }

    // Register tools
    this.registerTools();

    // Create transport instance and connect
    const transport = new StdioServerTransport();
    await this.server.connect(transport);

    Logger.log("MCP server connection established");
  }
}
