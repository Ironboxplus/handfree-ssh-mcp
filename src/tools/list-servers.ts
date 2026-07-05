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
    "List the SSH servers that were loaded from OpenSSH config and/or YAML and enabled for this MCP process. Use this first to discover valid connectionName values, confirm whether a server is enabled, see jumpHost wiring, and check basic connection state before calling other tools. By default the response is lean (identity + connection state only). Set verbose=true to include the cached system status block (hostname, CPU, memory, disk, GPUs). Set refresh=true to re-collect that status from live servers; refresh implies verbose.",
    {
      verbose: z.boolean().optional().describe("Include the cached system status block (hostname, CPU, memory, disk, GPUs, etc.) for each server. Off by default to keep the response small. Implied by refresh=true."),
      refresh: z.boolean().optional().describe("Re-collect live system status from all enabled servers before returning. Implies verbose=true. Without this, status (if requested via verbose) is read from the cache populated at connect time."),
    },
    async ({ verbose, refresh }) => {
      try {
        const sshManager = SSHConnectionManager.getInstance();

        if (refresh) {
          await sshManager.refreshStatus();
        }

        const wantStatus = verbose === true || refresh === true;
        const servers = sshManager.getAllServerInfos({ verbose: wantStatus });
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
