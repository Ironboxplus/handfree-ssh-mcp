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
    "Launch an entrypoint on a remote server, durably: the launched process survives SSH disconnect and MCP adapter restart, because all of its state (meta.json/stdout.log/stderr.log/pid/heartbeat/exit.json) lives on the remote filesystem under ~/.handfree-runs/<runId>/, not locally. There is no local cache of run state -- status/logs/cancel require the remote server to be reachable. " +
      "NO CONFIG REQUIRED: pass remoteRoot plus venv (or executable) inline and it runs against any enabled SSH server, including ones that come from ~/.ssh/config. Example: { server: \"gpu-box\", remoteRoot: \"/data/proj\", venv: \"/data/envs/proj\", entrypoint: \"train.py\", args: [\"--epochs\", \"10\"] }. A saved runProfiles.<name> entry is an optional preset for the same fields (and the only way to NARROW what may run, via allowedEntrypoints) -- not a prerequisite. " +
      "Full pipeline: [push] -> preflight -> launching -> remote-running -> [collect]. push uploads the push sources to remoteRoot first (batch/recursive upload, skip-if-identical); it defaults to true for a profile that declares push.paths and to false for an inline run unless you pass pushPaths. collect (default the profile's collect.paths) pulls artifacts back by explicit glob after the run finishes and needs a local destination (profile collect.localDir, or collectLocalDir inline); pass collect:[] to disable it. Requesting collect makes this call block (bounded by timeout) until the run reaches a terminal state before returning -- omitting collect keeps the original fire-and-forget behavior (returns as soon as the process is confirmed started). " +
      "sync only accepts 'none'/omitted; sync:'flush' returns SYNC_NOT_AVAILABLE (deferred to Phase 3). " +
      "Only environment.type venv/executable is supported (inline venv/executable always is); a configured profile using conda/module/slurm or gpu.required/secretEnv returns a *_NOT_AVAILABLE error.",
    {
      profile: z.string().min(1).optional().describe("Optional. Name of a saved runProfiles.<name> entry from this server's YAML config. Omit it to run inline with no YAML at all: pass remoteRoot plus venv or executable instead."),
      remoteRoot: z.string().min(1).optional().describe("Inline mode (no profile): absolute remote directory the entrypoint lives in. It is also the working directory of the launched process and the root that entrypoint/collect globs resolve against. Ignored when profile is given (the profile's own remoteRoot wins)."),
      venv: z.string().min(1).optional().describe("Inline mode: absolute path to a Python virtualenv on the remote. The process runs <venv>/bin/python (or <venv>/bin/<executable> if executable is also given) directly -- no 'source activate' needed."),
      executable: z.string().min(1).optional().describe("Inline mode: the interpreter/program to run the entrypoint with, e.g. 'bash', 'python3', '/usr/bin/node'. With venv, this instead names the binary inside <venv>/bin. One of venv or executable is required in inline mode."),
      pushPaths: z.array(z.string().min(1)).optional().describe("Inline mode: local files/directories to upload into remoteRoot before launch (skip-if-identical). Supplying this turns push on; omitting it means push defaults to false for an inline run, because remoteRoot is assumed to already hold the code."),
      collectLocalDir: z.string().min(1).optional().describe("Inline mode: local directory that collected artifacts are written into. Required if you pass collect with a non-empty list."),
      entrypoint: z.string().min(1).describe("Path to the script/program to run, relative to remoteRoot. Must be a plain relative path (no '..', not absolute). With a profile, it must also match one of that profile's allowedEntrypoints globs; inline runs allow any relative path under remoteRoot."),
      args: z.array(z.string()).optional().describe("Positional arguments passed to the entrypoint. Each is quoted individually on the remote shell and never interpreted -- safe for arbitrary strings including spaces, quotes, and shell metacharacters."),
      env: z.record(z.string(), z.string()).optional().describe("Environment variables for the launched process. With a profile, every key must already be a key of that profile's env map (the profile's env doubles as the allowlist) or you get ENV_KEY_NOT_ALLOWED; inline, these keys ARE the environment, so any key is accepted."),
      server: z.string().optional().describe("Target server name. With a profile, defaults to the profile's configured server. Inline (no profile), this is the server to run on; it may be omitted only when exactly one server is enabled."),
      push: z.boolean().optional().describe("Uploads the push sources to remoteRoot before launch. Defaults to true for a profile with push.paths (or its defaultPush), and to false for an inline run unless you pass pushPaths. Pass false to skip and use code already present under remoteRoot."),
      collect: z.array(z.string()).optional().describe("Glob patterns (relative to remoteRoot) of artifacts to pull back after the run finishes. Defaults to the profile's collect.paths; an empty array explicitly disables collect for this call. Requesting collect makes this call wait (bounded by timeout) for the run to finish. Needs a local destination: the profile's collect.localDir, or collectLocalDir inline."),
      sync: z.enum(["none", "flush"]).optional().describe("Only 'none' (or omitted) is available. 'flush' returns SYNC_NOT_AVAILABLE (Phase 3)."),
      timeout: z.number().int().positive().optional().describe("Only meaningful when collect actually runs: milliseconds to wait for the run to reach a terminal state before giving up on collect (the run itself keeps running regardless). Defaults to the profile's timeout, or 600000ms (10 minutes)."),
    },
    async ({ profile, remoteRoot, venv, executable, pushPaths, collectLocalDir, entrypoint, args, env, server, push, collect, sync, timeout }) => {
      try {
        const result = await runService.launch({
          profile,
          remoteRoot,
          venv,
          executable,
          pushPaths,
          collectLocalDir,
          entrypoint,
          args,
          env,
          server,
          push,
          collect,
          sync,
          timeout,
        });
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
