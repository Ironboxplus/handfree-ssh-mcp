import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SSHConnectionManager } from "../services/ssh-connection-manager.js";
import { Logger } from "../utils/logger.js";

/**
 * Register execute command stream tool
 * 
 * This tool executes commands with real-time streaming output via MCP progress notifications.
 * Unlike the regular execute-command tool, this one sends progress updates as output is received,
 * making it suitable for long-running tasks with progress bars or continuous output.
 */
export function registerExecuteCommandStreamTool(server: McpServer): void {
  const sshManager = SSHConnectionManager.getInstance();

  server.tool(
    "execute-command-stream",
    "Execute command with real-time streaming output via progress notifications. Use for long-running tasks.",
    {
      cmdString: z.string().describe("Command to execute"),
      connectionName: z
        .string()
        .optional()
        .describe("SSH connection name (optional, default is 'default')"),
      timeout: z
        .number()
        .optional()
        .describe(
          "Command execution timeout in milliseconds (optional, default is 300000ms / 5 minutes)"
        ),
    },
    async ({ cmdString, connectionName, timeout }, extra) => {
      try {
        // Get progress token from request metadata
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
      } catch (error: unknown) {
        const errorMessage = Logger.handleError(
          error,
          "Failed to execute streaming command"
        );
        return {
          content: [{ type: "text", text: errorMessage }],
          isError: true,
        };
      }
    }
  );
}
