import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerExecuteCommandTool } from "./execute-command.js";
import { registerUploadTool } from "./upload.js";
import { registerDownloadTool } from "./download.js";
import { registerListServersTool } from "./list-servers.js";
import { registerShowWhitelistTool } from "./show-whitelist.js";

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
}
