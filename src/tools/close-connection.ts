import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SSHConnectionManager } from "../services/ssh-connection-manager.js";
import { Logger } from "../utils/logger.js";
import { formatToolErrorResponse, toToolError } from "../utils/tool-error.js";

/**
 * Register close-connection tool
 */
export function registerCloseConnectionTool(server: McpServer): void {
  const sshManager = SSHConnectionManager.getInstance();

  server.tool(
    "close-connection",
    "Close the cached SSH connection for a configured server. Use this after a timeout, stale connection suspicion, or before retrying a host with a clean cached connection. This affects only cached/reused SSH clients; reuseConnection=false command clients already close after each command. Closing a jump host also closes cached target connections whose jump chain uses that host.",
    {
      connectionName: z
        .string()
        .optional()
        .describe("Target server name from list-servers. Required when multiple servers are enabled; optional when only one server is enabled."),
    },
    async ({ connectionName }) => {
      try {
        const result = sshManager.closeConnection(connectionName);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result),
            },
          ],
        };
      } catch (error: unknown) {
        const toolError = toToolError(error, "INVALID_CONFIGURATION");
        Logger.handleError(toolError, "Failed to close SSH connection");
        return {
          content: [{ type: "text", text: formatToolErrorResponse(toolError) }],
          isError: true,
        };
      }
    },
  );
}
