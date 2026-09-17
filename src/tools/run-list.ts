import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { RunService, DEFAULT_RUN_LIST_LIMIT, MAX_RUN_LIST_LIMIT } from "../run/run-service.js";
import { runErrorEnvelope, toToolResult } from "./run-envelope.js";

export function registerRunListTool(server: McpServer): void {
  const runService = RunService.getInstance();

  server.tool(
    "run-list",
    `List workspace-run runs on a server, newest first, by reading ~/.handfree-runs/ over SFTP (no local cache). Bounded to ${MAX_RUN_LIST_LIMIT} entries max per call regardless of the requested limit. A run whose state directory is corrupt or mid-write is silently omitted from the list (query it directly with run-status for the detailed error).`,
    {
      connectionName: z.string().optional().describe("Target server name from list-servers. Required when multiple servers are enabled; optional when only one server is enabled."),
      profile: z.string().optional().describe("Only return runs launched under this runProfiles.<name>. Runs launched inline (no profile -- remoteRoot + venv/executable passed straight to workspace-run) are all recorded under the literal label \"(ad-hoc)\", so pass that to list them."),
      state: z.enum(["running", "completed", "failed", "cancelled", "recovering", "orphaned"]).optional().describe("Only return runs in this state."),
      limit: z.number().int().positive().max(MAX_RUN_LIST_LIMIT).optional().describe(`Default ${DEFAULT_RUN_LIST_LIMIT}, max ${MAX_RUN_LIST_LIMIT}.`),
    },
    async ({ connectionName, profile, state, limit }) => {
      try {
        const runs = await runService.list(connectionName, { profile, state, limit });
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
  );
}
