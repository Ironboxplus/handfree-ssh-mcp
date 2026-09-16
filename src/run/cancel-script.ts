import { posixShellQuote } from "./posix-quote.js";
import type { RunPaths } from "./remote-run-paths.js";
import type { ProcessProbe } from "./identity.js";

/**
 * PLAN.MD P2-04: cancel is a two-round-trip protocol, deliberately split so
 * the pure decision function (src/run/identity.ts's decideCancelAction) is
 * the thing that actually gates whether a signal is ever sent, rather than
 * duplicating that decision inside bash:
 *
 *   1. buildProbeScript(pid) -- READ-ONLY. Reports what is currently running
 *      under `pid` right now (boot id, pid, pgid, start ticks, and the
 *      target's own HANDFREE_WRAPPER_TOKEN read back out of its live
 *      /proc/<pid>/environ -- not just the static meta.json, which never
 *      changes and so cannot by itself distinguish the original process
 *      from an unrelated one that later reused the same pid).
 *   2. The caller (run-service.ts) feeds the probe result and the recorded
 *      identity from meta.json into decideCancelAction(). Only if that pure
 *      function returns {action:"signal"} does the caller send
 *      buildSignalScript() as a second, separate exec call.
 */

const PROBE_PREFIX = "HANDFREE_PROBE:";
const CANCEL_PREFIX = "HANDFREE_CANCEL:";

export function buildProbeScript(pid: number): string {
  const pidLiteral = posixShellQuote(String(Math.trunc(pid)));
  return `#!/usr/bin/env bash
set -u
PID=${pidLiteral}
if [ ! -d "/proc/$PID" ]; then
  echo '${PROBE_PREFIX}{"found":false}'
  exit 0
fi
BOOT_ID=$(cat /proc/sys/kernel/random/boot_id 2>/dev/null || echo unknown)
PGID=$(ps -o pgid= -p "$PID" 2>/dev/null | tr -d ' ')
PGID=\${PGID:-0}
START_TICKS=$(awk '{print $22}' "/proc/$PID/stat" 2>/dev/null)
START_TICKS=\${START_TICKS:-0}
TOKEN=$(tr '\\0' '\\n' < "/proc/$PID/environ" 2>/dev/null | sed -n 's/^HANDFREE_WRAPPER_TOKEN=//p')
printf '${PROBE_PREFIX}{"found":true,"bootId":"%s","pid":%s,"pgid":%s,"startTicks":"%s","wrapperToken":"%s"}\\n' "$BOOT_ID" "$PID" "$PGID" "$START_TICKS" "$TOKEN"
`;
}

export function parseProbeLine(output: string): ProcessProbe | null {
  const line = output.split("\n").find((l) => l.startsWith(PROBE_PREFIX));
  if (!line) return null;
  try {
    const json = JSON.parse(line.slice(PROBE_PREFIX.length)) as Record<string, unknown>;
    if (json.found === false) return { found: false };
    if (
      json.found === true &&
      typeof json.bootId === "string" &&
      typeof json.pid === "number" &&
      typeof json.pgid === "number" &&
      typeof json.startTicks === "string" &&
      typeof json.wrapperToken === "string"
    ) {
      return {
        found: true,
        bootId: json.bootId,
        pid: json.pid,
        pgid: json.pgid,
        startTicks: json.startTicks,
        wrapperToken: json.wrapperToken,
      };
    }
    return null;
  } catch {
    return null;
  }
}

export interface SignalScriptParams {
  paths: RunPaths;
  pgid: number;
  pid: number;
  graceMs: number;
}

export type CancelSignalOutcome = "terminated" | "killed" | "already-exited";

export function buildSignalScript(params: SignalScriptParams): string {
  const pgidLiteral = posixShellQuote(String(Math.trunc(params.pgid)));
  const pidLiteral = posixShellQuote(String(Math.trunc(params.pid)));
  const graceSeconds = (Math.max(0, params.graceMs) / 1000).toFixed(3);
  return `#!/usr/bin/env bash
set -u
PGID=${pgidLiteral}
PID=${pidLiteral}
RUN_DIR=${posixShellQuote(params.paths.runDir)}
EXIT_PATH=${posixShellQuote(params.paths.exitPath)}

if [ ! -d "/proc/$PID" ]; then
  echo '${CANCEL_PREFIX}already-exited'
  exit 0
fi

tmp="$RUN_DIR/cancel_requested.tmp.$$"
printf '%s' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$tmp" && mv -f "$tmp" "$RUN_DIR/cancel_requested"

kill -TERM -"$PGID" 2>/dev/null || true
sleep ${graceSeconds}

if [ -d "/proc/$PID" ]; then
  kill -KILL -"$PGID" 2>/dev/null || true
  sleep 0.3
  if [ ! -f "$EXIT_PATH" ]; then
    # The supervisor may have died from the same group-wide KILL before it
    # could record the real exit status (SIGKILL cannot be trapped). Write a
    # best-effort fallback so run-status has a terminal record; this is a
    # documented, unavoidable Unix race for force-kill of a whole group, not
    # a bug -- see wrapper-script.ts's module doc comment.
    tmp="$EXIT_PATH.tmp.$$"
    printf '%s' "{\\"waitStatus\\":137,\\"finishedAt\\":\\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\\",\\"cancelled\\":true}" > "$tmp" && mv -f "$tmp" "$EXIT_PATH"
  fi
  echo '${CANCEL_PREFIX}killed'
else
  echo '${CANCEL_PREFIX}terminated'
fi
`;
}

/** Writes `orphaned.json` (atomically) for an identity mismatch decided by
 * decideCancelAction() -- a plain read-only-safe text write, no signal
 * involved. Idempotent: a second cancel call for an already-orphaned run
 * finds the marker file and does not re-probe or re-write it. */
export function buildWriteOrphanedMarkerScript(orphanedPath: string, reason: string, detectedAt: string): string {
  const contentJson = JSON.stringify({ detectedAt, reason });
  return `#!/usr/bin/env bash
set -u
TARGET=${posixShellQuote(orphanedPath)}
CONTENT=${posixShellQuote(contentJson)}
TMP="$TARGET.tmp.$$"
printf '%s' "$CONTENT" > "$TMP" && mv -f "$TMP" "$TARGET"
`;
}

export function parseCancelOutcome(output: string): CancelSignalOutcome | null {
  const line = output.split("\n").find((l) => l.startsWith(CANCEL_PREFIX));
  if (!line) return null;
  const value = line.slice(CANCEL_PREFIX.length).trim();
  if (value === "terminated" || value === "killed" || value === "already-exited") return value;
  return null;
}
