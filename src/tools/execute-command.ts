import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SSHConnectionManager } from "../services/ssh-connection-manager.js";
import { Logger } from "../utils/logger.js";
import { formatToolErrorResponse, toToolError } from "../utils/tool-error.js";

/**
 * Register execute command tool
 * 
 * Unified command execution tool with streaming by default.
 * - stream=true (default): Real-time output with 5 min timeout
 * - stream=false: Wait for completion, 30s timeout
 */
export function registerExecuteCommandTool(server: McpServer): void {
  const sshManager = SSHConnectionManager.getInstance();

  server.tool(
    "execute-command",
    "Execute a shell command on a remote server over SSH. Use this for command-line actions on the selected host. Streaming mode is enabled by default so long-running commands can emit progress; set stream=false for short commands where you only want the final output.",
    {
      cmdString: z.string().describe("Exact remote shell command to run. Prefer a single command per call, for example 'pwd', 'ls -la', 'cat /etc/hostname', or 'git status'. Compound commands may be blocked by whitelist rules even if each subcommand is safe."),
      connectionName: z
        .string()
        .optional()
        .describe("Target server name from list-servers. Required when multiple servers are enabled; optional when only one server is enabled."),
      timeout: z
        .number()
        .optional()
        .describe(
          "Maximum runtime in milliseconds. Defaults to 300000 when stream=true and 30000 when stream=false. Increase this for long-running commands; reduce it for fast probes."
        ),
      stream: z
        .boolean()
        .optional()
        .describe(
          "Whether to stream progress output. Default is true. Use false for short commands like pwd, ls, cat, head, tail, or git status when you only need the final result."
        ),
    },
    async ({ cmdString, connectionName, timeout, stream }, extra) => {
      try {
        const resolvedName = sshManager.resolveServer(connectionName);
        const useStream = stream !== false;

        if (useStream) {
          const progressToken = extra._meta?.progressToken;
          let progressCounter = 0;

          const onProgress = progressToken
            ? (chunk: string) => {
                progressCounter++;
                extra.sendNotification({
                  method: "notifications/progress",
                  params: {
                    progressToken,
                    progress: progressCounter,
                    message: chunk,
                  },
                });
              }
            : undefined;

          const result = await sshManager.executeCommandWithProgress(
            cmdString,
            resolvedName,
            {
              timeout: timeout || 300000,
              onProgress,
            }
          );

          return {
            content: [{ type: "text", text: result }],
          };
        }

        const result = await sshManager.executeCommand(
          cmdString,
          resolvedName,
          {
            timeout: timeout || 30000,
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
  );
}
