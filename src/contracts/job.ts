import { z } from "zod";
import { errorObjectSchema } from "./error.js";

// PLAN.MD §5.5: the one generic job state machine shared by every job type
// (transfer, workspace-run; sync jobs join in Phase 3). Phase pipelines
// (push/preflight/launching/... or pack/connect/transfer/...) live INSIDE
// the generic `running` state via a separate `phase` field — see
// runPhaseSchema/transferPhaseSchema below and §5.8's pipeline rules.

export const JOB_STATES = [
  "queued",
  "preparing",
  "running",
  "verifying",
  "completed",
  "cancelling",
  "cancelled",
  "failed",
  "recovering",
  "orphaned",
] as const;

export type JobState = (typeof JOB_STATES)[number];

export const jobStateSchema = z.enum(JOB_STATES);

export const TERMINAL_JOB_STATES: ReadonlySet<JobState> = new Set(["completed", "cancelled", "failed"]);

/** Pure. A terminal state has no valid outgoing transition at all. */
export function isTerminalState(state: JobState): boolean {
  return TERMINAL_JOB_STATES.has(state);
}

// Transitions any ordinary API caller may request. This is exactly the
// table printed in §5.5 (recovering's own resolution transitions ARE
// ordinary here — the plan does not call those system-only, only the
// entry-into-recovering edges below).
const API_TRANSITIONS: Readonly<Record<JobState, readonly JobState[]>> = {
  queued: ["preparing", "cancelling", "failed"],
  preparing: ["running", "cancelling", "failed"],
  running: ["verifying", "cancelling", "failed"],
  verifying: ["completed", "cancelling", "failed"],
  cancelling: ["cancelled", "failed"],
  recovering: ["running", "verifying", "completed", "cancelled", "failed", "orphaned"],
  orphaned: ["recovering", "failed"],
  completed: [],
  cancelled: [],
  failed: [],
};

// §5.5: "Controller recovery scanner 拥有唯一的 system-only 转换权限：
// preparing/running/verifying/cancelling → recovering". A crashed process's
// leftover non-terminal jobs enter `recovering` ONLY via this scanner, never
// via a normal job-state-transition API call. `queued` is deliberately
// absent here: a queued job that hasn't produced any side effect yet stays
// queued and is simply rescheduled (§5.5), it never becomes `recovering`.
const SYSTEM_ONLY_TRANSITIONS: Readonly<Partial<Record<JobState, readonly JobState[]>>> = {
  preparing: ["recovering"],
  running: ["recovering"],
  verifying: ["recovering"],
  cancelling: ["recovering"],
};

export type TransitionActor = "api" | "system";

/** Pure. Returns every state `from` may legally move to for the given actor. */
export function allowedTransitions(from: JobState, actor: TransitionActor = "api"): readonly JobState[] {
  const base = API_TRANSITIONS[from] ?? [];
  if (actor === "system") {
    const extra = SYSTEM_ONLY_TRANSITIONS[from] ?? [];
    return [...base, ...extra];
  }
  return base;
}

/** Pure. §5.5: "任何其他转换返回 INVALID_STATE_TRANSITION". */
export function isValidTransition(from: JobState, to: JobState, actor: TransitionActor = "api"): boolean {
  return allowedTransitions(from, actor).includes(to);
}

/** Pure. Throws a §5.2-shaped error (via the caller-visible error code) when
 * the transition is illegal; returns void otherwise. */
export function assertValidTransition(from: JobState, to: JobState, actor: TransitionActor = "api"): void {
  if (!isValidTransition(from, to, actor)) {
    throw new Error(`INVALID_STATE_TRANSITION: ${from} -> ${to} is not a legal ${actor} transition`);
  }
}

// ---------------------------------------------------------------------------
// Phase pipelines (§5.8) — a job's `phase` field while state === "running".
// These are NOT part of the generic state enum (§5.5 is explicit about
// that); each job *type* declares its own ordered phase list.
// ---------------------------------------------------------------------------

export const RUN_PHASES = ["push", "preflight", "launching", "remote-running", "collect"] as const;
export type RunPhase = (typeof RUN_PHASES)[number];
export const runPhaseSchema = z.enum(RUN_PHASES);

export const TRANSFER_PHASES = ["pack", "connect", "transfer", "verify", "extract", "cleanup"] as const;
export type TransferPhase = (typeof TRANSFER_PHASES)[number];
export const transferPhaseSchema = z.enum(TRANSFER_PHASES);

// ---------------------------------------------------------------------------
// Job record (§4.3 `jobs` table's public shape). Built ahead of P0-05's
// actual JobStore so downstream contracts (envelope, HTTP) have something
// concrete to reference; P0-05 owns the persistence layer, not this schema.
// ---------------------------------------------------------------------------

export const jobRecordSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  state: jobStateSchema,
  phase: z.union([runPhaseSchema, transferPhaseSchema]).optional(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  profile: z.string().nullable().optional(),
  server: z.string().nullable().optional(),
  error: errorObjectSchema.nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).optional().default({}),
});

export type JobRecord = z.infer<typeof jobRecordSchema>;

// §4.3: "所有异步操作都只有一个 canonical jobId。run tool 为用户可读性使用字段名
// runId，但其值与 jobs.id/run_records.job_id 完全相同". Pure structural check
// used by run-contract.ts's response schema.
export function assertRunIdMatchesJobId(runId: string, jobId: string): void {
  if (runId !== jobId) {
    throw new Error(`runId (${JSON.stringify(runId)}) must equal jobId (${JSON.stringify(jobId)}) per §4.3`);
  }
}
