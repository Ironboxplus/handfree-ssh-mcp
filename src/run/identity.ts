import type { ProcessIdentity } from "./meta.js";

/**
 * PLAN.MD P2-04: "cancel 前重新核对 boot ID/start ticks/wrapper token/scope；
 * 不匹配进入 orphaned，绝不向可能复用的 PID/PGID 发信号." This is the pure decision
 * function: given the identity recorded at launch time and a fresh probe of
 * what is *currently* running under that PID, decide whether it is safe to
 * signal it. No I/O here -- the actual `/proc` probe and the actual
 * `kill()` live in the remote wrapper/cancel script (Linux-only, cannot be
 * genuinely exercised on this Windows dev box; see the acceptance tests).
 */

/** What a live probe of the remote process table found for the recorded
 * pid, or `found: false` if no such pid exists at all right now. */
export type ProcessProbe =
  | { found: false }
  | { found: true; bootId: string; pid: number; pgid: number; startTicks: string; wrapperToken: string };

export type CancelDecision =
  | { action: "signal" }
  | { action: "orphaned"; reason: string };

/**
 * Pure. Every recorded field must match exactly, or the decision is
 * `orphaned` -- a PID/PGID match alone is not sufficient (that is exactly
 * the PID-reuse case this function exists to catch), so bootId, startTicks,
 * and wrapperToken all have to agree too.
 */
export function decideCancelAction(recorded: ProcessIdentity, probe: ProcessProbe): CancelDecision {
  if (!probe.found) {
    return { action: "orphaned", reason: `no process with pid ${recorded.pid} is currently running` };
  }
  if (probe.bootId !== recorded.bootId) {
    return { action: "orphaned", reason: `boot id changed (recorded ${recorded.bootId}, now ${probe.bootId}) -- the host rebooted` };
  }
  if (probe.pid !== recorded.pid) {
    return { action: "orphaned", reason: `pid mismatch (recorded ${recorded.pid}, probe reported ${probe.pid})` };
  }
  if (probe.pgid !== recorded.pgid) {
    return { action: "orphaned", reason: `pgid mismatch (recorded ${recorded.pgid}, now ${probe.pgid}) -- likely pid reuse` };
  }
  if (probe.startTicks !== recorded.startTicks) {
    return { action: "orphaned", reason: `process start time changed (recorded ticks ${recorded.startTicks}, now ${probe.startTicks}) -- likely pid reuse` };
  }
  if (probe.wrapperToken !== recorded.wrapperToken) {
    return { action: "orphaned", reason: "wrapper token mismatch -- likely pid reuse" };
  }
  return { action: "signal" };
}
