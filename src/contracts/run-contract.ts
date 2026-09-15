import { z } from "zod";
import { durationSchema } from "./primitives.js";
import { RUN_PHASES, TRANSFER_PHASES } from "./job.js";

// PLAN.MD §5.2 (workspace-run params) and §5.8 (job phase pipeline rules,
// generic across job types). No run/transfer SERVICE behavior lives here —
// only the contract and the pure pipeline-bookkeeping rules explicit enough
// in §5.8 to value-test without building the services that use them.

// ---------------------------------------------------------------------------
// §5.2 workspace-run params
// ---------------------------------------------------------------------------

/** §5.2: "sync（Phase 3 占位）：本轮只接受 none；传入 flush 返回
 * SYNC_NOT_AVAILABLE，不得静默忽略." The schema itself accepts both values
 * (parsing must not reject "flush" as a bad shape) — checkSyncParamSupported
 * is the explicit, non-silent rejection the plan requires. */
export const workspaceRunSyncParamSchema = z.enum(["none", "flush"]);

export const workspaceRunParamsSchema = z.object({
  profile: z.string().min(1),
  entrypoint: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  push: z.boolean().optional(),
  collect: z.array(z.string()).optional(),
  sync: workspaceRunSyncParamSchema.optional(),
  timeout: durationSchema.optional(),
  stream: z.boolean().optional(),
});

export type SyncParamCheck = { ok: true } | { ok: false; code: "SYNC_NOT_AVAILABLE"; message: string };

/** Pure. Deferred Phase 3 barrier check — see the module doc comment. */
export function checkSyncParamSupported(sync: z.infer<typeof workspaceRunSyncParamSchema> | undefined): SyncParamCheck {
  if (sync === "flush") {
    return {
      ok: false,
      code: "SYNC_NOT_AVAILABLE",
      message: "sync=flush is deferred to Phase 3 (PLAN.MD §5.2, P3-07); this delivery round only accepts sync=none or omitting sync",
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// §5.8 job phase pipeline — generic rules shared by every phase-pipeline job
// type (workspace-run, transfer). Optional/skippable phases are the ones
// PLAN.MD writes in [brackets]:
//   workspace-run:  [push] -> preflight -> launching -> remote-running -> [collect]
//   transfer:       [pack] -> connect -> transfer -> verify -> [extract] -> cleanup
// ---------------------------------------------------------------------------

export const WORKSPACE_RUN_OPTIONAL_PHASES: ReadonlySet<string> = new Set(["push", "collect"]);
export const TRANSFER_PIPELINE_OPTIONAL_PHASES: ReadonlySet<string> = new Set(["pack", "extract"]);

export { RUN_PHASES as WORKSPACE_RUN_PHASE_ORDER, TRANSFER_PHASES as TRANSFER_PIPELINE_PHASE_ORDER };

export const phaseStatusSchema = z.enum(["completed", "failed", "skipped"]);
export type PhaseStatus = z.infer<typeof phaseStatusSchema>;

export const phaseOutcomeSchema = z.object({
  phase: z.string().min(1),
  status: phaseStatusSchema,
  reason: z.string().optional(),
});
export type PhaseOutcome = z.infer<typeof phaseOutcomeSchema>;

export const phasePipelineResultSchema = z.object({
  // §5.8: "整条流水线只有一个 canonical jobId" — a single top-level field
  // rather than a per-phase id makes "more than one jobId" structurally
  // impossible to represent, which is the contract-layer way to enforce it.
  jobId: z.string().min(1),
  phases: z.array(phaseOutcomeSchema),
});
export type PhasePipelineResult = z.infer<typeof phasePipelineResultSchema>;

/** Pure. §5.8: "cleanup 按 phase 反序执行". Only phases that actually ran
 * (completed or failed — i.e. had a chance to produce side effects) are
 * included; skipped phases never ran, so they have nothing to clean up and
 * are correctly absent from the cleanup order (they still appear in the
 * outcomes report itself — see findMissingPhaseReports). */
export function computeCleanupOrder(declaredPhaseOrder: readonly string[], outcomes: readonly PhaseOutcome[]): string[] {
  const ranPhases = new Set(
    outcomes.filter((o) => o.status === "completed" || o.status === "failed").map((o) => o.phase),
  );
  return [...declaredPhaseOrder].filter((phase) => ranPhases.has(phase)).reverse();
}

/** Pure. §5.8: "可选 phase 被跳过时仍要在结果里显式标注 skipped 及原因，不能静默消失".
 * Returns the phases from the declared pipeline that have NO entry at all in
 * `outcomes` — i.e. actually missing/silently-dropped, which is always a
 * contract violation regardless of whether the phase was optional. */
export function findMissingPhaseReports(declaredPhaseOrder: readonly string[], outcomes: readonly PhaseOutcome[]): string[] {
  const reported = new Set(outcomes.map((o) => o.phase));
  return declaredPhaseOrder.filter((phase) => !reported.has(phase));
}

/** Pure. A phase reported "skipped" must carry a non-empty `reason` — §5.8
 * forbids a silent, unexplained skip. */
export function findSkippedPhasesMissingReason(outcomes: readonly PhaseOutcome[]): string[] {
  return outcomes.filter((o) => o.status === "skipped" && !(o.reason && o.reason.trim().length > 0)).map((o) => o.phase);
}
