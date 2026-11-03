import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SSHConnectionManager } from "../services/ssh-connection-manager.js";
import { Logger } from "../utils/logger.js";
import { formatToolErrorResponse, toToolError } from "../utils/tool-error.js";
import { rejectUnknownArguments } from "./strict-arguments.js";

/**
 * Register list-servers tool
 */
export function registerListServersTool(server: McpServer): void {
  rejectUnknownArguments(server.tool(
    "list-servers",
    "List configured servers with enabled/connected state and jump hosts. Use the returned names as connectionName (server in workspace-run). verbose includes cached system status; refresh probes enabled servers for live status.",
    {
      verbose: z.boolean().optional().describe("Default false. Include cached system status; refresh=true implies verbose."),
      refresh: z.boolean().optional().describe("Default false. Probe enabled servers for live system status; implies verbose."),
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
  ));
}
