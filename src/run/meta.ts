import { z } from "zod";

/**
 * PLAN.MD P2-03: the remote state directory's files are the single source
 * of truth (see PLAN.MD's "Phase 2 与 Rev.4 取消 P0-05/P0-06 的关系" -- no
 * local JobStore, no local daemon; an MCP adapter restart loses nothing
 * because it held nothing). These are the parsers for that on-disk shape.
 * Parsing never throws for a malformed/partial file (the wrapper writes
 * atomically via write-temp-then-rename, but a caller can still observe a
 * file mid-creation, truncated by a killed connection, etc.) -- callers get
 * back a discriminated result and decide what a parse failure means for run
 * status (usually "still preparing" or "corrupt state, investigate").
 */

export const processIdentitySchema = z.object({
  bootId: z.string().min(1),
  pid: z.number().int().positive(),
  pgid: z.number().int().positive(),
  startTicks: z.string().min(1),
  wrapperToken: z.string().min(1),
});
export type ProcessIdentity = z.infer<typeof processIdentitySchema>;

export const runMetaSchema = z.object({
  runId: z.string().min(1),
  profile: z.string().min(1),
  server: z.string().min(1),
  remoteRoot: z.string().min(1),
  workdir: z.string().min(1),
  executable: z.string().min(1),
  entrypoint: z.string().min(1),
  args: z.array(z.string()),
  env: z.record(z.string(), z.string()),
  createdAt: z.string().min(1),
  identity: processIdentitySchema,
});
export type RunMeta = z.infer<typeof runMetaSchema>;

/**
 * `waitStatus` is the raw shell `$?` after `wait`-ing on the child (0-255):
 * either a genuine exit code, or 128+signum by the POSIX wait-status
 * convention. Stored raw (not pre-split into exitCode/signal) because the
 * remote wrapper is plain bash with no signal-name table to duplicate --
 * interpretWaitStatus() below is the single place that convention is
 * decoded, in TypeScript, so it can be unit-tested exhaustively.
 */
export const runExitSchema = z.object({
  waitStatus: z.number().int().min(0).max(255),
  finishedAt: z.string().min(1),
  cancelled: z.boolean(),
});
export type RunExit = z.infer<typeof runExitSchema>;

export const orphanedMarkerSchema = z.object({
  detectedAt: z.string().min(1),
  reason: z.string().min(1),
});
export type OrphanedMarker = z.infer<typeof orphanedMarkerSchema>;

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

function parseJsonSafely<T>(schema: z.ZodType<T>, raw: string): ParseResult<T> {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    return { ok: false, error: `invalid JSON: ${(error as Error).message}` };
  }
  const result = schema.safeParse(json);
  if (!result.success) {
    return { ok: false, error: result.error.message };
  }
  return { ok: true, value: result.data };
}

export function parseRunMeta(raw: string): ParseResult<RunMeta> {
  return parseJsonSafely(runMetaSchema, raw);
}

export function parseRunExit(raw: string): ParseResult<RunExit> {
  return parseJsonSafely(runExitSchema, raw);
}

export function parseOrphanedMarker(raw: string): ParseResult<OrphanedMarker> {
  return parseJsonSafely(orphanedMarkerSchema, raw);
}

/**
 * Pure. Standard 128+N wait-status convention (used by bash, systemd,
 * docker, ...): a wait-status exit code over 128 whose remainder is a valid
 * signal number is reported as "terminated by signal N" rather than a
 * literal exit code. This is a heuristic, not a certainty -- a process that
 * itself calls `exit(137)` is indistinguishable from one killed by SIGKILL
 * from wait status alone. Documented as such; the wrapper script
 * additionally records whether cancel() itself sent the signal (see
 * RunExit.cancelled) so the common case (we killed it) is unambiguous.
 */
const SIGNAL_NAMES: Record<number, string> = {
  1: "SIGHUP", 2: "SIGINT", 3: "SIGQUIT", 6: "SIGABRT", 9: "SIGKILL",
  11: "SIGSEGV", 13: "SIGPIPE", 15: "SIGTERM",
};

export function interpretWaitStatus(waitStatus: number): { exitCode: number | null; signal: string | null } {
  if (waitStatus > 128) {
    const signalNumber = waitStatus - 128;
    const signal = SIGNAL_NAMES[signalNumber];
    if (signal) {
      return { exitCode: null, signal };
    }
  }
  return { exitCode: waitStatus, signal: null };
}
