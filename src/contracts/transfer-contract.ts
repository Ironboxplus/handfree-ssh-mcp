import { z } from "zod";
import { byteSizeSchema } from "./primitives.js";

// PLAN.MD §5.2 (new transfer params), §5.4 (legal strategy/engine/striped
// combinations) and §5.7 (batch upload). This is the v2 CONTRACT layer only
// — no engine/planner behavior lives here (that's Phase 1's transfer/*.ts).

// ---------------------------------------------------------------------------
// §5.2 extended transfer params
// ---------------------------------------------------------------------------

export const transferStrategySchema = z.enum(["auto", "direct", "relay"]);
export type TransferStrategy = z.infer<typeof transferStrategySchema>;

/** General transfer engine. Deliberately excludes "tar-ssh" — §5.4:
 * "tar-ssh 只叫 directBackend，不加入通用 engine 枚举". */
export const engineSchema = z.enum(["auto", "builtin", "rsync", "rclone"]);
export type Engine = z.infer<typeof engineSchema>;

/** Direct (remote A -> remote B) backend only. */
export const directBackendSchema = z.enum(["rsync", "rclone", "tar-ssh"]);
export type DirectBackend = z.infer<typeof directBackendSchema>;

export const stripedSchema = z.enum(["off", "auto", "on"]);
export type Striped = z.infer<typeof stripedSchema>;

export const topologySchema = z.enum(["local-remote", "remote-remote"]);
export type Topology = z.infer<typeof topologySchema>;

export const transferExtendedParamsSchema = z.object({
  strategy: transferStrategySchema.optional(),
  engine: engineSchema.optional(),
  striped: stripedSchema.optional(),
  streams: z.number().int().positive().optional(),
  checkers: z.number().int().positive().optional(),
  transfers: z.number().int().positive().optional(),
  maxBufferBytes: byteSizeSchema.optional(),
  background: z.boolean().optional(),
});

// ---------------------------------------------------------------------------
// §5.4 transfer legal-combination rules, as a pure function. Encodes only
// the STATICALLY decidable rules from the table (things that are illegal
// regardless of what capabilities turn out to be available at runtime).
// Capability-gated resolution (striped probe, direct backend ordering
// rsync -> rclone -> tar-ssh) is P1-05/P1-08 runtime planner behavior, not a
// static combination check, and is intentionally NOT reimplemented here.
// ---------------------------------------------------------------------------

export interface TransferCombinationInput {
  topology: Topology;
  strategy?: TransferStrategy;
  striped?: Striped;
  archive?: boolean;
}

export type TransferCombinationResult =
  | { ok: true; resolvedStrategy: TransferStrategy | undefined; resolvedStriped: Striped }
  | { ok: false; code: "TRANSFER_STRATEGY_NOT_APPLICABLE" | "TRANSFER_STRIPED_NOT_APPLICABLE"; message: string };

/** Pure. See §5.4's table; exhaustively value-tested in
 * src/tests/contracts.test.ts. */
export function validateTransferCombination(input: TransferCombinationInput): TransferCombinationResult {
  const archive = input.archive ?? false;

  if (input.topology === "local-remote") {
    if (input.strategy !== undefined) {
      return {
        ok: false,
        code: "TRANSFER_STRATEGY_NOT_APPLICABLE",
        message: "strategy does not apply to local<->remote transfers (§5.4 row 1: \"不适用，传入即报错\"); omit it",
      };
    }
  } else {
    const strategy = input.strategy ?? "auto";
    if (strategy === "direct" && input.striped === "on") {
      return {
        ok: false,
        code: "TRANSFER_STRIPED_NOT_APPLICABLE",
        message: "striped does not apply to direct remote-to-remote transfers (§5.4 row 3: \"不适用，传入 on 即报错\")",
      };
    }
  }

  if (archive && input.striped === "on") {
    return {
      ok: false,
      code: "TRANSFER_STRIPED_NOT_APPLICABLE",
      message: "striped:on is incompatible with archive:true (§5.4: \"archive 与 striped 不同时启用\")",
    };
  }

  // §5.4: "striped:auto 在 archive 时解析为 off".
  const resolvedStriped: Striped = archive ? "off" : (input.striped ?? "off");
  const resolvedStrategy = input.topology === "remote-remote" ? (input.strategy ?? "auto") : undefined;
  return { ok: true, resolvedStrategy, resolvedStriped };
}

// ---------------------------------------------------------------------------
// §5.7 batch upload
// ---------------------------------------------------------------------------

export const MAX_BATCH_UPLOAD_SIZE = 1000;

export const onErrorModeSchema = z.enum(["abort", "continue"]);
export type OnErrorMode = z.infer<typeof onErrorModeSchema>;

export const perFileStatusSchema = z.enum(["uploaded", "skipped", "failed"]);

export const batchFileResultSchema = z.object({
  localPath: z.string(),
  remotePath: z.string(),
  status: perFileStatusSchema,
  reason: z.string().optional(),
  crlfFixed: z.boolean().optional(),
});

export const batchUploadResultSchema = z.object({
  results: z.array(batchFileResultSchema),
  skipCount: z.number().int().nonnegative(),
  crlfFixCount: z.number().int().nonnegative(),
  failedCount: z.number().int().nonnegative(),
});

/** Splits on both `/` and `\` — localPath is a path on the MCP host, which
 * on this project's own Windows dev machine means backslash paths are a
 * real input, not a hypothetical. Pure. */
export function basenameOf(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/").replace(/\/+$/, "");
  const idx = normalized.lastIndexOf("/");
  return idx === -1 ? normalized : normalized.slice(idx + 1);
}

export interface BatchTargetCollision {
  basename: string;
  paths: string[];
}

/** Pure. §5.7: "basename 冲突在传输前硬失败...数组内重复路径同样报错，不静默去重".
 * An exact duplicate path is a degenerate basename collision (two identical
 * paths trivially share a basename), so this single pass covers both cases
 * named in the plan text. */
export function detectBatchTargetCollisions(paths: string[]): BatchTargetCollision[] {
  const byBasename = new Map<string, string[]>();
  for (const p of paths) {
    const base = basenameOf(p);
    const list = byBasename.get(base) ?? [];
    list.push(p);
    byBasename.set(base, list);
  }
  const collisions: BatchTargetCollision[] = [];
  for (const [basename, list] of byBasename) {
    if (list.length > 1) collisions.push({ basename, paths: list });
  }
  return collisions;
}

export type BatchUploadValidation =
  | { ok: true }
  | { ok: false; code: "INVALID_CONFIGURATION"; message: string }
  | { ok: false; code: "BATCH_TOO_LARGE"; message: string }
  | { ok: false; code: "BATCH_TARGET_COLLISION"; message: string; collisions: BatchTargetCollision[] };

/** Pure. §5.7's pre-transfer validation, in the order the plan specifies:
 * empty -> too-large -> collisions. Callers must run this (and get `ok:
 * true`) before issuing a single SFTP call — P1-09-A3 proves that with a
 * real SFTP-call counter of 0 on a rejected batch. */
export function validateBatchUpload(paths: string[]): BatchUploadValidation {
  if (paths.length === 0) {
    return { ok: false, code: "INVALID_CONFIGURATION", message: "batch upload localPath array must not be empty" };
  }
  if (paths.length > MAX_BATCH_UPLOAD_SIZE) {
    return {
      ok: false,
      code: "BATCH_TOO_LARGE",
      message: `batch upload array exceeds the ${MAX_BATCH_UPLOAD_SIZE}-file limit (got ${paths.length})`,
    };
  }
  const collisions = detectBatchTargetCollisions(paths);
  if (collisions.length > 0) {
    return {
      ok: false,
      code: "BATCH_TARGET_COLLISION",
      message: `${collisions.length} basename collision(s) would overwrite each other under the same remotePath`,
      collisions,
    };
  }
  return { ok: true };
}

/** Pure. §5.7: "archive: true + 数组：本轮返回 INVALID_CONFIGURATION". */
export function validateArchiveNotCombinedWithBatch(localPath: string | string[], archive: boolean | undefined): BatchUploadValidation {
  if (Array.isArray(localPath) && archive === true) {
    return { ok: false, code: "INVALID_CONFIGURATION", message: "archive:true is not supported with a batch (array) localPath in this delivery round" };
  }
  return { ok: true };
}

export const batchUploadParamsSchema = z.object({
  localPath: z.union([z.string(), z.array(z.string()).min(1).max(MAX_BATCH_UPLOAD_SIZE)]),
  remotePath: z.string(),
  onError: onErrorModeSchema.optional().default("abort"),
  fileConcurrency: z.number().int().positive().max(32).optional(),
  archive: z.boolean().optional(),
});
