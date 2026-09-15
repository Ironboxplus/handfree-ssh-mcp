import { z } from "zod";
import { durationSchema } from "./primitives.js";
import { makeErrorObject, type ErrorObject } from "./error.js";

// PLAN.MD Rev.3 §0: "暂缓不等于删除：Phase 3/4 的契约位（sync=flush、sync tools
// 名称、HTTP 路由）在 Phase 0 契约中保留占位并明确返回未实现错误，避免将来回填时
// 推翻既有 schema". This module is that placeholder layer for Phase 3 sync.
// It defines real, structurally complete param schemas (so retrofitting
// Phase 3 later is additive, not breaking) and a single real, non-silent
// rejection path — but implements NO sync behavior. See §5.2, §5.3, §5.6.

// ---------------------------------------------------------------------------
// Deferred sync MCP tools (§5.2)
// ---------------------------------------------------------------------------

export const DEFERRED_SYNC_TOOL_NAMES = [
  "sync-start",
  "sync-stop",
  "sync-pause",
  "sync-resume",
  "sync-flush",
  "sync-rescan",
  "sync-status",
  "sync-plan",
  "sync-approve-delete",
  "sync-apply-plan",
  "sync-conflicts",
  "sync-resolve-conflict",
] as const;
export type DeferredSyncToolName = (typeof DEFERRED_SYNC_TOOL_NAMES)[number];

export const syncStartParamsSchema = z.object({ profile: z.string().min(1), initial: z.boolean().optional() });
export const syncStopParamsSchema = z.object({ profile: z.string().min(1) });
export const syncPauseParamsSchema = z.object({ profile: z.string().min(1) });
export const syncResumeParamsSchema = z.object({ profile: z.string().min(1) });
export const syncFlushParamsSchema = z.object({ profile: z.string().min(1), timeout: durationSchema.optional() });
export const syncRescanParamsSchema = z.object({
  profile: z.string().min(1),
  side: z.enum(["local", "remote", "both"]).optional(),
  paths: z.array(z.string()).optional(),
});
export const syncStatusParamsSchema = z.object({
  profile: z.string().optional(),
  includeFiles: z.boolean().optional(),
  includeConflicts: z.boolean().optional(),
});
export const syncPlanParamsSchema = z.object({ profile: z.string().min(1), includeDeletes: z.boolean().optional() });
export const syncApproveDeleteParamsSchema = z.object({ planId: z.string().min(1), planDigest: z.string().min(1) });
export const syncApplyPlanParamsSchema = z.object({ planId: z.string().min(1), approvalToken: z.string().optional() });
export const syncConflictsParamsSchema = z.object({
  profile: z.string().min(1),
  state: z.enum(["open", "resolved"]).optional(),
  limit: z.number().int().positive().optional(),
});
export const syncResolveConflictParamsSchema = z.object({
  profile: z.string().min(1),
  relativePath: z.string().min(1),
  resolution: z.enum(["take-local", "take-remote", "keep-both"]),
  planDigest: z.string().min(1),
});

export const DEFERRED_SYNC_TOOL_PARAM_SCHEMAS: Record<DeferredSyncToolName, z.ZodTypeAny> = {
  "sync-start": syncStartParamsSchema,
  "sync-stop": syncStopParamsSchema,
  "sync-pause": syncPauseParamsSchema,
  "sync-resume": syncResumeParamsSchema,
  "sync-flush": syncFlushParamsSchema,
  "sync-rescan": syncRescanParamsSchema,
  "sync-status": syncStatusParamsSchema,
  "sync-plan": syncPlanParamsSchema,
  "sync-approve-delete": syncApproveDeleteParamsSchema,
  "sync-apply-plan": syncApplyPlanParamsSchema,
  "sync-conflicts": syncConflictsParamsSchema,
  "sync-resolve-conflict": syncResolveConflictParamsSchema,
};

/** Pure. The one real behavior this module has: every deferred sync tool
 * name maps to the exact same stable, non-silent rejection. Whatever thin
 * MCP registration shim P0-04+ wires these tool names to must call this and
 * return its result, not invent a bespoke message per tool. */
export function handleDeferredSyncTool(toolName: DeferredSyncToolName): ErrorObject {
  return makeErrorObject(
    "SYNC_NOT_AVAILABLE",
    `${toolName} is part of Phase 3 (three-mode sync), deferred per PLAN.MD Rev.3 §0. The param schema is stable and ready for Phase 3; no sync behavior is implemented in this delivery round.`,
    { retryable: false },
  );
}

// ---------------------------------------------------------------------------
// §5.6 three-mode decision table — TYPES ONLY. Explicitly NOT implemented or
// tested this round (team-lead instruction for P0-03: "Define the types so
// the contract layer is stable, but do not implement or exhaustively test
// the planner — mark it explicitly deferred with a reason. Don't fabricate
// coverage for logic we aren't building."). §7.3 requires mode-planner.ts to
// have 100% branch coverage once it exists; a stub that only throws has no
// branches to fake-cover, which is the point.
// ---------------------------------------------------------------------------

/** ≡ / ≠ / ∅ per side, relative to `base` (the last successfully synced
 * state) — see §5.6's table header. */
export const syncTriStateSchema = z.enum(["same", "changed", "absent"]);
export type SyncTriState = z.infer<typeof syncTriStateSchema>;

export const syncDirectionSchema = z.enum(["push", "pull", "bidirectional"]);
export type SyncDirection = z.infer<typeof syncDirectionSchema>;

export const modePlannerDecisionSchema = z.enum([
  "no-op",
  "upload",
  "download",
  "update-base",
  "conflict",
  "delete-remote-pending-approval",
  "delete-local-pending-approval",
  "clear-tombstone",
  "reupload",
  "redownload",
  "divergence-policy",
  "type-change-policy",
]);
export type ModePlannerDecision = z.infer<typeof modePlannerDecisionSchema>;

export interface ModePlannerInput {
  direction: SyncDirection;
  local: SyncTriState;
  remote: SyncTriState;
  /** Whether `base` (last synced state) recorded this path at all. */
  baseExisted: boolean;
  /** Only meaningful when local === "changed" && remote === "changed", or
   * for the "both newly created" row. */
  hashMatches?: boolean;
  /** file<->dir type change row. */
  typeChanged?: boolean;
}

export const MODE_PLANNER_NOT_IMPLEMENTED_REASON =
  "sync/mode-planner.ts (PLAN.MD §5.6's three-mode decision table) is Phase 3 scope, deferred per Rev.3 §0. Only ModePlannerInput/ModePlannerDecision types are defined in P0-03 so the contract layer is stable for later retrofit without a breaking schema change. The decision logic, and its required 100% branch coverage (§7.3), are intentionally not implemented or tested here.";

export type ModePlanner = (input: ModePlannerInput) => ModePlannerDecision;

/** Deliberately unimplemented — see MODE_PLANNER_NOT_IMPLEMENTED_REASON. */
export const modePlanner: ModePlanner = () => {
  throw new Error(MODE_PLANNER_NOT_IMPLEMENTED_REASON);
};

// ---------------------------------------------------------------------------
// §5.3 HTTP routes — placeholder manifest for the OpenAPI generator. The
// `deferred: true` routes are the Phase 3 sync/plan/conflict family; they
// exist in the schema/OpenAPI layer now so Phase 3 doesn't need a breaking
// path change later, but no http/ server implements any of this yet (that's
// P0-06+Phase 4 scope).
// ---------------------------------------------------------------------------

export interface HttpRouteDef {
  method: "GET" | "POST";
  path: string;
  deferred: boolean;
}

const SYNC_ACTIONS = ["start", "stop", "pause", "resume", "flush", "rescan", "plan"] as const;

export const HTTP_ROUTES: readonly HttpRouteDef[] = [
  { method: "GET", path: "/api/v1/servers", deferred: false },
  { method: "POST", path: "/api/v1/servers/:server/reconnect", deferred: false },
  { method: "POST", path: "/api/v1/servers/:server/close", deferred: false },
  { method: "GET", path: "/api/v1/servers/:server/files", deferred: false },
  { method: "GET", path: "/api/v1/servers/:server/files/stat", deferred: false },
  { method: "GET", path: "/api/v1/jobs", deferred: false },
  { method: "GET", path: "/api/v1/jobs/:jobId", deferred: false },
  { method: "GET", path: "/api/v1/jobs/:jobId/events", deferred: false },
  { method: "GET", path: "/api/v1/jobs/:jobId/logs", deferred: false },
  { method: "POST", path: "/api/v1/jobs/:jobId/cancel", deferred: false },
  { method: "GET", path: "/api/v1/sync/profiles", deferred: true },
  ...SYNC_ACTIONS.map((action): HttpRouteDef => ({ method: "POST", path: `/api/v1/sync/:profile/${action}`, deferred: true })),
  { method: "GET", path: "/api/v1/sync/:profile/conflicts", deferred: true },
  { method: "POST", path: "/api/v1/sync/:profile/conflicts/resolve", deferred: true },
  { method: "POST", path: "/api/v1/sync/plans/:planId/approve-delete", deferred: true },
  { method: "POST", path: "/api/v1/sync/plans/:planId/apply", deferred: true },
  { method: "POST", path: "/api/v1/commands", deferred: false },
  { method: "POST", path: "/api/v1/runs", deferred: false },
  { method: "POST", path: "/api/v1/runs/:runId/retry", deferred: false },
  { method: "POST", path: "/api/v1/transfers", deferred: false },
  { method: "GET", path: "/api/v1/transfers/capabilities", deferred: false },
  { method: "GET", path: "/api/v1/events", deferred: false },
  { method: "POST", path: "/api/v1/auth/bootstrap", deferred: false },
  { method: "POST", path: "/api/v1/auth/logout", deferred: false },
];

/** Pure. */
export function isDeferredRoute(method: HttpRouteDef["method"], path: string): boolean {
  const route = HTTP_ROUTES.find((r) => r.method === method && r.path === path);
  if (!route) throw new Error(`unknown route ${method} ${path}`);
  return route.deferred;
}
