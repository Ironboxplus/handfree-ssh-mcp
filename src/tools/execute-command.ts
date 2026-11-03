import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SSHConnectionManager } from "../services/ssh-connection-manager.js";
import { Logger } from "../utils/logger.js";
import { formatToolErrorResponse, toToolError } from "../utils/tool-error.js";
import { rejectUnknownArguments } from "./strict-arguments.js";

/**
 * Register execute command tool
 * 
 * Unified command execution tool.
 * - stream=true (default): start in background and return run metadata
 * - stream=false: wait for completion, 30s timeout
 */
export function registerExecuteCommandTool(server: McpServer): void {
  const sshManager = SSHConnectionManager.getInstance();

  rejectUnknownArguments(server.tool(
    "execute-command",
    "Execute cmdString unchanged in the remote default shell. stream=false waits for output; stream=true (default) returns runId/logPath immediately for polling with command-status. Each call has separate shell state. Background status is lost on MCP restart; use workspace-run for durable tasks. Full output is saved locally; returned output is capped.",
    {
      cmdString: z.string().describe("Exact command for the remote default shell, e.g. pwd or ls -la. No interpreter prefix is required. Compound commands remain subject to command policy."),
      connectionName: z
        .string()
        .optional()
        .describe("Server name from list-servers. Required with multiple enabled servers; optional with one."),
      timeout: z
        .number()
        .positive()
        .optional()
        .describe(
          "Milliseconds per attempt: SSH setup and command execution use this cap; channel opening also respects channelOpenTimeout. Default 300000 for stream=true, 30000 otherwise."
        ),
      stream: z
        .boolean()
        .optional()
        .describe(
          "Default true: return immediately and poll command-status. False: wait for final output in this call."
        ),
      reuseConnection: z
        .boolean()
        .optional()
        .describe(
          "Default true. Set false to use a fresh SSH connection after a suspected stale connection."
        ),
      vvv: z
        .boolean()
        .optional()
        .describe(
          "Default false. Include bounded SSH debug output; fresh handshake logs also require reuseConnection=false."
        ),
      maxOutputBytes: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe(
          "Returned tail limit per stdout/stderr stream, default 65536 bytes. Full output is saved to disk; 0 returns no captured output."
        ),
    },
    async ({ cmdString, connectionName, timeout, stream, reuseConnection, vvv, maxOutputBytes }, extra) => {
      try {
        const resolvedName = sshManager.resolveServer(connectionName);
        const useStream = stream !== false;

        if (useStream) {
          const started = sshManager.startCommandBackground(
            cmdString,
            resolvedName,
            {
              timeout: timeout || 300000,
              maxOutputBytes,
              reuseConnection,
              vvv,
            }
          );

          const progressToken = extra._meta?.progressToken;
          if (progressToken) {
            extra.sendNotification({
              method: "notifications/progress",
              params: {
                progressToken,
                progress: 1,
                message: `Background command started: ${started.runId}`,
              },
            });
          }

          const result = {
            ...started,
            next: `Poll with command-status { "runId": "${started.runId}", "maxOutputBytes": ${maxOutputBytes ?? SSHConnectionManager.DEFAULT_MAX_OUTPUT_BYTES} }; incremental output is enabled by default and its cursor advances automatically`,
          };
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          };
        }

        const result = await sshManager.executeCommand(
          cmdString,
          resolvedName,
          {
            timeout: timeout || 30000,
            maxOutputBytes,
            reuseConnection,
            vvv,
          }
        );
        return {
          content: [{ type: "text", text: result }],
        };
      } catch (error: unknown) {
        const toolError = toToolError(error, "COMMAND_EXECUTION_ERROR");
        Logger.handleError(toolError, "Failed to execute command");
        return {
          content: [{ type: "text", text: formatToolErrorResponse(toolError) }],
          isError: true,
        };
      }
    }
  ));
}
