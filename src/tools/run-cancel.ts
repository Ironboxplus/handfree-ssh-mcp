import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { RunService, DEFAULT_CANCEL_GRACE_MS } from "../run/run-service.js";
import { runErrorEnvelope, toToolResult } from "./run-envelope.js";

/**
 * PLAN.MD P2-04: cancel re-verifies the recorded process identity (remote
 * boot id, pid, pgid, /proc start ticks, wrapper token read back from the
 * live process's own environment) before ever sending a signal. A mismatch
 * -- pid reuse, host reboot -- moves the run to `orphaned` instead of
 * signalling a process that is no longer provably the one this run started.
 */
export function registerRunCancelTool(server: McpServer): void {
  const runService = RunService.getInstance();

  server.tool(
    "run-cancel",
    "Cancel a workspace-run: sends TERM to its whole remote process group, waits graceMs, then KILL if it is still alive. Re-verifies the recorded process identity (boot id, pid, pgid, /proc start ticks, wrapper token) against what is actually running right now before sending any signal -- on a mismatch (e.g. pid reuse after a reboot) the run moves to 'orphaned' instead, and nothing is signalled. Idempotent: cancelling an already-finished or already-orphaned run just reports that outcome again.",
    {
      runId: z.string().min(1).describe("runId returned by workspace-run."),
      connectionName: z.string().optional().describe("Target server name from list-servers (the server the run was launched on). Required when multiple servers are enabled; optional when only one server is enabled."),
      graceMs: z.number().int().nonnegative().optional().describe(`Milliseconds to wait after TERM before escalating to KILL. Default ${DEFAULT_CANCEL_GRACE_MS}.`),
      reuseConnection: z.boolean().optional().describe("Whether to reuse the cached SSH connection for this server. Default true. Set false after a timeout or suspected stale/bad cached connection to force a fresh one for this call."),
    },
    async ({ runId, connectionName, graceMs, reuseConnection }) => {
      try {
        const result = await runService.cancel(connectionName, runId, graceMs, reuseConnection);
        if (result.outcome === "already-exited") {
          const status = await runService.getStatus(connectionName, runId, reuseConnection);
          return toToolResult({
            ok: true,
            jobId: runId,
            state: status.state,
            message: `run '${runId}' had already finished (state: ${status.state}); no signal was sent.`,
            details: { runId, outcome: result.outcome, status },
          });
        }
        const state = result.outcome === "orphaned" ? "orphaned" : "cancelling";
        return toToolResult({
          ok: true,
          jobId: runId,
          state,
          message:
            result.outcome === "orphaned"
              ? `run '${runId}' could not be safely signalled and was moved to orphaned: ${result.reason}`
              : `run '${runId}' was ${result.outcome === "killed" ? "force-killed (KILL, after it ignored TERM)" : "terminated (TERM)"}. Poll run-status for the final exit record.`,
          details: { runId, outcome: result.outcome, reason: result.reason },
        });
      } catch (error) {
        return toToolResult(runErrorEnvelope(error), true);
      }
    },
  );
}
