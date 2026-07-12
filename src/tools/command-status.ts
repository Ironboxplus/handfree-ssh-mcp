import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SSHConnectionManager } from "../services/ssh-connection-manager.js";
import { Logger } from "../utils/logger.js";
import { formatToolErrorResponse, toToolError } from "../utils/tool-error.js";

export function registerCommandStatusTool(server: McpServer): void {
  const sshManager = SSHConnectionManager.getInstance();

  server.tool(
    "command-status",
    "Get status and live log tail for a background command started by execute-command with stream=true. Use this to poll long-running commands without holding a single MCP tools/call open. Status is kept in the current MCP server process; after a server restart, use the returned logPath directly.",
    {
      runId: z.string().describe("Background command runId returned by execute-command when stream=true."),
      maxOutputBytes: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe("Maximum bytes of the live log tail to return. Defaults to 65536."),
    },
    async ({ runId, maxOutputBytes }) => {
      try {
        const status = sshManager.getBackgroundCommandStatus(runId, maxOutputBytes);
        return {
          content: [{ type: "text", text: JSON.stringify(status, null, 2) }],
        };
      } catch (error: unknown) {
        const toolError = toToolError(error, "BACKGROUND_COMMAND_STATUS_FAILED");
        Logger.handleError(toolError, "Failed to get background command status");
        return {
          content: [{ type: "text", text: formatToolErrorResponse(toolError) }],
          isError: true,
        };
      }
    },
  );
}
