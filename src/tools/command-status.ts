import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SSHConnectionManager } from "../services/ssh-connection-manager.js";
import { Logger } from "../utils/logger.js";
import { formatToolErrorResponse, toToolError } from "../utils/tool-error.js";
import { rejectUnknownArguments } from "./strict-arguments.js";

export function registerCommandStatusTool(server: McpServer): void {
  const sshManager = SSHConnectionManager.getInstance();

  rejectUnknownArguments(server.tool(
    "command-status",
    "Read status and output for execute-command with stream=true. Incremental polling advances a process-local cursor per runId; offset overrides it. After MCP restart, status is unavailable; read the saved logPath directly.",
    {
      runId: z.string().describe("runId from execute-command with stream=true."),
      maxOutputBytes: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe("Maximum output bytes, default 65536. Incremental backlog is paged with hasMore=true."),
      offset: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe("Byte offset overriding the stored cursor; nextOffset becomes the new cursor."),
      incremental: z
        .boolean()
        .optional()
        .describe("Default true: return new output. False: return the current tail and advance the cursor to file end."),
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
  ));
}
