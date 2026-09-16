import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { RunService } from "../run/run-service.js";
import { runErrorEnvelope, toToolResult } from "./run-envelope.js";

/**
 * PLAN.MD P2-05: registers workspace-run. This dispatch implements the
 * `launch` mechanics only (preflight -> launching -> remote-running); the
 * `push` and `collect` phases (P2-02/P2-06) are not implemented and are
 * rejected explicitly (PUSH_NOT_AVAILABLE / COLLECT_NOT_AVAILABLE) rather
 * than silently skipped when actually requested -- see run-service.ts.
 */
export function registerWorkspaceRunTool(server: McpServer): void {
  const runService = RunService.getInstance();

  server.tool(
    "workspace-run",
    "Launch an entrypoint on a remote server under a configured runProfiles.<name> entry, durably: the launched process survives SSH disconnect and MCP adapter restart, because all of its state (meta.json/stdout.log/stderr.log/pid/heartbeat/exit.json) lives on the remote filesystem under ~/.handfree-runs/<runId>/, not locally. There is no local cache of run state -- status/logs/cancel require the remote server to be reachable. " +
      "This delivery round implements the launch phase only (PLAN.MD Phase 2, P2-03/04/05): push must be false (the code must already exist under the profile's remoteRoot -- requesting push, or leaving it at its true default, returns PUSH_NOT_AVAILABLE) and collect must be empty/omitted (a non-empty collect returns COLLECT_NOT_AVAILABLE). sync only accepts 'none'/omitted; sync:'flush' returns SYNC_NOT_AVAILABLE (deferred to Phase 3). " +
      "Only environment.type venv/executable run profiles are supported; conda/module/slurm and gpu.required/secretEnv profiles return a *_NOT_AVAILABLE error. " +
      "Returns immediately once the remote process is confirmed started (does not wait for it to finish) -- poll run-status/run-logs for progress and run-cancel to stop it.",
    {
      profile: z.string().min(1).describe("Name of a runProfiles.<name> entry from this server's YAML config."),
      entrypoint: z.string().min(1).describe("Path to the script/program to run, relative to the profile's remoteRoot. Must match one of the profile's allowedEntrypoints glob patterns, and must be a plain relative path (no '..', not absolute)."),
      args: z.array(z.string()).optional().describe("Positional arguments passed to the entrypoint. Each is quoted individually on the remote shell and never interpreted -- safe for arbitrary strings including spaces, quotes, and shell metacharacters."),
      env: z.record(z.string(), z.string()).optional().describe("Environment variable overrides. Every key must already be a key of the profile's own env map (the profile's env doubles as the allowlist); an unrecognized key returns ENV_KEY_NOT_ALLOWED."),
      server: z.string().optional().describe("Target server name. Defaults to the profile's configured server. Only needed to override that default."),
      push: z.boolean().optional().describe("Must be explicitly false in this delivery round. Omitting it (or passing true) returns PUSH_NOT_AVAILABLE -- the push phase (P2-02) is not implemented yet."),
      collect: z.array(z.string()).optional().describe("Must be empty or omitted in this delivery round. A non-empty array returns COLLECT_NOT_AVAILABLE -- the collect phase (P2-06) is not implemented yet; use download/transfer to retrieve artifacts instead."),
      sync: z.enum(["none", "flush"]).optional().describe("Only 'none' (or omitted) is available. 'flush' returns SYNC_NOT_AVAILABLE (Phase 3)."),
    },
    async ({ profile, entrypoint, args, env, server, push, collect, sync }) => {
      try {
        const result = await runService.launch({ profile, entrypoint, args, env, server, push, collect, sync });
        return toToolResult({
          ok: true,
          jobId: result.runId,
          state: result.status.state,
          message: `Launched run '${result.runId}' on server '${result.server}'.`,
          next: `Poll run-status { runId: "${result.runId}" } or run-logs { runId: "${result.runId}" } for progress; run-cancel { runId: "${result.runId}" } to stop it.`,
          details: { runId: result.runId, server: result.server, phases: result.phases, status: result.status },
        });
      } catch (error) {
        return toToolResult(runErrorEnvelope(error), true);
      }
    },
  );
}
