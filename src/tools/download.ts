import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SSHConnectionManager } from "../services/ssh-connection-manager.js";
import { Logger } from "../utils/logger.js";

/**
 * Register file download tool
 */
export function registerDownloadTool(server: McpServer): void {
  const sshManager = SSHConnectionManager.getInstance();

  server.tool(
    "download",
    "Download file from connected server",
    {
      remotePath: z.string().describe("Remote path"),
      localPath: z.string().describe("Local path"),
      connectionName: z.string().optional().describe("SSH connection name (optional, default is 'default')"),
    },
    async ({ remotePath, localPath, connectionName }) => {
      try {
        const result = await sshManager.download(remotePath, localPath, connectionName);
        return {
          content: [{ type: "text", text: result }],
        };
      } catch (error: unknown) {
        const errorMessage = Logger.handleError(error, "Failed to download file");
        return {
          content: [{ type: "text", text: errorMessage }],
          isError: true,
        };
      }
    }
  );
} 