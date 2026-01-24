import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SSHConnectionManager } from "../services/ssh-connection-manager.js";
import { Logger } from "../utils/logger.js";

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
    "Execute command on connected server. Uses streaming mode by default for real-time output. Set stream=false for simple commands.",
    {
      cmdString: z.string().describe("Command to execute"),
      connectionName: z
        .string()
        .optional()
        .describe("SSH connection name (optional, uses defaultServer from config)"),
      timeout: z
        .number()
        .optional()
        .describe(
          "Command execution timeout in milliseconds (default: 300000ms for stream=true, 30000ms for stream=false)"
        ),
      stream: z
        .boolean()
        .optional()
        .describe(
          "Enable real-time streaming output (default: true)"
        ),
    },
    async ({ cmdString, connectionName, timeout, stream }, extra) => {
      try {
        // Default to streaming mode (stream=true unless explicitly set to false)
        const useStream = stream !== false;

        if (useStream) {
          // Streaming mode (default)
          const progressToken = extra._meta?.progressToken;
          let progressCounter = 0;

          // Create progress callback if client provided a progress token
          const onProgress = progressToken
            ? (chunk: string) => {
                progressCounter++;
                // Send progress notification with the output chunk
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

          // Execute command with streaming support
          const result = await sshManager.executeCommandWithProgress(
            cmdString,
            connectionName,
            {
              timeout: timeout || 300000, // 5 minutes default for streaming
              onProgress,
            }
          );

          return {
            content: [{ type: "text", text: result }],
          };
        }

        // Non-streaming mode (only when stream=false)
        const result = await sshManager.executeCommand(
          cmdString,
          connectionName,
          {
            timeout: timeout || 30000,
          }
        );
        return {
          content: [{ type: "text", text: result }],
        };
      } catch (error: unknown) {
        const errorMessage = Logger.handleError(
          error,
          "Failed to execute command"
        );
        return {
          content: [{ type: "text", text: errorMessage }],
          isError: true,
        };
      }
    }
  );
}
