import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { RunService, DEFAULT_CANCEL_GRACE_MS } from "../run/run-service.js";
import { runErrorEnvelope, toToolResult } from "./run-envelope.js";
import { rejectUnknownArguments } from "./strict-arguments.js";

/**
 * PLAN.MD P2-04: cancel re-verifies the recorded process identity (remote
 * boot id, pid, pgid, /proc start ticks, wrapper token read back from the
 * live process's own environment) before ever sending a signal. A mismatch
 * -- pid reuse, host reboot -- moves the run to `orphaned` instead of
 * signalling a process that is no longer provably the one this run started.
 */
export function registerRunCancelTool(server: McpServer): void {
  const runService = RunService.getInstance();

  rejectUnknownArguments(server.tool(
    "run-cancel",
    "Cancel a workspace-run task after verifying its live process identity. Send TERM to the process group, then KILL after graceMs if needed. An identity mismatch marks it orphaned without signalling; repeated cancellation is safe.",
    {
      runId: z.string().min(1).describe("runId from workspace-run or run-retry."),
      connectionName: z.string().optional().describe("Server name from list-servers. Required with multiple enabled servers; optional with one."),
      graceMs: z.number().int().nonnegative().optional().describe("Milliseconds after TERM before KILL, default 5000."),
      reuseConnection: z.boolean().optional().describe("Default true. Set false to use a fresh SSH connection after a suspected stale connection."),
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
  ));
}
