import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { RunService } from "../run/run-service.js";
import { runErrorEnvelope, toToolResult } from "./run-envelope.js";

export function registerRunStatusTool(server: McpServer): void {
  const runService = RunService.getInstance();

  server.tool(
    "run-status",
    "Query the current status of a workspace-run launch by runId. Read directly from the remote state directory over SFTP every call -- there is no local cache, so the remote server must be reachable, and a restarted MCP adapter can query exactly as well as one that has been running the whole time. Returns exitCode/signal once the run has finished.",
    {
      runId: z.string().min(1).describe("runId returned by workspace-run."),
      connectionName: z.string().optional().describe("Target server name from list-servers (the server the run was launched on). Required when multiple servers are enabled; optional when only one server is enabled."),
      reuseConnection: z.boolean().optional().describe("Whether to reuse the cached SSH connection for this server. Default true. Set false after a timeout or suspected stale/bad cached connection to force a fresh one for this call."),
    },
    async ({ runId, connectionName, reuseConnection }) => {
      try {
        const status = await runService.getStatus(connectionName, runId, reuseConnection);
        return toToolResult({
          ok: true,
          jobId: status.runId,
          state: status.state,
          message: `run '${status.runId}' is ${status.state}${status.state === "recovering" ? " (heartbeat is stale or missing; state is ambiguous until confirmed)" : ""}.`,
          details: status,
        });
      } catch (error) {
        return toToolResult(runErrorEnvelope(error), true);
      }
    },
  );
}
