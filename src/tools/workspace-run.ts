import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { RunService } from "../run/run-service.js";
import { runErrorEnvelope, toToolResult } from "./run-envelope.js";
import { rejectUnknownArguments } from "./strict-arguments.js";

/**
 * Registers the durable Linux runner: optional push -> launch -> optional
 * collect, with inline settings or a saved profile. A plain launch returns
 * after startup; collecting waits for a terminal state up to timeout.
 */
export function registerWorkspaceRunTool(server: McpServer): void {
  const runService = RunService.getInstance();

  rejectUnknownArguments(server.tool(
    "workspace-run",
    "Start a durable task on a Linux remote with bash, setsid and /proc. Pass remoteRoot, entrypoint and venv/executable inline, or use a saved profile. Optionally push code before launch and collect artifacts after completion. Returns after startup unless collect is requested. State survives SSH disconnects and MCP restarts; poll run-status/run-logs with the returned runId and server. jobId equals runId.",
    {
      profile: z.string().min(1).optional().describe("Optional runProfiles name from YAML. Omit to supply remoteRoot and venv/executable inline."),
      remoteRoot: z.string().min(1).optional().describe("Inline: absolute remote working directory, containing entrypoint and collected artifacts. A profile overrides this field."),
      venv: z.string().min(1).optional().describe("Inline: absolute virtualenv path. Runs <venv>/bin/python, or <venv>/bin/<executable> if specified."),
      executable: z.string().min(1).optional().describe("Inline: interpreter/program, e.g. python3, bash or /usr/bin/node; with venv, a binary under <venv>/bin. Require venv or executable."),
      pushPaths: z.array(z.string().min(1)).optional().describe("Inline: local files/directories to upload before launch. Enables push by default when non-empty."),
      collectLocalDir: z.string().min(1).optional().describe("Inline: local output directory; required when collect is non-empty."),
      entrypoint: z.string().min(1).describe("Script/program path relative to remoteRoot; no absolute paths or .. segments. Profiles also enforce allowedEntrypoints."),
      args: z.array(z.string()).optional().describe("Arguments passed individually with shell quoting; shell metacharacters are not expanded."),
      env: z.record(z.string(), z.string()).optional().describe("Process environment. With a profile, overrides may only use keys declared in its env map; inline accepts valid environment keys."),
      server: z.string().optional().describe("Same server names as connectionName in other tools. Defaults to the profile target, or the sole enabled server."),
      push: z.boolean().optional().describe("Upload before launch. Inline defaults to whether pushPaths is non-empty. Profiles use defaultPush, otherwise true; enabled push requires sources. False reuses remote code."),
      collect: z.array(z.string()).optional().describe("Artifact globs relative to remoteRoot, default profile collect.paths. [] disables. Non-empty collect waits for completion and needs a local destination."),
      sync: z.enum(["none", "flush"]).optional().describe("Only none or omitted is supported. flush returns SYNC_NOT_AVAILABLE."),
      timeout: z.number().int().positive().optional().describe("Collect wait limit in milliseconds; does not limit task runtime. Default profile timeout or 600000."),
      reuseConnection: z.boolean().optional().describe("Default true. Set false to use a fresh SSH connection after a suspected stale connection."),
    },
    async ({ profile, remoteRoot, venv, executable, pushPaths, collectLocalDir, entrypoint, args, env, server, push, collect, sync, timeout, reuseConnection }) => {
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
          reuseConnection,
        });
        return toToolResult({
          ok: true,
          jobId: result.runId,
          state: result.status.state,
          message: `Launched run '${result.runId}' on server '${result.server}'.`,
          next: `Poll run-status { "runId": ${JSON.stringify(result.runId)}, "connectionName": ${JSON.stringify(result.server)} } or run-logs { "runId": ${JSON.stringify(result.runId)}, "connectionName": ${JSON.stringify(result.server)} } for progress; run-cancel { "runId": ${JSON.stringify(result.runId)}, "connectionName": ${JSON.stringify(result.server)} } to stop it.`,
          details: { runId: result.runId, server: result.server, phases: result.phases, status: result.status, collect: result.collect },
        });
      } catch (error) {
        return toToolResult(runErrorEnvelope(error), true);
      }
    },
  ));
}
