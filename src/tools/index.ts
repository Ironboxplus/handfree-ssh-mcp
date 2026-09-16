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
import { registerWorkspaceRunTool } from "./workspace-run.js";
import { registerRunStatusTool } from "./run-status.js";
import { registerRunLogsTool } from "./run-logs.js";
import { registerRunListTool } from "./run-list.js";
import { registerRunCancelTool } from "./run-cancel.js";
import { registerRunRetryTool } from "./run-retry.js";

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
  registerWorkspaceRunTool(server);
  registerRunStatusTool(server);
  registerRunLogsTool(server);
  registerRunListTool(server);
  registerRunCancelTool(server);
  registerRunRetryTool(server);
  registerHelpTool(server);
}
