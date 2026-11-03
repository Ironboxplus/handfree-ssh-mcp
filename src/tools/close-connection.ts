import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SSHConnectionManager } from "../services/ssh-connection-manager.js";
import { Logger } from "../utils/logger.js";
import { formatToolErrorResponse, toToolError } from "../utils/tool-error.js";
import { rejectUnknownArguments } from "./strict-arguments.js";

/**
 * Register close-connection tool
 */
export function registerCloseConnectionTool(server: McpServer): void {
  const sshManager = SSHConnectionManager.getInstance();

  rejectUnknownArguments(server.tool(
    "close-connection",
    "Close cached SSH connections for a server, including transfer connections. Closing a jump host also closes dependent target connections. Fresh connections from reuseConnection=false close after use.",
    {
      connectionName: z
        .string()
        .optional()
        .describe("Server name from list-servers. Required with multiple enabled servers; optional with one."),
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
  ));
}
