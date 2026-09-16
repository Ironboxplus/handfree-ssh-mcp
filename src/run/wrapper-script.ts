import { posixShellQuote, posixShellQuoteAll } from "./posix-quote.js";
import type { RunPaths } from "./remote-run-paths.js";

/**
 * PLAN.MD P2-03: the remote wrapper. Builds the bash script text that is
 * transported (via src/run/launch-command.ts, base64+heredoc so this text
 * never has to survive re-quoting through an outer shell) and executed on
 * the remote host to launch a durable, SSH-disconnect-surviving process.
 *
 * Design, and why it looks the way it does:
 *
 *  - Every dynamic value (workdir, executable, entrypoint, each arg, each
 *    env value) is embedded via posixShellQuote() -- see that module's doc
 *    comment. This is the "never interpolate user args into an
 *    unconstrained shell template" boundary the plan calls out explicitly.
 *
 *  - The detached process is a SUPERVISOR shell, backgrounded with a plain
 *    `( ... ) &` + `disown` and with stdio redirected to /dev/null. It is
 *    the TARGET, not the supervisor, that is started under `setsid`, so the
 *    target gets its own session and its own process group from birth. Any
 *    children the target forks inherit that group, which is what makes
 *    "signal the process group" reach the target AND its descendants while
 *    touching nothing else.
 *
 *    (Corrected 2026-09-15: this comment previously described the inverse
 *    design -- supervisor under setsid, target inheriting the supervisor's
 *    group. The code has always done what is described above; the comment
 *    was wrong, not the code. Behavior confirmed by the real P2-04-A1
 *    acceptance on Linux: cancel kills the target and its grandchild and
 *    leaves an unrelated process of the same user running.)
 *
 *  - PGID is read back from the kernel (`ps -o pgid= -p "$CHILD_PID"`)
 *    rather than assumed, so meta.json records the group that actually
 *    exists.
 *
 *  - The supervisor traps TERM/INT to IGNORE them. Because the target is in
 *    its own group, a cancel aimed at that group does not reach the
 *    supervisor -- the trap is defense in depth for the case where a signal
 *    arrives by another route (e.g. someone signalling the supervisor
 *    directly), keeping it alive long enough to `wait()` the real exit
 *    status and write exit.json. The target does NOT inherit this trap: it
 *    is separately exec'd with default signal disposition, so a normal TERM
 *    still terminates it.
 *
 *  - Only the supervisor can `wait()` the target (wait() only works on your
 *    own direct children) -- this is why identity capture, the heartbeat
 *    loop, and the exit.json write all happen inside the supervisor, not in
 *    a second detached subshell forked from the *outer* (attached-to-SSH)
 *    launcher.
 *
 *  - The OUTER, still-attached-to-the-exec-channel part of the script only
 *    starts the supervisor and then polls for meta.json to appear (written
 *    by the supervisor once it has captured pid/pgid/bootId/start ticks),
 *    up to a short timeout. It never itself waits on the target, so the
 *    exec channel can close as soon as meta.json exists -- the target and
 *    its supervisor keep running regardless of what happens to the SSH
 *    session or the MCP adapter process.
 *
 *  - meta.json is assembled by string-concatenating a JSON blob built
 *    entirely in TypeScript (JSON.stringify, so every user-controlled
 *    string is already correctly JSON-escaped) with a small
 *    supervisor-computed `identity` object whose fields (numeric pid/pgid,
 *    digit-only start ticks, hex boot id/token) are safe to splice into
 *    JSON unescaped. No `jq`/python dependency.
 *
 *  - HANDFREE_WRAPPER_TOKEN is exported into the TARGET's own environment
 *    (not just used inside the wrapper) so a later cancel can re-verify
 *    identity by reading /proc/<pid>/environ on the live process, not just
 *    trusting a static file that never changes.
 */
export interface WrapperLaunchSpec {
  runId: string;
  profile: string;
  server: string;
  remoteRoot: string;
  workdir: string;
  executable: string;
  entrypoint: string;
  args: readonly string[];
  env: Readonly<Record<string, string>>;
  wrapperToken: string;
  createdAt: string;
  heartbeatIntervalSec: number;
  paths: RunPaths;
}

/** Pure. The JSON.stringify()-produced static portion of meta.json, minus
 * the `identity` field the supervisor fills in at runtime. Exported for
 * white-box testing of the splice point independent of the shell script
 * around it. */
export function buildStaticMetaJson(spec: WrapperLaunchSpec): string {
  return JSON.stringify({
    runId: spec.runId,
    profile: spec.profile,
    server: spec.server,
    remoteRoot: spec.remoteRoot,
    workdir: spec.workdir,
    executable: spec.executable,
    entrypoint: spec.entrypoint,
    args: [...spec.args],
    env: { ...spec.env },
    createdAt: spec.createdAt,
  });
}

export function buildWrapperScript(spec: WrapperLaunchSpec): string {
  const { paths } = spec;
  const argsLiteral = spec.args.length > 0 ? posixShellQuoteAll(spec.args) : "";
  const envExports = Object.entries(spec.env)
    .map(([key, value]) => `export ${key}=${posixShellQuote(value)}`)
    .join("\n");
  const staticMetaJson = buildStaticMetaJson(spec);
  // JSON.stringify always closes with exactly one '}'; stripping it lets us
  // splice in the identity object without any JSON parser/editor.
  if (!staticMetaJson.endsWith("}")) {
    throw new Error("unreachable: JSON.stringify(object) must end with '}'");
  }
  const staticMetaJsonPrefix = staticMetaJson.slice(0, -1);

  return `#!/bin/sh
set -u

RUN_DIR=${posixShellQuote(paths.runDir)}
META_PATH=${posixShellQuote(paths.metaPath)}
PID_PATH=${posixShellQuote(paths.pidPath)}
HEARTBEAT_PATH=${posixShellQuote(paths.heartbeatPath)}
EXIT_PATH=${posixShellQuote(paths.exitPath)}
STDOUT_PATH=${posixShellQuote(paths.stdoutPath)}
STDERR_PATH=${posixShellQuote(paths.stderrPath)}
WORKDIR=${posixShellQuote(spec.workdir)}
EXECUTABLE=${posixShellQuote(spec.executable)}
ENTRYPOINT=${posixShellQuote(spec.entrypoint)}
WRAPPER_TOKEN=${posixShellQuote(spec.wrapperToken)}
HEARTBEAT_INTERVAL_SEC=${posixShellQuote(String(spec.heartbeatIntervalSec))}
STATIC_META_JSON_PREFIX=${posixShellQuote(staticMetaJsonPrefix)}

mkdir -p "$RUN_DIR" || { echo "HANDFREE_LAUNCH_ERROR:cannot create run directory: $RUN_DIR" >&2; exit 16; }
if [ ! -d "$WORKDIR" ]; then
  echo "HANDFREE_LAUNCH_ERROR:workdir does not exist: $WORKDIR" >&2
  exit 17
fi
if [ ! -x "$EXECUTABLE" ]; then
  echo "HANDFREE_LAUNCH_ERROR:executable is not executable: $EXECUTABLE" >&2
  exit 18
fi

write_atomic() {
  # $1 = target path, $2 = literal content (already fully formed)
  tmp="$1.tmp.$$"
  printf '%s' "$2" > "$tmp" && mv -f "$tmp" "$1"
}

(
  trap '' TERM INT
  cd "$WORKDIR" || exit 19
  export HANDFREE_WRAPPER_TOKEN=${posixShellQuote(spec.wrapperToken)}
${envExports}

  setsid "$EXECUTABLE" "$ENTRYPOINT"${argsLiteral ? " " + argsLiteral : ""} < /dev/null > "$STDOUT_PATH" 2> "$STDERR_PATH" &
  CHILD_PID=$!

  write_atomic "$PID_PATH" "$CHILD_PID"

  BOOT_ID=$(cat /proc/sys/kernel/random/boot_id 2>/dev/null || echo unknown)
  PGID=$(ps -o pgid= -p "$CHILD_PID" 2>/dev/null | tr -d ' ')
  PGID=\${PGID:-$CHILD_PID}
  START_TICKS=$(awk '{print $22}' "/proc/$CHILD_PID/stat" 2>/dev/null)
  START_TICKS=\${START_TICKS:-0}

  IDENTITY_JSON="{\\"bootId\\":\\"$BOOT_ID\\",\\"pid\\":$CHILD_PID,\\"pgid\\":$PGID,\\"startTicks\\":\\"$START_TICKS\\",\\"wrapperToken\\":\\"$WRAPPER_TOKEN\\"}"
  write_atomic "$META_PATH" "$STATIC_META_JSON_PREFIX,\\"identity\\":$IDENTITY_JSON}"

  (
    while kill -0 "$CHILD_PID" 2>/dev/null; do
      write_atomic "$HEARTBEAT_PATH" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
      sleep "$HEARTBEAT_INTERVAL_SEC"
    done
  ) < /dev/null > /dev/null 2>&1 &

  wait "$CHILD_PID" 2>/dev/null
  WAIT_STATUS=$?
  FINISHED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  CANCELLED=false
  [ -f "$RUN_DIR/cancel_requested" ] && CANCELLED=true
  write_atomic "$EXIT_PATH" "{\\"waitStatus\\":$WAIT_STATUS,\\"finishedAt\\":\\"$FINISHED_AT\\",\\"cancelled\\":$CANCELLED}"
) < /dev/null > /dev/null 2>&1 &
disown $! 2>/dev/null || true

# Poll (bounded) for the supervisor to have written meta.json before this
# still-attached part of the script returns -- so the exec channel does not
# close before the caller has something to read back.
i=0
while [ ! -f "$META_PATH" ] && [ "$i" -lt 100 ]; do
  sleep 0.1
  i=$((i + 1))
done

if [ ! -f "$META_PATH" ]; then
  echo "HANDFREE_LAUNCH_ERROR:timed out waiting for launch to record identity" >&2
  exit 20
fi

echo "HANDFREE_LAUNCHED:\$(cat "$META_PATH")"
`;
}
