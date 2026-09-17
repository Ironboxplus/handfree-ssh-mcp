import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { RunService } from "../run/run-service.js";
import { runErrorEnvelope, toToolResult } from "./run-envelope.js";

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

  server.tool(
    "run-retry",
    "Launch a fresh run from an earlier workspace-run's stored config snapshot (profile, entrypoint, args, env, push/collect settings) rather than the live runProfiles config -- so a config hot-reload or a since-deleted profile cannot change what gets retried. Returns a NEW runId recording parentRunId; the original run is untouched. Requires the original run to have been launched by a build that recorded a config snapshot (RETRY_SNAPSHOT_UNAVAILABLE otherwise). Returns SECRET_REQUIRED if the snapshot declares secretEnv, which this delivery round cannot re-resolve.",
    {
      runId: z.string().min(1).describe("runId of the run to retry (returned by an earlier workspace-run or run-retry call)."),
      connectionName: z.string().optional().describe("Target server name from list-servers (the server the original run was launched on). Required when multiple servers are enabled; optional when only one server is enabled."),
      push: z.boolean().optional().describe("Defaults to the snapshot's own default: true for a profile-backed run that declared push.paths, but FALSE for a run launched inline without pushPaths (an inline run never pushed in the first place, so its retry does not either). Pass true to force a re-push -- only meaningful if the snapshot actually has push sources, otherwise it returns INVALID_CONFIGURATION -- or false to reuse whatever code is already on remoteRoot."),
      reuseConnection: z.boolean().optional().describe("Whether to reuse the cached SSH connection for this server. Default true. Set false after a timeout or suspected stale/bad cached connection to force a fresh one for this call."),
    },
    async ({ runId, connectionName, push, reuseConnection }) => {
      try {
        const result = await runService.retry(connectionName, runId, push, reuseConnection);
        return toToolResult({
          ok: true,
          jobId: result.runId,
          state: result.status.state,
          message: `Retried run '${runId}' as new run '${result.runId}' on server '${result.server}'.`,
          next: `Poll run-status { runId: "${result.runId}" } or run-logs { runId: "${result.runId}" } for progress; run-cancel { runId: "${result.runId}" } to stop it.`,
          details: { runId: result.runId, parentRunId: runId, server: result.server, phases: result.phases, status: result.status, collect: result.collect },
        });
      } catch (error) {
        return toToolResult(runErrorEnvelope(error), true);
      }
    },
  );
}
