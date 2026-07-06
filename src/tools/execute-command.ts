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
    "Execute a shell command on a remote server over SSH. Use this for command-line actions on the selected host. Streaming mode is enabled by default so long-running commands can emit progress; set stream=false for short commands where you only want the final output. SSH connections are reused by default for speed; if an execute-command call times out or you suspect a stale cached SSH connection, retry with reuseConnection=false to force a fresh TCP/SSH connection for that command. Set vvv=true only when debugging SSH/channel issues; with reuseConnection=false it includes ssh2 handshake/debug lines in the result or error. The returned text is tail-only-capped at maxOutputBytes PER STREAM (default 65536 bytes for stdout and 65536 bytes for stderr, so the response can be up to ~2x that); the FULL stdout/stderr is always persisted to a local log file under <cwd>/.handfree-output/<server>/<user>/, and the response includes that path whenever output was truncated. For long-running tasks that may exceed the command timeout, do NOT block on a single call: launch the task detached and redirect its output on the remote (e.g. 'nohup <cmd> > ~/task.log 2>&1 &'), then poll periodically with short follow-up calls (e.g. 'tail -n 50 ~/task.log' or checking the process/exit status). This avoids tying up the connection and losing output if the call times out.",
    {
      cmdString: z.string().describe("Exact remote shell command to run. Prefer a single command per call, for example 'pwd', 'ls -la', 'cat /etc/hostname', or 'git status'. Compound commands may be blocked by command policy even if each subcommand is safe."),
      connectionName: z
        .string()
        .optional()
        .describe("Target server name from list-servers. Required when multiple servers are enabled; optional when only one server is enabled."),
      timeout: z
        .number()
        .positive()
        .optional()
        .describe(
          "Timeout in milliseconds applied separately to SSH connection setup, exec-channel opening, and remote command execution for each attempt. Defaults to 300000 when stream=true and 30000 when stream=false. Increase this for long-running commands; reduce it for fast probes."
        ),
      stream: z
        .boolean()
        .optional()
        .describe(
          "Whether to stream progress output. Default is true. Use false for short commands like pwd, ls, cat, head, tail, or git status when you only need the final result."
        ),
      reuseConnection: z
        .boolean()
        .optional()
        .describe(
          "Whether to reuse the cached SSH connection for this server. Default is true for speed. Set false after a timeout or suspected stale/bad cached connection; false opens a fresh SSH connection for this command and closes it afterwards."
        ),
      vvv: z
        .boolean()
        .optional()
        .describe(
          "Default false. When true, append bounded SSH/channel debug output to the result or error. For full ssh2 handshake debug, also set reuseConnection=false; already-reused cached clients cannot retroactively emit handshake logs."
        ),
      maxOutputBytes: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe(
          "Per-stream cap on bytes returned to the caller (tail-only). Applied independently to stdout and stderr, so the combined response can be up to ~2x this value. Defaults to 65536 (64 KiB). The full output is always saved to disk regardless; only the returned text is trimmed. Set higher when you need more context, lower to save tokens."
        ),
    },
    async ({ cmdString, connectionName, timeout, stream, reuseConnection, vvv, maxOutputBytes }, extra) => {
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
              maxOutputBytes,
              reuseConnection,
              vvv,
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
  );
}
