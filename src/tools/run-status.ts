import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { RunService } from "../run/run-service.js";
import { runErrorEnvelope, toToolResult } from "./run-envelope.js";
import { rejectUnknownArguments } from "./strict-arguments.js";

export function registerRunStatusTool(server: McpServer): void {
  const runService = RunService.getInstance();

  rejectUnknownArguments(server.tool(
    "run-status",
    "Read a workspace-run task status from the remote state directory. Requires the original server to be reachable; works after MCP restart. Returns exitCode/signal when finished.",
    {
      runId: z.string().min(1).describe("runId from workspace-run or run-retry."),
      connectionName: z.string().optional().describe("Server name from list-servers. Required with multiple enabled servers; optional with one."),
      reuseConnection: z.boolean().optional().describe("Default true. Set false to use a fresh SSH connection after a suspected stale connection."),
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
  ));
}
