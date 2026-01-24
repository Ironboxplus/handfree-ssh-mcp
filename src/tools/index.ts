import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerExecuteCommandTool } from "./execute-command.js";
import { registerExecuteCommandStreamTool } from "./execute-command-stream.js";
import { registerUploadTool } from "./upload.js";
import { registerDownloadTool } from "./download.js";
import { registerListServersTool } from "./list-servers.js";

/**
 * Register all tools
 * @param server MCP server instance
 */
export function registerAllTools(server: McpServer): void {
  registerExecuteCommandTool(server);
  registerExecuteCommandStreamTool(server);
  registerUploadTool(server);
  registerDownloadTool(server);
  registerListServersTool(server);
} 