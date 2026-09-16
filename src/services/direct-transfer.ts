/**
 * PLAN.MD P1-08a: pure, side-effect-free pieces of the `transfer` tool's
 * relay-mode `strategy: "direct"` support -- direct means "run the copy ON
 * the source server so bytes travel source -> destination without ever
 * passing through the MCP host". Kept separate from transfer-service.ts
 * (already very large) so the command-construction and probe-failure-
 * classification logic can be exhaustively white-box tested without needing
 * any SSH connection at all.
 *
 * Design choices, stated once here rather than scattered across call sites:
 *
 *  - Auth is `existing-remote-key` only (PLAN.MD P1-08a scope). This module
 *    never reads, constructs, or embeds any key material, and never adds an
 *    `-i <identity>` flag -- the source server's OWN default SSH identity
 *    resolution (its own ~/.ssh/config, agent, or default identity files) is
 *    used exactly as if an operator ran the command by hand. The MCP host
 *    never even learns whether that resolution succeeds until the exec exits.
 *  - Host key trust is likewise entirely the SOURCE server's own
 *    ~/.ssh/known_hosts. This module never passes
 *    `-o StrictHostKeyChecking=no`, `-o UserKnownHostsFile=/dev/null`, or any
 *    other flag that would auto-accept an unknown host key -- an unknown
 *    host key must fail loudly (classifyDirectProbeFailure's "hostKey"
 *    category), never be silently trusted.
 *  - `-o BatchMode=yes` is always set. This does not weaken host-key or auth
 *    checking; it only prevents ssh from blocking on an interactive prompt
 *    (password prompt, "are you sure you want to continue connecting?") that
 *    can never be answered from a non-interactive exec channel -- without it,
 *    an unpinned host key would hang the whole call instead of failing fast.
 *  - There is a deliberately unused, more centralized design already sitting
 *    in src/contracts/config-schema.ts (`directRouteConfigSchema`, with a
 *    per-route pinned `hostKey: SHA256:...` fingerprint and a declarative
 *    `directRoutes:` YAML config surface). This delivery does NOT wire that
 *    up -- doing so means building a new v2-config-loader consumer, which is
 *    a materially larger, separate piece of work than "add a strategy
 *    parameter to the existing transfer tool". Left as an explicit note for
 *    whoever picks that up next, not silently ignored.
 */
import * as path from "node:path";
import type { TransferStrategy } from "../contracts/transfer-contract.js";

export type { TransferStrategy };

export type DirectBackend = "rsync" | "tar-ssh";

export interface DirectEndpoint {
  user: string;
  host: string;
  port: number;
}

export interface DirectCommandOptions {
  /** ssh/rsync -o ConnectTimeout=<n>, in whole seconds (ssh does not accept fractional seconds). */
  connectTimeoutSeconds: number;
}

/**
 * Minimal POSIX shell single-quoting: wraps `value` in single quotes and
 * escapes any embedded single quote with the standard `'\''` trick (close
 * the quote, emit an escaped literal quote, reopen the quote). Safe to nest:
 * applying this to a string that already contains single-quoted segments
 * (e.g. an inner `sh -c '...'` script) correctly preserves those inner quotes
 * as literal characters when the result is embedded in an outer shell
 * command -- see buildDirectTarSshCommand, which relies on exactly that.
 */
export function shellQuotePosix(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

function assertSafePort(port: number): number {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`invalid destination port for direct transfer: ${port}`);
  }
  return port;
}

function assertSafeTimeout(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(`invalid connect timeout for direct transfer: ${seconds}`);
  }
  return Math.max(1, Math.round(seconds));
}

function sshOptionPrefix(dest: DirectEndpoint, opts: DirectCommandOptions): string {
  const port = assertSafePort(dest.port);
  const timeout = assertSafeTimeout(opts.connectTimeoutSeconds);
  // BatchMode=yes: fail fast instead of hanging on a prompt that can never be
  // answered (see module doc comment). No StrictHostKeyChecking/
  // UserKnownHostsFile override of any kind -- host key trust is entirely the
  // source server's own known_hosts, by design.
  return `ssh -o BatchMode=yes -o ConnectTimeout=${timeout} -p ${port}`;
}

function userAtHost(dest: DirectEndpoint): string {
  return `${shellQuotePosix(dest.user)}@${shellQuotePosix(dest.host)}`;
}

/**
 * Build the command to run ON THE SOURCE SERVER for the rsync direct
 * backend: rsync reads sourcePath from its own (the source's) local
 * filesystem and pushes it straight to the destination over its own ssh
 * subprocess. The MCP host never sees the file's bytes.
 */
export function buildDirectRsyncCommand(
  sourcePath: string,
  dest: DirectEndpoint,
  destPath: string,
  opts: DirectCommandOptions,
): string {
  const rsyncEeValue = sshOptionPrefix(dest, opts);
  const remoteSpec = `${dest.user}@${dest.host}:${destPath}`;
  return [
    "rsync",
    "-a",
    "-e",
    shellQuotePosix(rsyncEeValue),
    "--",
    shellQuotePosix(sourcePath),
    shellQuotePosix(remoteSpec),
  ].join(" ");
}

/**
 * Build the command to run ON THE SOURCE SERVER for the tar|ssh direct
 * backend: `tar -cf -` packs sourcePath into a stream piped straight into a
 * real ssh subprocess, which forwards it to the destination's own `tar -xf -`
 * over its own SSH session. The MCP host never sees the archive's bytes.
 *
 * The destination-side script uses "$1"/"$2" positional parameters (passed
 * after a literal `_` placeholder for $0) rather than interpolating the
 * paths directly into the script text, specifically so sourcePath/destPath
 * only need ONE layer of shell quoting each (via shellQuotePosix) instead of
 * needing to be safely embedded inside an already-quoted script body.
 * `mktemp -d` + extract-then-move-then-rm gives the destination path exact
 * (not "into a directory") semantics, matching relay mode's existing
 * single-file/single-tree "source path's bytes land at exactly destPath"
 * contract, and never partially overwrites destPath (mv is the last step).
 */
export function buildDirectTarSshCommand(
  sourcePath: string,
  dest: DirectEndpoint,
  destPath: string,
  opts: DirectCommandOptions,
): string {
  const sourceDir = path.posix.dirname(sourcePath);
  const sourceBase = path.posix.basename(sourcePath);
  const remoteScript =
    "set -e; d=$(mktemp -d); tar -xf - -C \"$d\"; mkdir -p \"$(dirname \"$1\")\"; " +
    'mv -f "$d/$2" "$1"; rm -rf "$d"';
  const innerRemoteCommand = [
    "sh -c",
    shellQuotePosix(remoteScript),
    "_",
    shellQuotePosix(destPath),
    shellQuotePosix(sourceBase),
  ].join(" ");
  return [
    "tar -cf - -C",
    shellQuotePosix(sourceDir),
    "--",
    shellQuotePosix(sourceBase),
    "|",
    sshOptionPrefix(dest, opts),
    userAtHost(dest),
    shellQuotePosix(innerRemoteCommand),
  ].join(" ");
}

export type DirectProbeFailureCategory = "route" | "hostKey" | "auth" | "unknown";

export interface DirectProbeFailureClassification {
  category: DirectProbeFailureCategory;
  reason: string;
}

/**
 * Pure classification of a failed non-interactive `ssh ... true` probe run
 * on the source server, from its real exit code / stderr. Distinguishes
 * "cannot reach the destination at all" from "reached it but the host key
 * isn't pinned" from "reached it, host key is fine, but auth failed" --
 * PLAN.MD requires per-item probe results and an ACCURATE fallback reason,
 * not just "direct failed".
 */
export function classifyDirectProbeFailure(exitCode: number | null, stderr: string): DirectProbeFailureClassification {
  const text = stderr ?? "";
  if (/host key verification failed/i.test(text)) {
    return {
      category: "hostKey",
      reason:
        "the destination host key is not pinned in the source server's known_hosts " +
        "(direct transfer never auto-accepts an unknown host key; add it on the source explicitly, e.g. via ssh-keyscan >> ~/.ssh/known_hosts)",
    };
  }
  if (/permission denied/i.test(text)) {
    return {
      category: "auth",
      reason: "non-interactive existing-remote-key authentication from the source server to the destination failed",
    };
  }
  if (/connection refused/i.test(text)) {
    return {
      category: "route",
      reason: "the source server could not reach the destination host:port (connection refused)",
    };
  }
  if (/(?:connection|operation|connect) timed? ?out/i.test(text)) {
    return {
      category: "route",
      reason:
        "the source server could not reach the destination host:port within the connect timeout " +
        "(direct transfer cannot traverse NAT; use a jump host, an overlay network, or strategy=relay instead)",
    };
  }
  if (/no route to host|network is unreachable|could not resolve hostname/i.test(text)) {
    return {
      category: "route",
      reason: `the source server could not reach the destination host:port (${text.trim().split("\n")[0]})`,
    };
  }
  const tail = text.trim().slice(-300);
  return {
    category: "unknown",
    reason: `direct-transfer probe failed on the source server (exit ${exitCode ?? "unknown"})${tail ? `: ${tail}` : ""}`,
  };
}

export interface DirectBackendCapabilities {
  rsyncAvailable: boolean;
  sshAvailable: boolean;
  tarAvailable: boolean;
}

export type DirectBackendSelection =
  | { ok: true; backend: DirectBackend }
  | { ok: false; reason: string };

/** Pure. Backend priority per PLAN.MD P1-08a: rsync on the source, else tar|ssh. No rclone. */
export function selectDirectBackend(caps: DirectBackendCapabilities): DirectBackendSelection {
  if (!caps.sshAvailable) {
    return { ok: false, reason: "the source server has no ssh client available, which both direct backends (rsync, tar|ssh) require" };
  }
  if (caps.rsyncAvailable) return { ok: true, backend: "rsync" };
  if (caps.tarAvailable) return { ok: true, backend: "tar-ssh" };
  return { ok: false, reason: "the source server has neither rsync nor tar available for a direct backend" };
}

export interface DirectProbeItemResult {
  ok: boolean;
  reason?: string;
}

export interface DirectProbeReport {
  ok: boolean;
  reason?: string;
  backend?: DirectBackend;
  items: {
    destinationPathPolicy: DirectProbeItemResult;
    backendAvailable: DirectProbeItemResult & { backend?: DirectBackend };
    route: DirectProbeItemResult;
    hostKey: DirectProbeItemResult;
    auth: DirectProbeItemResult;
  };
}
