import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SSHConnectionManager } from "../services/ssh-connection-manager.js";
import { Logger } from "../utils/logger.js";

/**
 * Register file upload tool
 */
export function registerUploadTool(server: McpServer): void {
  const sshManager = SSHConnectionManager.getInstance();

  server.tool(
    "upload",
    "Upload file to connected server",
    {
      localPath: z.string().describe("Local path"),
      remotePath: z.string().describe("Remote path"),
      connectionName: z.string().optional().describe("SSH connection name (optional, default is 'default')"),
    },
    async ({ localPath, remotePath, connectionName }) => {
      try {
        const result = await sshManager.upload(localPath, remotePath, connectionName);
        return {
          content: [{ type: "text", text: result }],
        };
      } catch (error: unknown) {
        const errorMessage = Logger.handleError(error, "Failed to upload file");
        return {
          content: [{ type: "text", text: errorMessage }],
          isError: true,
        };
      }
    }
  );
}
