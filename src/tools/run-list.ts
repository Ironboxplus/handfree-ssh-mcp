import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { RunService, DEFAULT_RUN_LIST_LIMIT, MAX_RUN_LIST_LIMIT } from "../run/run-service.js";
import { runErrorEnvelope, toToolResult } from "./run-envelope.js";
import { rejectUnknownArguments } from "./strict-arguments.js";

export function registerRunListTool(server: McpServer): void {
  const runService = RunService.getInstance();

  rejectUnknownArguments(server.tool(
    "run-list",
    "List workspace-run tasks on the selected server, newest first. Reads remote state; corrupt or incomplete entries are omitted (query run-status for their errors). Default limit 50, maximum 200.",
    {
      connectionName: z.string().optional().describe("Server name from list-servers. Required with multiple enabled servers; optional with one."),
      profile: z.string().optional().describe("Filter by saved profile name, or (ad-hoc) for inline tasks."),
      state: z.enum(["running", "completed", "failed", "cancelled", "recovering", "orphaned"]).optional().describe("Filter by task state."),
      limit: z.number().int().positive().max(MAX_RUN_LIST_LIMIT).optional().describe("Default 50, maximum 200."),
      reuseConnection: z.boolean().optional().describe("Default true. Set false to use a fresh SSH connection after a suspected stale connection."),
    },
    async ({ connectionName, profile, state, limit, reuseConnection }) => {
      try {
        const runs = await runService.list(connectionName, { profile, state, limit, reuseConnection });
        return toToolResult({
          ok: true,
          jobId: "run-list",
          state: "completed",
          message: `found ${runs.length} run(s).`,
          details: { runs },
        });
      } catch (error) {
        return toToolResult(runErrorEnvelope(error), true);
      }
    },
  ));
}
