import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { RunService } from "../run/run-service.js";
import { runErrorEnvelope, toToolResult } from "./run-envelope.js";

/**
 * PLAN.MD P2-02/P2-05/P2-06: registers workspace-run. This round implements
 * the full pipeline: [push] -> preflight -> launching -> remote-running ->
 * [collect]. push defaults to true (profile defaultPush may override) and
 * requires runProfiles.<name>.push.paths to be configured; collect defaults
 * to the profile's collect.paths (never the whole remoteRoot) and requires
 * runProfiles.<name>.collect.localDir.
 *
 * A plain launch (no collect requested -- the common case) still returns as
 * soon as the remote process is confirmed started, unchanged from before
 * this round. When collect IS requested, this call additionally blocks
 * (bounded by timeout) until the run reaches a terminal state, then collects
 * -- see run-service.ts's waitForTerminalStatus/runCollect. The run itself
 * is durable either way: it keeps running on the remote host regardless of
 * what this tool call does or how long it waits.
 */
export function registerWorkspaceRunTool(server: McpServer): void {
  const runService = RunService.getInstance();

  server.tool(
    "workspace-run",
    "Launch an entrypoint on a remote server under a configured runProfiles.<name> entry, durably: the launched process survives SSH disconnect and MCP adapter restart, because all of its state (meta.json/stdout.log/stderr.log/pid/heartbeat/exit.json) lives on the remote filesystem under ~/.handfree-runs/<runId>/, not locally. There is no local cache of run state -- status/logs/cancel require the remote server to be reachable. " +
      "Full pipeline this round: [push] -> preflight -> launching -> remote-running -> [collect]. push (default true, or profile defaultPush) uploads runProfiles.<name>.push.paths to remoteRoot first (batch/recursive upload, skip-if-identical) and requires push.paths to be configured; pass push:false to skip it (code must already exist under remoteRoot). collect (default the profile's collect.paths) pulls artifacts back by explicit glob after the run finishes and requires collect.localDir to be configured; pass collect:[] to disable it. Requesting collect makes this call block (bounded by timeout) until the run reaches a terminal state before returning -- omitting collect keeps the original fire-and-forget behavior (returns as soon as the process is confirmed started). " +
      "sync only accepts 'none'/omitted; sync:'flush' returns SYNC_NOT_AVAILABLE (deferred to Phase 3). " +
      "Only environment.type venv/executable run profiles are supported; conda/module/slurm and gpu.required/secretEnv profiles return a *_NOT_AVAILABLE error.",
    {
      profile: z.string().min(1).describe("Name of a runProfiles.<name> entry from this server's YAML config."),
      entrypoint: z.string().min(1).describe("Path to the script/program to run, relative to the profile's remoteRoot. Must match one of the profile's allowedEntrypoints glob patterns, and must be a plain relative path (no '..', not absolute)."),
      args: z.array(z.string()).optional().describe("Positional arguments passed to the entrypoint. Each is quoted individually on the remote shell and never interpreted -- safe for arbitrary strings including spaces, quotes, and shell metacharacters."),
      env: z.record(z.string(), z.string()).optional().describe("Environment variable overrides. Every key must already be a key of the profile's own env map (the profile's env doubles as the allowlist); an unrecognized key returns ENV_KEY_NOT_ALLOWED."),
      server: z.string().optional().describe("Target server name. Defaults to the profile's configured server. Only needed to override that default."),
      push: z.boolean().optional().describe("Default true (or the profile's defaultPush). Uploads runProfiles.<name>.push.paths to remoteRoot before launch; requires push.paths to be configured on the profile, or returns INVALID_CONFIGURATION. Pass false to skip and use code already present under remoteRoot."),
      collect: z.array(z.string()).optional().describe("Glob patterns (relative to remoteRoot) of artifacts to pull back after the run finishes. Defaults to the profile's collect.paths; an empty array explicitly disables collect for this call. Requesting collect makes this call wait (bounded by timeout) for the run to finish. Requires runProfiles.<name>.collect.localDir to be configured."),
      sync: z.enum(["none", "flush"]).optional().describe("Only 'none' (or omitted) is available. 'flush' returns SYNC_NOT_AVAILABLE (Phase 3)."),
      timeout: z.number().int().positive().optional().describe("Only meaningful when collect actually runs: milliseconds to wait for the run to reach a terminal state before giving up on collect (the run itself keeps running regardless). Defaults to the profile's timeout, or 600000ms (10 minutes)."),
    },
    async ({ profile, entrypoint, args, env, server, push, collect, sync, timeout }) => {
      try {
        const result = await runService.launch({ profile, entrypoint, args, env, server, push, collect, sync, timeout });
        return toToolResult({
          ok: true,
          jobId: result.runId,
          state: result.status.state,
          message: `Launched run '${result.runId}' on server '${result.server}'.`,
          next: `Poll run-status { runId: "${result.runId}" } or run-logs { runId: "${result.runId}" } for progress; run-cancel { runId: "${result.runId}" } to stop it.`,
          details: { runId: result.runId, server: result.server, phases: result.phases, status: result.status, collect: result.collect },
        });
      } catch (error) {
        return toToolResult(runErrorEnvelope(error), true);
      }
    },
  );
}
