import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SSHConnectionManager } from "../services/ssh-connection-manager.js";
import { Logger } from "../utils/logger.js";
import { formatToolErrorResponse, toToolError } from "../utils/tool-error.js";

/**
 * Register file upload tool
 */
export function registerUploadTool(server: McpServer): void {
  const sshManager = SSHConnectionManager.getInstance();

  server.tool(
    "upload",
    "Upload a local file from the MCP host to the remote server over SFTP. Use this when the file already exists locally and must be copied to the selected SSH server.",
    {
      localPath: z.string().describe("Path to a local file on the MCP host. This path must stay inside the MCP server working directory or it will be rejected."),
      remotePath: z.string().describe("Destination path on the remote server, such as /tmp/file.txt or ./file.txt."),
      connectionName: z.string().optional().describe("Target server name from list-servers. Required when multiple servers are enabled; optional when only one server is enabled."),
    },
    async ({ localPath, remotePath, connectionName }) => {
      try {
        const resolvedName = sshManager.resolveServer(connectionName);
        const result = await sshManager.upload(localPath, remotePath, resolvedName);
        return {
          content: [{ type: "text", text: result }],
        };
      } catch (error: unknown) {
        const toolError = toToolError(error, "SFTP_ERROR");
        Logger.handleError(toolError, "Failed to upload file");
        return {
          content: [{ type: "text", text: formatToolErrorResponse(toolError) }],
          isError: true,
        };
      }
    }
  );
}
