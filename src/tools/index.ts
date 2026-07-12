import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerExecuteCommandTool } from "./execute-command.js";
import { registerUploadTool } from "./upload.js";
import { registerDownloadTool } from "./download.js";
import { registerListServersTool } from "./list-servers.js";
import { registerShowWhitelistTool } from "./show-whitelist.js";
import { registerCloseConnectionTool } from "./close-connection.js";
import { registerCommandStatusTool } from "./command-status.js";
import { registerTransferTool } from "./transfer.js";
import { registerHelpTool } from "./help.js";

/**
 * Register all tools
 * @param server MCP server instance
 */
export function registerAllTools(server: McpServer): void {
  registerExecuteCommandTool(server);
  registerUploadTool(server);
  registerDownloadTool(server);
  registerListServersTool(server);
  registerShowWhitelistTool(server);
  registerCloseConnectionTool(server);
  registerCommandStatusTool(server);
  registerTransferTool(server);
  registerHelpTool(server);
}
