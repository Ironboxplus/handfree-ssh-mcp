import crypto from "crypto";
import { SSHConnectionManager } from "../services/ssh-connection-manager.js";
import { RunProfileRegistry } from "./run-profile-registry.js";
import type { RunProfileEntry } from "../config/run-profiles-loader.js";
import { generateRunId, isValidRunId } from "./run-id.js";
import { computeRunPaths, computeStateRootPath, joinPosix, type RunPaths } from "./remote-run-paths.js";
import { matchesAllowedEntrypoint } from "./entrypoint-glob.js";
import { applyEnvOverride } from "./env-allowlist.js";
import { buildWrapperScript } from "./wrapper-script.js";
import { buildLaunchExecCommand, buildRemoteScriptExecCommand } from "./launch-command.js";
import { findSentinelLine } from "./sentinel.js";
import {
  parseRunMeta,
  parseRunExit,
  parseOrphanedMarker,
  interpretWaitStatus,
  type RunMeta,
} from "./meta.js";
import { decideCancelAction, type ProcessProbe } from "./identity.js";
import {
  buildProbeScript,
  buildSignalScript,
  buildWriteOrphanedMarkerScript,
  parseProbeLine,
  parseCancelOutcome,
} from "./cancel-script.js";
import { resolveRemoteHomeDir, readRemoteTextFile, readRemoteByteRange, listRemoteDirectory } from "./remote-sftp.js";
import { sliceUtf8Window } from "./log-offset.js";
import { checkSyncParamSupported, type PhaseOutcome } from "../contracts/run-contract.js";
import { RunServiceError } from "./run-errors.js";

/**
 * PLAN.MD Phase 2 (P2-01/02/03/04/05/06) runner core. Orchestrates profile
 * resolution, the remote wrapper launch, and SFTP-backed status/logs/list/
 * cancel -- see run-errors.ts, wrapper-script.ts, and remote-sftp.ts for the
 * pieces this ties together. Deliberately NOT a job framework: there is no
 * local job table, no polling loop, no event bus. Every call is a fresh,
 * stateless read (or one/two remote round trips for launch/cancel) against
 * the remote state directory, which is the single source of truth.
 *
 * Explicitly out of scope this dispatch (see the dispatch note this class
 * was built from): the `push` and `collect` phases, `run-retry`, conda/
 * module/slurm/GPU adapters, secretEnv providers, and `sync=flush`. Each is
 * rejected with a specific, documented `*_NOT_AVAILABLE` error rather than
 * silently ignored -- see the RunServiceError codes thrown below.
 */

export const HEARTBEAT_INTERVAL_SEC = 5;
export const HEARTBEAT_STALE_THRESHOLD_MS = HEARTBEAT_INTERVAL_SEC * 1000 * 4;
export const DEFAULT_LOG_MAX_BYTES = 64 * 1024;
export const DEFAULT_CANCEL_GRACE_MS = 5000;
export const DEFAULT_RUN_LIST_LIMIT = 50;
export const MAX_RUN_LIST_LIMIT = 200;
const LAUNCH_EXEC_TIMEOUT_MS = 20_000;
const CANCEL_EXEC_TIMEOUT_MS = 20_000;

export type RunState = "running" | "completed" | "failed" | "cancelled" | "recovering" | "orphaned";

export interface RunStatusSummary {
  runId: string;
  server: string;
  profile: string;
  state: RunState;
  phase: "launching" | "remote-running" | "collect";
  createdAt: string;
  exitCode: number | null;
  signal: string | null;
  cancelled: boolean;
  heartbeatAt: string | null;
  orphaned?: { detectedAt: string; reason: string };
}

export interface LaunchParams {
  profile: string;
  server?: string;
  entrypoint: string;
  args?: string[];
  env?: Record<string, string>;
  push?: boolean;
  collect?: string[];
  sync?: "none" | "flush";
}

export interface LaunchResult {
  runId: string;
  server: string;
  phases: PhaseOutcome[];
  status: RunStatusSummary;
}

export interface LogChunk {
  text: string;
  startOffset: number;
  nextOffset: number;
  fileSize: number;
  hasMore: boolean;
}

export type CancelOutcome = "terminated" | "killed" | "already-exited" | "orphaned";

export interface CancelResult {
  runId: string;
  outcome: CancelOutcome;
  reason?: string;
}

export class RunService {
  private static instance: RunService;

  public static getInstance(): RunService {
    if (!RunService.instance) {
      RunService.instance = new RunService();
    }
    return RunService.instance;
  }

  private get sshManager(): SSHConnectionManager {
    return SSHConnectionManager.getInstance();
  }

  private resolveProfile(name: string): RunProfileEntry {
    const profile = RunProfileRegistry.getInstance().get(name);
    if (!profile) {
      throw new RunServiceError(
        "RUN_PROFILE_NOT_FOUND",
        `runProfiles.${name} is not configured. Configured profiles: ${RunProfileRegistry.getInstance().list().join(", ") || "(none)"}`,
      );
    }
    return profile;
  }

  private resolveProfileServer(profile: RunProfileEntry): string {
    if (profile.syncProfile !== undefined) {
      throw new RunServiceError(
        "SYNC_PROFILE_NOT_AVAILABLE",
        "runProfiles entries that derive server/remoteRoot from a syncProfile are not available until Phase 3; configure server and remoteRoot directly on the run profile instead.",
      );
    }
    const server = profile.server;
    if (!server) {
      throw new RunServiceError("INVALID_CONFIGURATION", "run profile has neither syncProfile nor server configured");
    }
    if (!this.sshManager.getServerConfig(server)) {
      throw new RunServiceError("SERVER_NOT_FOUND", `run profile's server '${server}' is not an enabled SSH server`);
    }
    return server;
  }

  private resolveExecutable(profile: RunProfileEntry): string {
    if (profile.environment.type === "venv") {
      if (!profile.environment.path) {
        throw new RunServiceError("INVALID_CONFIGURATION", "environment.type=venv requires environment.path");
      }
      // PLAN.MD P2-01: "venv 直接调用 <venv>/bin/python...不依赖 source activate".
      return joinPosix(profile.environment.path, "bin", profile.executable || "python");
    }
    if (profile.environment.type === "executable") {
      if (!profile.executable) {
        throw new RunServiceError("INVALID_CONFIGURATION", "environment.type=executable requires executable");
      }
      return profile.executable;
    }
    throw new RunServiceError(
      "ENVIRONMENT_ADAPTER_NOT_AVAILABLE",
      `environment.type=${profile.environment.type} is not implemented in this delivery round (only venv and executable are supported); conda/module/slurm adapters are deferred.`,
    );
  }

  private assertLaunchCapabilitiesAvailable(profile: RunProfileEntry): void {
    if (profile.gpu?.required) {
      throw new RunServiceError(
        "GPU_VALIDATION_NOT_AVAILABLE",
        "gpu.required profiles are not implemented in this delivery round (no GPU/CUDA capability probe yet).",
      );
    }
    if (profile.secretEnv && Object.keys(profile.secretEnv).length > 0) {
      throw new RunServiceError(
        "SECRET_ENV_NOT_AVAILABLE",
        "secretEnv providers are not implemented in this delivery round.",
      );
    }
  }

  private resolveEntrypoint(profile: RunProfileEntry, entrypoint: string): string {
    const patterns = profile.allowedEntrypoints ?? [];
    if (patterns.length === 0 || !matchesAllowedEntrypoint(entrypoint, patterns)) {
      throw new RunServiceError(
        "ENTRYPOINT_NOT_ALLOWED",
        `entrypoint '${entrypoint}' is not allowed by this profile's allowedEntrypoints (${patterns.length === 0 ? "none configured" : patterns.join(", ")})`,
      );
    }
    return entrypoint;
  }

  private resolveEnv(profile: RunProfileEntry, callerEnv: Record<string, string> | undefined): Record<string, string> {
    const result = applyEnvOverride(profile.env, callerEnv);
    if (!result.ok) {
      throw new RunServiceError(
        "ENV_KEY_NOT_ALLOWED",
        `env override includes keys not declared on this profile's env allowlist: ${result.rejectedKeys.join(", ")}`,
      );
    }
    return result.merged;
  }

  /** PLAN.MD P2-02/P2-06 are explicitly out of scope this dispatch -- see the
   * module doc comment. Never silently drops a caller's real request for
   * either phase; only an *absent or empty* request is treated as an
   * (unconditional, this-dispatch-wide) skip. */
  private checkPushCollectAvailability(params: LaunchParams, profile: RunProfileEntry): { pushOutcome: PhaseOutcome; collectOutcome: PhaseOutcome } {
    const effectivePush = params.push ?? profile.defaultPush ?? true;
    if (effectivePush) {
      throw new RunServiceError(
        "PUSH_NOT_AVAILABLE",
        "the push phase (P2-02) is not implemented in this delivery round. Pass push:false explicitly and ensure the code is already present under remoteRoot.",
      );
    }
    const effectiveCollect = params.collect ?? profile.collect?.paths ?? [];
    if (effectiveCollect.length > 0) {
      throw new RunServiceError(
        "COLLECT_NOT_AVAILABLE",
        "the collect phase (P2-06) is not implemented in this delivery round. Omit collect (or pass an empty array) and retrieve artifacts with the existing download/transfer tools.",
      );
    }
    return {
      pushOutcome: { phase: "push", status: "skipped", reason: "push:false (P2-02 push phase not implemented in this delivery round)" },
      collectOutcome: { phase: "collect", status: "skipped", reason: "collect phase (P2-06) not implemented in this delivery round" },
    };
  }

  public async launch(params: LaunchParams): Promise<LaunchResult> {
    const syncCheck = checkSyncParamSupported(params.sync);
    if (!syncCheck.ok) {
      throw new RunServiceError(syncCheck.code, syncCheck.message);
    }

    const profile = this.resolveProfile(params.profile);
    const server = params.server ? this.sshManager.resolveServer(params.server) : this.resolveProfileServer(profile);
    if (params.server && !this.sshManager.getServerConfig(server)) {
      throw new RunServiceError("SERVER_NOT_FOUND", `server '${server}' is not an enabled SSH server`);
    }
    this.assertLaunchCapabilitiesAvailable(profile);
    const { pushOutcome, collectOutcome } = this.checkPushCollectAvailability(params, profile);

    const executable = this.resolveExecutable(profile);
    const entrypoint = this.resolveEntrypoint(profile, params.entrypoint);
    const env = this.resolveEnv(profile, params.env);
    const args = params.args ?? [];

    if (!profile.remoteRoot) {
      throw new RunServiceError("INVALID_CONFIGURATION", "run profile has no remoteRoot");
    }
    const remoteRoot = profile.remoteRoot;
    const workdir = remoteRoot;
    const entrypointAbsolute = joinPosix(remoteRoot, entrypoint);

    const runId = generateRunId();
    const paths = computeRunPaths(runId);
    const homeDir = await resolveRemoteHomeDir(server);
    const absolutePaths = this.toAbsolutePaths(homeDir, paths);

    const wrapperToken = crypto.randomBytes(16).toString("hex");
    const createdAt = new Date().toISOString();
    const script = buildWrapperScript({
      runId,
      profile: params.profile,
      server,
      remoteRoot,
      workdir,
      executable,
      entrypoint: entrypointAbsolute,
      args,
      env,
      wrapperToken,
      createdAt,
      heartbeatIntervalSec: HEARTBEAT_INTERVAL_SEC,
      paths: absolutePaths,
    });

    const output = await this.sshManager.executeCommand(buildLaunchExecCommand(script), server, {
      timeout: LAUNCH_EXEC_TIMEOUT_MS,
    });

    const errorLine = findSentinelLine(output, "HANDFREE_LAUNCH_ERROR:");
    if (errorLine) {
      throw new RunServiceError("RUN_LAUNCH_FAILED", `remote launch failed: ${errorLine.trim()}`);
    }
    const launchedLine = findSentinelLine(output, "HANDFREE_LAUNCHED:");
    if (!launchedLine) {
      throw new RunServiceError("RUN_LAUNCH_FAILED", `remote launch did not report a result. Raw output: ${output.slice(0, 2000)}`);
    }
    const parsed = parseRunMeta(launchedLine.trim());
    if (!parsed.ok) {
      throw new RunServiceError("RUN_LAUNCH_FAILED", `remote launch reported an unreadable meta.json: ${parsed.error}`);
    }

    const status = this.statusFromMeta(server, parsed.value, null, null, null);
    return {
      runId,
      server,
      phases: [
        { phase: "push", status: "skipped", reason: pushOutcome.reason },
        { phase: "preflight", status: "completed" },
        { phase: "launching", status: "completed" },
        { phase: "collect", status: "skipped", reason: collectOutcome.reason },
      ],
      status,
    };
  }

  private toAbsolutePaths(homeDir: string, paths: RunPaths): RunPaths {
    const abs = (p: string) => joinPosix(homeDir, p);
    return {
      runDir: abs(paths.runDir),
      metaPath: abs(paths.metaPath),
      stdoutPath: abs(paths.stdoutPath),
      stderrPath: abs(paths.stderrPath),
      pidPath: abs(paths.pidPath),
      heartbeatPath: abs(paths.heartbeatPath),
      exitPath: abs(paths.exitPath),
      orphanedPath: abs(paths.orphanedPath),
    };
  }

  private statusFromMeta(
    server: string,
    meta: RunMeta,
    exitRaw: string | null,
    orphanedRaw: string | null,
    heartbeatRaw: string | null,
  ): RunStatusSummary {
    if (exitRaw !== null) {
      const exitParsed = parseRunExit(exitRaw);
      if (exitParsed.ok) {
        const { exitCode, signal } = interpretWaitStatus(exitParsed.value.waitStatus);
        const state: RunState = exitParsed.value.cancelled ? "cancelled" : exitCode === 0 ? "completed" : "failed";
        return {
          runId: meta.runId,
          server,
          profile: meta.profile,
          state,
          phase: "remote-running",
          createdAt: meta.createdAt,
          exitCode,
          signal,
          cancelled: exitParsed.value.cancelled,
          heartbeatAt: heartbeatRaw,
        };
      }
    }
    if (orphanedRaw !== null) {
      const orphanedParsed = parseOrphanedMarker(orphanedRaw);
      if (orphanedParsed.ok) {
        return {
          runId: meta.runId,
          server,
          profile: meta.profile,
          state: "orphaned",
          phase: "remote-running",
          createdAt: meta.createdAt,
          exitCode: null,
          signal: null,
          cancelled: false,
          heartbeatAt: heartbeatRaw,
          orphaned: orphanedParsed.value,
        };
      }
    }
    const heartbeatFresh = heartbeatRaw !== null && this.isHeartbeatFresh(heartbeatRaw);
    const recentlyLaunched = Date.now() - Date.parse(meta.createdAt) < HEARTBEAT_STALE_THRESHOLD_MS;
    const state: RunState = heartbeatFresh || (heartbeatRaw === null && recentlyLaunched) ? "running" : "recovering";
    return {
      runId: meta.runId,
      server,
      profile: meta.profile,
      state,
      phase: "remote-running",
      createdAt: meta.createdAt,
      exitCode: null,
      signal: null,
      cancelled: false,
      heartbeatAt: heartbeatRaw,
    };
  }

  private isHeartbeatFresh(heartbeatRaw: string): boolean {
    const parsed = Date.parse(heartbeatRaw.trim());
    if (Number.isNaN(parsed)) return false;
    return Date.now() - parsed < HEARTBEAT_STALE_THRESHOLD_MS;
  }

  private async loadMetaOrThrow(server: string, runId: string): Promise<{ meta: RunMeta; absolutePaths: RunPaths }> {
    if (!isValidRunId(runId)) {
      throw new RunServiceError("INVALID_RUN_ID", `'${runId}' is not a valid runId`);
    }
    const resolvedServer = this.sshManager.resolveServer(server);
    const paths = computeRunPaths(runId);
    const homeDir = await resolveRemoteHomeDir(resolvedServer);
    const absolutePaths = this.toAbsolutePaths(homeDir, paths);
    const metaRaw = await readRemoteTextFile(resolvedServer, absolutePaths.metaPath);
    if (metaRaw === null) {
      throw new RunServiceError("RUN_NOT_FOUND", `no run '${runId}' found on server '${resolvedServer}'`);
    }
    const parsed = parseRunMeta(metaRaw);
    if (!parsed.ok) {
      throw new RunServiceError("RUN_STATE_UNREADABLE", `run '${runId}' has an unreadable meta.json: ${parsed.error}`);
    }
    return { meta: parsed.value, absolutePaths };
  }

  public async getStatus(server: string | undefined, runId: string): Promise<RunStatusSummary> {
    const resolvedServer = this.sshManager.resolveServer(server);
    const { meta, absolutePaths } = await this.loadMetaOrThrow(resolvedServer, runId);
    const [exitRaw, orphanedRaw, heartbeatRaw] = await Promise.all([
      readRemoteTextFile(resolvedServer, absolutePaths.exitPath),
      readRemoteTextFile(resolvedServer, absolutePaths.orphanedPath),
      readRemoteTextFile(resolvedServer, absolutePaths.heartbeatPath),
    ]);
    return this.statusFromMeta(resolvedServer, meta, exitRaw, orphanedRaw, heartbeatRaw);
  }

  public async getLogs(
    server: string | undefined,
    runId: string,
    stream: "stdout" | "stderr" = "stdout",
    offset = 0,
    maxOutputBytes: number = DEFAULT_LOG_MAX_BYTES,
  ): Promise<LogChunk> {
    const resolvedServer = this.sshManager.resolveServer(server);
    const { absolutePaths } = await this.loadMetaOrThrow(resolvedServer, runId);
    const logPath = stream === "stderr" ? absolutePaths.stderrPath : absolutePaths.stdoutPath;
    const cap = Math.max(0, Math.floor(maxOutputBytes));
    const overread = cap + 3;
    const range = await readRemoteByteRange(resolvedServer, logPath, Math.max(0, Math.floor(offset)), overread);
    if (range === null) {
      return { text: "", startOffset: offset, nextOffset: offset, fileSize: 0, hasMore: false };
    }
    const slice = sliceUtf8Window(range.data, Math.max(0, Math.floor(offset)), cap);
    return {
      text: slice.text,
      startOffset: slice.startOffset,
      nextOffset: slice.nextOffset,
      fileSize: range.fileSize,
      hasMore: slice.nextOffset < range.fileSize,
    };
  }

  public async list(
    server: string | undefined,
    opts: { profile?: string; state?: RunState; limit?: number } = {},
  ): Promise<RunStatusSummary[]> {
    const resolvedServer = this.sshManager.resolveServer(server);
    const homeDir = await resolveRemoteHomeDir(resolvedServer);
    const stateRootAbsolute = joinPosix(homeDir, computeStateRootPath());
    const entries = await listRemoteDirectory(resolvedServer, stateRootAbsolute);
    const runIds = entries
      .filter((entry) => entry.isDirectory && isValidRunId(entry.filename))
      .map((entry) => entry.filename)
      .sort()
      .reverse();

    const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? DEFAULT_RUN_LIST_LIMIT)), MAX_RUN_LIST_LIMIT);
    const candidates = runIds.slice(0, limit);

    const statuses: RunStatusSummary[] = [];
    for (const runId of candidates) {
      try {
        statuses.push(await this.getStatus(resolvedServer, runId));
      } catch {
        // A corrupt/partial run directory should not fail the whole list;
        // it's simply omitted (run-status on that specific runId will
        // surface the detailed error if the caller asks for it directly).
      }
    }
    return statuses.filter(
      (status) =>
        (opts.profile === undefined || status.profile === opts.profile) &&
        (opts.state === undefined || status.state === opts.state),
    );
  }

  public async cancel(server: string | undefined, runId: string, graceMs: number = DEFAULT_CANCEL_GRACE_MS): Promise<CancelResult> {
    const resolvedServer = this.sshManager.resolveServer(server);
    const { meta, absolutePaths } = await this.loadMetaOrThrow(resolvedServer, runId);

    const [exitRaw, orphanedRaw] = await Promise.all([
      readRemoteTextFile(resolvedServer, absolutePaths.exitPath),
      readRemoteTextFile(resolvedServer, absolutePaths.orphanedPath),
    ]);
    if (exitRaw !== null) {
      return { runId, outcome: "already-exited" };
    }
    if (orphanedRaw !== null) {
      const parsed = parseOrphanedMarker(orphanedRaw);
      return { runId, outcome: "orphaned", reason: parsed.ok ? parsed.value.reason : "previously determined orphaned" };
    }

    const probeOutput = await this.sshManager.executeCommand(
      buildRemoteScriptExecCommand(buildProbeScript(meta.identity.pid)),
      resolvedServer,
      { timeout: CANCEL_EXEC_TIMEOUT_MS },
    );
    const probe: ProcessProbe | null = parseProbeLine(probeOutput);
    if (probe === null) {
      throw new RunServiceError("RUN_CANCEL_PROBE_FAILED", `could not parse the remote identity probe for run '${runId}'`);
    }

    const decision = decideCancelAction(meta.identity, probe);
    if (decision.action === "orphaned") {
      const detectedAt = new Date().toISOString();
      await this.sshManager.executeCommand(
        buildRemoteScriptExecCommand(buildWriteOrphanedMarkerScript(absolutePaths.orphanedPath, decision.reason, detectedAt)),
        resolvedServer,
        { timeout: CANCEL_EXEC_TIMEOUT_MS },
      );
      return { runId, outcome: "orphaned", reason: decision.reason };
    }

    const signalOutput = await this.sshManager.executeCommand(
      buildRemoteScriptExecCommand(
        buildSignalScript({ paths: absolutePaths, pgid: meta.identity.pgid, pid: meta.identity.pid, graceMs }),
      ),
      resolvedServer,
      { timeout: CANCEL_EXEC_TIMEOUT_MS + graceMs },
    );
    const outcome = parseCancelOutcome(signalOutput);
    if (outcome === null) {
      throw new RunServiceError("RUN_CANCEL_SIGNAL_FAILED", `could not parse the remote cancel result for run '${runId}'`);
    }
    return { runId, outcome };
  }
}
