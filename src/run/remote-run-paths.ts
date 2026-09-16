import { isValidRunId } from "./run-id.js";

/**
 * PLAN.MD P2-03: "每个 run 创建 ~/.handfree-runs/<runId>/ 或 profile 指定 state
 * root" and "写入 meta.json/stdout.log/stderr.log/pid/heartbeat/exit.json".
 *
 * Pure path arithmetic only -- no filesystem, no SFTP, no SSH. Every path
 * here is POSIX-relative to whatever the caller resolved as the remote
 * "home" (see src/run/remote-sftp.ts's resolveHomeDir, which mirrors what
 * the wrapper script itself does with bash's own $HOME). Keeping this
 * relative-to-home instead of baking in a leading `~` or `/home/<user>`
 * avoids ever guessing the remote user's home directory path format.
 */
export const DEFAULT_STATE_ROOT_NAME = ".handfree-runs";

export interface RunPaths {
  runDir: string;
  metaPath: string;
  stdoutPath: string;
  stderrPath: string;
  pidPath: string;
  heartbeatPath: string;
  exitPath: string;
  orphanedPath: string;
}

/**
 * `stateRootRelative` is relative to remote home (default
 * DEFAULT_STATE_ROOT_NAME); profiles may override it (PLAN.MD "profile 指定
 * state root"). Throws on an invalid runId -- every caller (launch, status,
 * logs, list, cancel) must validate the runId before it ever reaches a
 * remote path or shell command.
 */
export function computeRunPaths(runId: string, stateRootRelative: string = DEFAULT_STATE_ROOT_NAME): RunPaths {
  if (!isValidRunId(runId)) {
    throw new Error(`invalid runId: ${JSON.stringify(runId)}`);
  }
  const root = normalizeStateRoot(stateRootRelative);
  const runDir = `${root}/${runId}`;
  return {
    runDir,
    metaPath: `${runDir}/meta.json`,
    stdoutPath: `${runDir}/stdout.log`,
    stderrPath: `${runDir}/stderr.log`,
    pidPath: `${runDir}/pid`,
    heartbeatPath: `${runDir}/heartbeat`,
    exitPath: `${runDir}/exit.json`,
    orphanedPath: `${runDir}/orphaned.json`,
  };
}

/** Pure. Strips a leading `/` or `~` segment (state root is always
 * home-relative) and any trailing slash, and rejects `..` traversal. */
function normalizeStateRoot(raw: string): string {
  let value = raw.trim();
  if (value.startsWith("~/")) value = value.slice(2);
  while (value.startsWith("/")) value = value.slice(1);
  while (value.endsWith("/")) value = value.slice(0, -1);
  if (value.length === 0) {
    throw new Error("stateRoot must not be empty");
  }
  if (value.split("/").some((segment) => segment === ".." || segment === ".")) {
    throw new Error(`stateRoot must not contain '.' or '..' segments: ${raw}`);
  }
  return value;
}

/** Pure. The directory that holds every run's state dir, for run-list's
 * readdir. */
export function computeStateRootPath(stateRootRelative: string = DEFAULT_STATE_ROOT_NAME): string {
  return normalizeStateRoot(stateRootRelative);
}

/**
 * Pure. Joins `base` (kept exactly as given -- absolute stays absolute,
 * relative stays relative; this function does not know or guess which)
 * with one or more additional POSIX path segments, each of which may itself
 * contain `/`. Trailing slashes on `base` and empty segments are ignored.
 * This is the one join helper every remote-path computation in src/run/
 * goes through (home dir + relative state path, remoteRoot + entrypoint,
 * venv path + "bin" + executable name) -- unlike `path.posix.join`, it never
 * collapses a leading `/` on `base` (Node's own `path.posix.join("/a",
 * "b")` is fine, but hand-rolled alternatives that strip leading slashes
 * from every segment -- including the first -- are an easy way to silently
 * turn an absolute remote path into a relative one).
 */
export function joinPosix(base: string, ...parts: string[]): string {
  const trimmedBase = base.replace(/\/+$/, "");
  const tail = parts
    .flatMap((part) => part.split("/"))
    .filter((segment) => segment.length > 0)
    .join("/");
  if (tail.length === 0) {
    return trimmedBase.length > 0 ? trimmedBase : base;
  }
  return trimmedBase.length > 0 ? `${trimmedBase}/${tail}` : `/${tail}`;
}
