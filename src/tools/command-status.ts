import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SSHConnectionManager } from "../services/ssh-connection-manager.js";
import { Logger } from "../utils/logger.js";
import { formatToolErrorResponse, toToolError } from "../utils/tool-error.js";

export function registerCommandStatusTool(server: McpServer): void {
  const sshManager = SSHConnectionManager.getInstance();

  server.tool(
    "command-status",
    "Get status and live output for a background command started by execute-command with stream=true. Incremental mode is enabled by default and maintains one process-local cursor per runId, so repeated calls return only newly appended outputChunk data. Set incremental=false to return the current outputTail; this still advances the cursor to the current file end. Status and cursor are kept in the current MCP server process; after a server restart, use the returned logPath directly.",
    {
      runId: z.string().describe("Background command runId returned by execute-command when stream=true."),
      maxOutputBytes: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe("Maximum bytes of the tail or incremental chunk to return. Defaults to 65536. Incremental backlog is returned over multiple calls with hasMore=true instead of being skipped."),
      offset: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe("Optional byte offset that overrides the run's stored incremental cursor for this call. The resulting nextOffset becomes the new stored cursor."),
      incremental: z
        .boolean()
        .optional()
        .describe("Default true. Return only output added since this run's stored cursor. When false, return the current tail but still advance the stored cursor to the current file end."),
    },
    async ({ runId, maxOutputBytes, offset, incremental }) => {
      try {
        const status = sshManager.getBackgroundCommandStatus(
          runId,
          maxOutputBytes,
          offset,
          incremental,
        );
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
