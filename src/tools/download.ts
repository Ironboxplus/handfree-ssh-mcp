import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SSHConnectionManager } from "../services/ssh-connection-manager.js";
import { Logger } from "../utils/logger.js";
import { formatToolErrorResponse, toToolError } from "../utils/tool-error.js";

/**
 * Register file download tool
 */
export function registerDownloadTool(server: McpServer): void {
  const sshManager = SSHConnectionManager.getInstance();

  server.tool(
    "download",
    "Download a file from the remote server to the MCP host over SFTP. Use this when you need to inspect or save a remote file locally.",
    {
      remotePath: z.string().describe("Path to the file on the remote server, such as /var/log/app.log or ./output.txt."),
      localPath: z.string().describe("Destination path on the MCP host. This path must stay inside the MCP server working directory or it will be rejected."),
      connectionName: z.string().optional().describe("Target server name from list-servers. Required when multiple servers are enabled; optional when only one server is enabled."),
    },
    async ({ remotePath, localPath, connectionName }) => {
      try {
        const resolvedName = sshManager.resolveServer(connectionName);
        const result = await sshManager.download(remotePath, localPath, resolvedName);
        return {
          content: [{ type: "text", text: result }],
        };
      } catch (error: unknown) {
        const toolError = toToolError(error, "SFTP_ERROR");
        Logger.handleError(toolError, "Failed to download file");
        return {
          content: [{ type: "text", text: formatToolErrorResponse(toolError) }],
          isError: true,
        };
      }
    }
  );
}
