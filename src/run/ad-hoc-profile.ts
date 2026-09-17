import type { RunProfileEntry } from "../config/run-profiles-loader.js";
import { RunServiceError } from "./run-errors.js";

/**
 * Plug-and-play `workspace-run`: launching a remote job must not require
 * editing servers.yaml first.
 *
 * The original P2-01 design made `runProfiles.<name>` mandatory, on the
 * reasoning that a run profile is the administrator-configured capability
 * boundary. That reasoning does not hold for THIS server: `execute-command`
 * already lets the same caller run an arbitrary remote command under the
 * command policy, so requiring YAML before `workspace-run` bought no real
 * containment -- it only made the durable-run feature unreachable for anyone
 * whose servers come from ~/.ssh/config (i.e. the common case, where there is
 * no YAML `runProfiles:` section at all). The gate was friction, not security.
 *
 * So a profile is now one of two ways to describe a run, not a precondition:
 *   - `profile: "<name>"`        -- the saved preset, unchanged in every respect
 *   - inline `remoteRoot` + `venv`/`executable` -- this module
 *
 * What ad-hoc mode does NOT relax: `entrypoint` still has to be a safe
 * relative path under `remoteRoot` (`allowedEntrypoints: ["**"]` still runs
 * through isSafeRelativeEntrypoint, which rejects `..`, absolute paths, and
 * drive letters), args are still individually quoted and never interpreted,
 * and the target still has to be an enabled SSH server. The only widened
 * surface is WHICH relative entrypoint may run -- and a saved profile that
 * wants to narrow that back down still can, via allowedEntrypoints.
 */

/** The `profile` label recorded in remote meta.json for an inline run. It is
 * only ever a display/grouping label (run-list, run-status, the wrapper's
 * meta), never looked up in the registry -- `retry` relaunches from the run's
 * own stored config snapshot, so an ad-hoc run stays retryable exactly like a
 * profile-backed one. */
export const AD_HOC_PROFILE_LABEL = "(ad-hoc)";

/** Config revision recorded for an inline run. A profile-backed run stores
 * the registry's revision so a later config edit is detectable; an inline run
 * has no registry entry to drift from, and this constant says so explicitly
 * rather than borrowing an unrelated revision. */
export const AD_HOC_CONFIG_REVISION = "ad-hoc";

export interface AdHocProfileParams {
  remoteRoot?: string;
  venv?: string;
  executable?: string;
  server?: string;
  env?: Record<string, string>;
  pushPaths?: string[];
  collectLocalDir?: string;
  timeout?: number;
}

/**
 * Pure. Builds the same `RunProfileEntry` shape the YAML loader produces, so
 * everything downstream (resolveExecutable, resolveEntrypoint, push/collect
 * planning, the config snapshot retry reads back) is the single existing code
 * path -- ad-hoc mode adds no second launch pipeline.
 */
export function buildAdHocProfile(params: AdHocProfileParams): RunProfileEntry {
  if (!params.remoteRoot) {
    throw new RunServiceError(
      "INVALID_CONFIGURATION",
      "workspace-run needs either profile (a runProfiles.<name> entry) or remoteRoot (the remote directory the entrypoint lives in). Pass remoteRoot plus one of venv / executable to run without any YAML config.",
    );
  }
  if (!params.venv && !params.executable) {
    throw new RunServiceError(
      "INVALID_CONFIGURATION",
      "workspace-run with an inline remoteRoot needs an interpreter: pass venv (e.g. venv:\"/data/envs/proj\" runs <venv>/bin/python, or add executable:\"python3.11\" to pick a different binary inside it) or executable (e.g. executable:\"bash\", executable:\"/usr/bin/python3\").",
    );
  }

  // `venv` wins when both are given: `executable` then names the binary
  // INSIDE <venv>/bin, which is exactly what resolveExecutable already does
  // for a configured venv profile (joinPosix(path, "bin", executable ||
  // "python")). Same semantics inline, no special case.
  const environment: RunProfileEntry["environment"] = params.venv
    ? { type: "venv", path: params.venv }
    : { type: "executable" };

  return {
    server: params.server,
    remoteRoot: params.remoteRoot,
    environment,
    executable: params.executable,
    // Any safe relative path under remoteRoot. `**` compiles to `.*`, but
    // matchesAllowedEntrypoint still runs isSafeRelativeEntrypoint first, so
    // this is "anything inside remoteRoot", not "anything on the filesystem".
    allowedEntrypoints: ["**"],
    // The caller's own env IS the allowlist for an inline run: there is no
    // administrator to have declared one, and rejecting the keys the same
    // call just supplied would be nonsense.
    env: params.env,
    // Inline runs default to push:false -- the code is already on the remote
    // (that is what remoteRoot points at). Supplying pushPaths opts in, and
    // then push defaults back to true, matching a configured profile.
    push: params.pushPaths && params.pushPaths.length > 0 ? { paths: params.pushPaths } : undefined,
    defaultPush: params.pushPaths !== undefined && params.pushPaths.length > 0,
    collect: params.collectLocalDir ? { localDir: params.collectLocalDir } : undefined,
    timeout: params.timeout,
  };
}
