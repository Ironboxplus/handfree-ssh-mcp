import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { RunService } from "../run/run-service.js";
import { runErrorEnvelope, toToolResult } from "./run-envelope.js";
import { rejectUnknownArguments } from "./strict-arguments.js";

/**
 * PLAN.MD P2-04: run-retry launches a fresh run from an EARLIER run's own
 * stored, non-secret config snapshot (see run-service.ts's retry()) rather
 * than the live runProfiles config, so a since-hot-reloaded or since-deleted
 * profile cannot change what a retry actually runs. The new run gets its own
 * runId and records parentRunId; the original run is untouched (still
 * queryable by its own runId).
 */
export function registerRunRetryTool(server: McpServer): void {
  const runService = RunService.getInstance();

  rejectUnknownArguments(server.tool(
    "run-retry",
    "Start a new workspace-run task using an earlier task's saved config snapshot. Returns a new runId with parentRunId; jobId equals the new runId. Missing snapshots return RETRY_SNAPSHOT_UNAVAILABLE; snapshots with secretEnv return SECRET_REQUIRED.",
    {
      runId: z.string().min(1).describe("Original workspace-run/run-retry runId."),
      connectionName: z.string().optional().describe("Server name from list-servers. Required with multiple enabled servers; optional with one."),
      push: z.boolean().optional().describe("Defaults to saved defaultPush, otherwise true. Inline without pushPaths saves false. True requires saved push sources; false reuses current remote code."),
      reuseConnection: z.boolean().optional().describe("Default true. Set false to use a fresh SSH connection after a suspected stale connection."),
    },
    async ({ runId, connectionName, push, reuseConnection }) => {
      try {
        const result = await runService.retry(connectionName, runId, push, reuseConnection);
        return toToolResult({
          ok: true,
          jobId: result.runId,
          state: result.status.state,
          message: `Retried run '${runId}' as new run '${result.runId}' on server '${result.server}'.`,
          next: `Poll run-status { "runId": ${JSON.stringify(result.runId)}, "connectionName": ${JSON.stringify(result.server)} } or run-logs { "runId": ${JSON.stringify(result.runId)}, "connectionName": ${JSON.stringify(result.server)} } for progress; run-cancel { "runId": ${JSON.stringify(result.runId)}, "connectionName": ${JSON.stringify(result.server)} } to stop it.`,
          details: { runId: result.runId, parentRunId: runId, server: result.server, phases: result.phases, status: result.status, collect: result.collect },
        });
      } catch (error) {
        return toToolResult(runErrorEnvelope(error), true);
      }
    },
  ));
}
