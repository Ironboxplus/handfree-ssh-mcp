import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SSHConnectionManager } from "../services/ssh-connection-manager.js";
import { Logger } from "../utils/logger.js";
import { formatToolErrorResponse, toToolError } from "../utils/tool-error.js";

/**
 * Register list-servers tool
 */
export function registerListServersTool(server: McpServer): void {
  server.tool(
    "list-servers",
    "List the SSH servers that were loaded from YAML and enabled for this MCP process. Use this first to discover valid connectionName values, confirm whether a server is enabled, and see basic connection state before calling other tools. Set refresh=true to collect live system status (hostname, CPU, memory, disk, GPUs) from connected servers.",
    {
      refresh: z.boolean().optional().describe("When true, re-collects live system status from all enabled servers before returning. Without this, cached status from connection time is returned."),
    },
    async ({ refresh }) => {
      try {
        const sshManager = SSHConnectionManager.getInstance();

        if (refresh) {
          await sshManager.refreshStatus();
        }

        const servers = sshManager.getAllServerInfos();
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(servers),
            },
          ],
        };
      } catch (error: unknown) {
        const toolError = toToolError(error, "INVALID_CONFIGURATION");
        Logger.handleError(toolError, "Failed to list servers");
        return {
          content: [{ type: "text", text: formatToolErrorResponse(toolError) }],
          isError: true,
        };
      }
    },
  );
}
