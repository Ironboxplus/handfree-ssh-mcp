import fs from "fs";
import path from "path";
import crypto from "crypto";
import { SSHConnectionManager } from "../services/ssh-connection-manager.js";
import { RunProfileRegistry } from "./run-profile-registry.js";
import type { RunProfileEntry, RunProfilePushConfig } from "../config/run-profiles-loader.js";
import { generateRunId, isValidRunId } from "./run-id.js";
import { computeRunPaths, computeStateRootPath, joinPosix, type RunPaths } from "./remote-run-paths.js";
import { matchesAllowedEntrypoint } from "./entrypoint-glob.js";
import { applyEnvOverride } from "./env-allowlist.js";
import { buildWrapperScript } from "./wrapper-script.js";
import { buildLaunchExecCommand, buildRemoteScriptExecCommand } from "./launch-command.js";
import { findSentinelLine } from "./sentinel.js";
import { posixShellQuote } from "./posix-quote.js";
import {
  parseRunMeta,
  parseRunExit,
  parseOrphanedMarker,
  interpretWaitStatus,
  type RunMeta,
  type RunRevision,
} from "./meta.js";
import { decideCancelAction, type ProcessProbe } from "./identity.js";
import {
  buildProbeScript,
  buildSignalScript,
  buildWriteOrphanedMarkerScript,
  parseProbeLine,
  parseCancelOutcome,
} from "./cancel-script.js";
import {
  resolveRemoteHomeDir,
  readRemoteTextFile,
  readRemoteByteRange,
  listRemoteDirectory,
  statRemoteFile,
} from "./remote-sftp.js";
import { sliceUtf8Window } from "./log-offset.js";
import { checkSyncParamSupported, type PhaseOutcome } from "../contracts/run-contract.js";
import { RunServiceError } from "./run-errors.js";
import { computePushedFilesDigest } from "./push-revision.js";
import { findRemoteCollectFiles, selectWithinCollectCaps, type CollectMatch } from "./collect-glob.js";

/**
 * PLAN.MD Phase 2 (P2-01/02/03/04/05/06) runner core. Orchestrates profile
 * resolution, the remote wrapper launch, and SFTP-backed status/logs/list/
 * cancel -- see run-errors.ts, wrapper-script.ts, and remote-sftp.ts for the
 * pieces this ties together. Deliberately NOT a job framework: there is no
 * local job table, no polling loop, no event bus. Every call is a fresh,
 * stateless read (or one/two remote round trips for launch/cancel) against
 * the remote state directory, which is the single source of truth.
 *
 * This round adds the `push` and `collect` phases (P2-02/P2-06) and
 * `run-retry` (P2-04) on top of the launch/status/logs/list/cancel core
 * delivered previously. Explicitly still out of scope: conda/module/slurm/
 * GPU adapters, secretEnv providers (beyond the reference-only check
 * retry() does), and `sync=flush`. Each is rejected with a specific,
 * documented `*_NOT_AVAILABLE` error rather than silently ignored -- see the
 * RunServiceError codes thrown below.
 */

export const HEARTBEAT_INTERVAL_SEC = 5;
export const HEARTBEAT_STALE_THRESHOLD_MS = HEARTBEAT_INTERVAL_SEC * 1000 * 4;
export const DEFAULT_LOG_MAX_BYTES = 64 * 1024;
export const DEFAULT_CANCEL_GRACE_MS = 5000;
export const DEFAULT_RUN_LIST_LIMIT = 50;
export const MAX_RUN_LIST_LIMIT = 200;
const LAUNCH_EXEC_TIMEOUT_MS = 20_000;
const CANCEL_EXEC_TIMEOUT_MS = 20_000;
// PLAN.MD P2-02: entrypoint content-hash exec, same budget as the launch exec.
const HASH_EXEC_TIMEOUT_MS = 20_000;

// PLAN.MD P2-06: collect never defaults, so these bounds only ever apply
// once a profile has actually opted in via collect.paths/maxBytes/maxFiles.
// Generous but finite -- "no silent truncation" requires SOME cap to exist.
export const DEFAULT_COLLECT_MAX_BYTES = 200 * 1024 * 1024;
export const DEFAULT_COLLECT_MAX_FILES = 1000;
// The workspace-run call blocks (bounded) waiting for the run to reach a
// terminal state ONLY when a collect phase was actually requested -- see the
// module doc comment update below. Default generous; callers with a faster
// job can pass params.timeout, and profile.timeout (already parsed to ms by
// durationSchema) is preferred over this default when set.
export const DEFAULT_COLLECT_WAIT_MS = 10 * 60 * 1000;
const COLLECT_POLL_INTERVAL_MS = 1000;

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
  /** Only meaningful when the collect phase actually runs (see
   * DEFAULT_COLLECT_WAIT_MS): bounds how long this call waits for the run to
   * reach a terminal state before giving up on collect (without cancelling
   * the run itself, which keeps running regardless). */
  timeout?: number;
}

export interface CollectFileResult {
  remotePath: string;
  localPath: string;
  bytes: number;
}

export interface CollectPhaseResult {
  status: "completed" | "failed" | "skipped";
  reason?: string;
  files: CollectFileResult[];
  totalBytes: number;
}

export interface LaunchResult {
  runId: string;
  server: string;
  phases: PhaseOutcome[];
  status: RunStatusSummary;
  collect?: CollectPhaseResult;
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

  /**
   * PLAN.MD P2-02/P2-06: the cheap, no-remote-I/O half of push/collect
   * validation, resolved up front (same position in the pipeline the old
   * blanket PUSH_NOT_AVAILABLE/COLLECT_NOT_AVAILABLE gate used to occupy) so
   * a misconfigured profile fails fast, before any SFTP/exec call, exactly
   * like every other preflight check in this method. The actual push
   * upload / collect download I/O happens later, in runPush()/runCollect().
   */
  private resolvePushCollectPlan(
    params: LaunchParams,
    profile: RunProfileEntry,
  ): { effectivePush: boolean; effectiveCollectPaths: string[]; collectSkipReason: string | null } {
    const effectivePush = params.push ?? profile.defaultPush ?? true;
    if (effectivePush && !profile.push) {
      throw new RunServiceError(
        "INVALID_CONFIGURATION",
        "push is enabled (default true unless overridden by push:false or the profile's defaultPush) but this profile has no push.paths configured under runProfiles.<name>.push; add push.paths, or pass push:false and ensure the code already exists under remoteRoot.",
      );
    }

    let effectiveCollectPaths: string[];
    let collectSkipReason: string | null = null;
    if (params.collect !== undefined) {
      effectiveCollectPaths = params.collect;
      if (effectiveCollectPaths.length === 0) {
        collectSkipReason = "collect:[] explicitly disables the collect phase for this call";
      }
    } else {
      effectiveCollectPaths = profile.collect?.paths ?? [];
      if (effectiveCollectPaths.length === 0) {
        collectSkipReason = "no collect.paths declared on this profile (§5.8: collect never defaults to pulling the whole remoteRoot)";
      }
    }
    if (effectiveCollectPaths.length > 0 && !profile.collect?.localDir) {
      throw new RunServiceError(
        "INVALID_CONFIGURATION",
        "collect.paths is declared but this profile has no collect.localDir configured under runProfiles.<name>.collect; add collect.localDir, or pass collect:[] to disable collect for this call.",
      );
    }

    return { effectivePush, effectiveCollectPaths, collectSkipReason };
  }

  /**
   * PLAN.MD P2-02: push profile-declared local sources to remoteRoot,
   * reusing TransferService's batch upload (files) and recursive upload
   * (directories) -- both already default to skip-if-identical, so an
   * unchanged file is genuinely not re-transferred, not just reported as
   * such. Never partially throws mid-list-item without naming which source
   * failed: uploadBatch's own per-file result is inspected for failures
   * (it does not throw for an individual file failure), and uploadDirectory
   * failures (which DO throw, via runBoundedTransfers) are re-wrapped so the
   * failing local source is always named.
   */
  private async runPush(server: string, remoteRoot: string, pushConfig: RunProfilePushConfig): Promise<string[]> {
    const files: string[] = [];
    const dirs: string[] = [];
    for (const localPath of pushConfig.paths) {
      let stat: fs.Stats;
      try {
        stat = fs.statSync(localPath);
      } catch (error) {
        throw new RunServiceError(
          "RUN_PUSH_FAILED",
          `push failed (phase: push): local source '${localPath}' does not exist or is unreadable: ${(error as Error).message}`,
        );
      }
      if (stat.isDirectory()) dirs.push(localPath);
      else files.push(localPath);
    }

    const pushedRemotePaths: string[] = [];
    const transferService = this.sshManager.getTransferService();

    if (files.length > 0) {
      const result = await transferService.uploadBatch(files, remoteRoot, server);
      const failed = result.results.filter((r) => r.status === "failed");
      if (failed.length > 0) {
        throw new RunServiceError(
          "RUN_PUSH_FAILED",
          `push failed (phase: push) for file(s): ${failed.map((f) => `${f.localPath} (${f.reason ?? "unknown error"})`).join("; ")}`,
        );
      }
      for (const r of result.results) {
        if (r.status === "uploaded" || r.status === "skipped") pushedRemotePaths.push(r.remotePath);
      }
    }

    for (const localDir of dirs) {
      // Flatten: a pushed directory's CONTENTS land directly under
      // remoteRoot (not nested under a subfolder named after the local
      // directory) -- remoteRoot IS the pushed project root, matching how
      // `entrypoint`/`allowedEntrypoints` are already resolved relative to
      // remoteRoot itself, not to some per-source subfolder. Multiple
      // directory entries in push.paths overlay into the same remoteRoot;
      // a colliding relative path between two entries is last-write-wins,
      // same tradeoff any directory-overlay push makes.
      try {
        const uploaded = await this.sshManager.uploadDirectory(localDir, remoteRoot, server);
        pushedRemotePaths.push(...uploaded);
      } catch (error) {
        throw new RunServiceError(
          "RUN_PUSH_FAILED",
          `push failed (phase: push) while uploading directory '${localDir}' -> '${remoteRoot}': ${(error as Error).message}`,
        );
      }
    }

    return pushedRemotePaths;
  }

  /** PLAN.MD P2-02: "push 完成后对 entrypoint 做 stat + hash...记为该 run 的
   * revision". Always computed (push or not -- push:false still records what
   * is actually about to run), so a corrupt/missing remote entrypoint is
   * caught here as a real preflight failure instead of surfacing later as an
   * opaque wrapper-script exit code. */
  private async computeEntrypointRevision(server: string, entrypointAbsolute: string, pushedRemotePaths: string[]): Promise<RunRevision> {
    const stat = await statRemoteFile(server, entrypointAbsolute);
    if (stat === null) {
      throw new RunServiceError(
        "ENTRYPOINT_NOT_FOUND",
        `entrypoint '${entrypointAbsolute}' does not exist on remoteRoot (checked after the push phase); nothing would run`,
      );
    }
    if (!stat.isFile) {
      throw new RunServiceError("ENTRYPOINT_NOT_ALLOWED", `entrypoint '${entrypointAbsolute}' is not a regular file`);
    }
    const entrypointHash = await this.remoteContentHash(server, entrypointAbsolute);
    return {
      entrypointHash,
      entrypointBytes: stat.size,
      pushedFilesDigest: pushedRemotePaths.length > 0 ? computePushedFilesDigest(pushedRemotePaths) : null,
    };
  }

  /** md5sum over exec -- the same cheap remote-content-fingerprint mechanism
   * TransferService already uses (its private remoteMd5) for skip-if-
   * identical, reused here at the exec layer this service already owns
   * rather than reaching into TransferService for a second, private copy. */
  private async remoteContentHash(server: string, remotePath: string): Promise<string> {
    const output = await this.sshManager.executeCommand(`md5sum ${posixShellQuote(remotePath)}`, server, {
      timeout: HASH_EXEC_TIMEOUT_MS,
    });
    const hash = output.trim().split(/\s+/)[0];
    if (!hash || hash.length !== 32) {
      throw new RunServiceError("RUN_LAUNCH_FAILED", `could not compute a content hash for entrypoint '${remotePath}': unexpected md5sum output`);
    }
    return hash;
  }

  /** Non-secret by construction: secretEnv only ever holds provider/key/path
   * references (see contracts/config-schema.ts's secretEnvRefSchema), never
   * a resolved secret value -- this dispatch does not resolve secretEnv at
   * all (SECRET_ENV_NOT_AVAILABLE), so a snapshot can never contain one. The
   * JSON round-trip is a cheap deep clone that also guarantees the stored
   * object is exactly what JSON.stringify (meta.json's own serialization)
   * will produce -- no `undefined`/function surprises. */
  private buildConfigSnapshot(profile: RunProfileEntry): Record<string, unknown> {
    return JSON.parse(JSON.stringify(profile));
  }

  public async launch(params: LaunchParams): Promise<LaunchResult> {
    const profile = this.resolveProfile(params.profile);
    const configRevision = RunProfileRegistry.getInstance().getRevision();
    return this.launchWithProfile(profile, configRevision, params, undefined);
  }

  /**
   * PLAN.MD P2-04: retry copies the ORIGINAL run's non-secret config
   * snapshot (never the live/possibly-hot-reloaded RunProfileRegistry) and
   * launches a fresh run from it, recording parentRunId. Secret re-
   * resolution is a deliberate no-op stub for this delivery round: no
   * profile can reach a completed run with secretEnv declared in the first
   * place (assertLaunchCapabilitiesAvailable rejects it with
   * SECRET_ENV_NOT_AVAILABLE before any run is ever created), so a snapshot
   * with secretEnv is unreachable in practice; the check below is kept
   * anyway as the explicit, forward-compatible "an ephemeral secret is
   * missing" gate the plan calls for, rather than silently launching with
   * secrets it has no way to provide.
   */
  public async retry(server: string | undefined, runId: string, push?: boolean): Promise<LaunchResult> {
    const resolvedServer = this.sshManager.resolveServer(server);
    const { meta } = await this.loadMetaOrThrow(resolvedServer, runId);
    if (!meta.configSnapshot || !meta.configRevision || !meta.entrypointRelative) {
      throw new RunServiceError(
        "RETRY_SNAPSHOT_UNAVAILABLE",
        `run '${runId}' has no stored config snapshot to retry from (it predates the push/retry delivery round, or was launched by a build without it)`,
      );
    }
    const snapshot = meta.configSnapshot as unknown as RunProfileEntry;
    if (snapshot.secretEnv && Object.keys(snapshot.secretEnv).length > 0) {
      throw new RunServiceError(
        "SECRET_REQUIRED",
        `run '${runId}''s profile declares secretEnv, which this delivery round cannot re-resolve for a retry`,
      );
    }

    const params: LaunchParams = {
      profile: meta.profile,
      server: resolvedServer,
      entrypoint: meta.entrypointRelative,
      args: meta.args,
      env: meta.env,
      push,
      sync: "none",
    };
    return this.launchWithProfile(snapshot, meta.configRevision, params, runId);
  }

  private async launchWithProfile(
    profile: RunProfileEntry,
    configRevision: string,
    params: LaunchParams,
    parentRunId: string | undefined,
  ): Promise<LaunchResult> {
    const syncCheck = checkSyncParamSupported(params.sync);
    if (!syncCheck.ok) {
      throw new RunServiceError(syncCheck.code, syncCheck.message);
    }

    const server = params.server ? this.sshManager.resolveServer(params.server) : this.resolveProfileServer(profile);
    if (params.server && !this.sshManager.getServerConfig(server)) {
      throw new RunServiceError("SERVER_NOT_FOUND", `server '${server}' is not an enabled SSH server`);
    }
    this.assertLaunchCapabilitiesAvailable(profile);
    const { effectivePush, effectiveCollectPaths, collectSkipReason } = this.resolvePushCollectPlan(params, profile);

    const executable = this.resolveExecutable(profile);
    const entrypointRelative = this.resolveEntrypoint(profile, params.entrypoint);
    const env = this.resolveEnv(profile, params.env);
    const args = params.args ?? [];

    if (!profile.remoteRoot) {
      throw new RunServiceError("INVALID_CONFIGURATION", "run profile has no remoteRoot");
    }
    const remoteRoot = profile.remoteRoot;
    const workdir = remoteRoot;
    const entrypointAbsolute = joinPosix(remoteRoot, entrypointRelative);

    // ---- push phase (P2-02): must complete (or be skipped) before anything
    // below that could start the remote process. ----
    let pushOutcome: PhaseOutcome;
    let pushedRemotePaths: string[] = [];
    if (effectivePush) {
      pushedRemotePaths = await this.runPush(server, remoteRoot, profile.push!);
      pushOutcome = { phase: "push", status: "completed" };
    } else {
      pushOutcome = { phase: "push", status: "skipped", reason: "push:false -- code must already exist under remoteRoot" };
    }

    const revision = await this.computeEntrypointRevision(server, entrypointAbsolute, pushedRemotePaths);
    const configSnapshot = this.buildConfigSnapshot(profile);

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
      entrypointRelative,
      revision,
      configRevision,
      configSnapshot,
      ...(parentRunId ? { parentRunId } : {}),
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

    let status = this.statusFromMeta(server, parsed.value, null, null, null);

    // ---- collect phase (P2-06): only actually runs (and only then blocks
    // waiting for a terminal state) when a non-empty collect was resolved.
    // A plain launch (the common case, no collect requested) keeps
    // returning immediately, unchanged from before this round. ----
    let collectOutcome: PhaseOutcome;
    let collectResult: CollectPhaseResult | undefined;
    if (effectiveCollectPaths.length === 0) {
      collectOutcome = { phase: "collect", status: "skipped", reason: collectSkipReason! };
    } else {
      const waitTimeoutMs = params.timeout ?? profile.timeout ?? DEFAULT_COLLECT_WAIT_MS;
      const wait = await this.waitForTerminalStatus(server, runId, waitTimeoutMs);
      status = wait.status;
      if (!wait.terminal) {
        collectOutcome = {
          phase: "collect",
          status: "skipped",
          reason: `run did not reach a terminal state within ${waitTimeoutMs}ms (still '${wait.status.state}'); collect was not attempted. The run itself keeps running -- poll run-status.`,
        };
      } else {
        collectResult = await this.runCollect(server, remoteRoot, profile.collect!.localDir!, effectiveCollectPaths, profile.collect?.maxBytes ?? DEFAULT_COLLECT_MAX_BYTES, profile.collect?.maxFiles ?? DEFAULT_COLLECT_MAX_FILES);
        collectOutcome = { phase: "collect", status: collectResult.status, reason: collectResult.reason };
      }
    }

    return {
      runId,
      server,
      phases: [pushOutcome, { phase: "preflight", status: "completed" }, { phase: "launching", status: "completed" }, collectOutcome],
      status,
      ...(collectResult ? { collect: collectResult } : {}),
    };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** PLAN.MD P2-06: collect needs the run to have finished, but launch()
   * otherwise deliberately returns before the remote process exits (see the
   * class doc comment) -- there is no daemon/job-queue to notify this call
   * later. Bounded polling of the same SFTP-backed getStatus() every other
   * tool already uses is the whole mechanism; "terminal" mirrors the states
   * run-status/run-list already recognize as final. */
  private async waitForTerminalStatus(server: string, runId: string, timeoutMs: number): Promise<{ status: RunStatusSummary; terminal: boolean }> {
    const terminalStates: ReadonlySet<RunState> = new Set(["completed", "failed", "cancelled", "orphaned"]);
    const deadline = Date.now() + Math.max(0, timeoutMs);
    for (;;) {
      const status = await this.getStatus(server, runId);
      if (terminalStates.has(status.state)) {
        return { status, terminal: true };
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        return { status, terminal: false };
      }
      await this.sleep(Math.min(COLLECT_POLL_INTERVAL_MS, remaining));
    }
  }

  /**
   * PLAN.MD P2-06/§5.8: pull collect.paths glob matches back from remoteRoot
   * into the profile's collect.localDir, enforcing the byte/file caps with
   * no silent truncation (stop and report exactly what was already pulled).
   * Reuses TransferService's single-file download() per matched file (§5.8:
   * "拉取走 Phase 1 TransferService") -- no new transfer/streaming logic.
   * Never throws: a failure is reported as CollectPhaseResult.status
   * "failed" with the partial file list, so it can never be mistaken for
   * (or accidentally rewrite) the run's own exit code/state.
   */
  private async runCollect(
    server: string,
    remoteRoot: string,
    localDir: string,
    patterns: string[],
    maxBytes: number,
    maxFiles: number,
  ): Promise<CollectPhaseResult> {
    let matches: CollectMatch[];
    try {
      matches = await findRemoteCollectFiles(server, remoteRoot, patterns);
    } catch (error) {
      return {
        status: "failed",
        reason: `could not enumerate remoteRoot for collect: ${(error as Error).message}`,
        files: [],
        totalBytes: 0,
      };
    }

    const selection = selectWithinCollectCaps(matches, maxBytes, maxFiles);
    const pulled: CollectFileResult[] = [];
    for (const match of selection.accepted) {
      const localPath = path.join(localDir, ...match.relativePath.split("/"));
      fs.mkdirSync(path.dirname(localPath), { recursive: true });
      try {
        await this.sshManager.download(match.absolutePath, localPath, server);
      } catch (error) {
        return {
          status: "failed",
          reason: `download failed for '${match.relativePath}': ${(error as Error).message}. Already pulled ${pulled.length} file(s) before this failure.`,
          files: pulled,
          totalBytes: pulled.reduce((sum, f) => sum + f.bytes, 0),
        };
      }
      pulled.push({ remotePath: match.absolutePath, localPath, bytes: match.bytes });
    }

    if (selection.exceeded) {
      return {
        status: "failed",
        reason: `collect exceeded caps (${selection.exceeded.reason}) at '${selection.exceeded.atRelativePath}'; already pulled ${pulled.length} file(s) totaling ${selection.totalBytes} bytes before stopping -- no silent truncation`,
        files: pulled,
        totalBytes: selection.totalBytes,
      };
    }

    return { status: "completed", files: pulled, totalBytes: selection.totalBytes };
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
