import { z } from "zod";
import { durationSchema, byteSizeSchema } from "./primitives.js";
import { transferStrategySchema, engineSchema, stripedSchema, directBackendSchema } from "./transfer-contract.js";

// PLAN.MD §5.1: the NEW v2 YAML config surface (daemon/web/transferDefaults/
// runProfiles/syncProfiles/directRoutes). This deliberately does NOT
// re-express the existing 1.x config (`servers`, commandWhitelist/blacklist,
// allowedLocalDirectories, etc.) — that already has a real, working parser
// in src/models/types.ts and src/config/*, and re-deriving it in Zod here
// would risk drifting from the actual runtime behavior it enforces. P0-03's
// job is the NEW v2 surface; §3.3 backward compatibility is the existing
// parser's job, unchanged by this file.
//
// Shared rules applied throughout (§5.1):
//   - unknown top-level keys are rejected by default (`.strict()` on every
//     object schema below);
//   - `~` only expands in path fields, and only via expandHomePath, never
//     silently inside arbitrary strings;
//   - duration/byte-size fields reuse primitives.ts.

// ---------------------------------------------------------------------------
// `~` expansion — a path-field-only, single-character prefix expansion.
// Deliberately NOT a general env-var expander (§5.1: "默认不展开任意环境变量").
// ---------------------------------------------------------------------------

/** Pure. Expands a leading `~` (only `~` alone, or `~/`/`~\`) to `homeDir`.
 * Any other use of `~` (mid-path, `~user`, etc.) is left untouched. */
export function expandHomePath(inputPath: string, homeDir: string): string {
  if (inputPath === "~") return homeDir;
  if (inputPath.startsWith("~/") || inputPath.startsWith("~\\")) {
    return homeDir + inputPath.slice(1);
  }
  return inputPath;
}

// ---------------------------------------------------------------------------
// daemon / web / transferDefaults
// ---------------------------------------------------------------------------

export const daemonModeSchema = z.enum(["auto", "embedded", "external"]);

export const daemonConfigSchema = z
  .object({
    instanceName: z.string().min(1).optional().default("default"),
    mode: daemonModeSchema.optional().default("auto"),
    stateDir: z.string().optional(),
  })
  .strict();

export const webConfigSchema = z
  .object({
    enabled: z.boolean().optional().default(false),
    host: z.string().optional().default("127.0.0.1"),
    port: z.number().int().positive().max(65535).optional().default(8765),
    tokenFile: z.string().optional(),
  })
  .strict();

export const transferDefaultsSchema = z
  .object({
    strategy: transferStrategySchema.optional().default("auto"),
    engine: engineSchema.optional().default("auto"),
    fast: z.boolean().optional().default(true),
    striped: stripedSchema.optional().default("auto"),
    checkers: z.number().int().positive().optional().default(8),
    transfers: z.number().int().positive().optional().default(4),
    streams: z.number().int().positive().optional().default(4),
    requestsPerStream: z.number().int().positive().optional().default(64),
    chunkSize: byteSizeSchema.optional().default(32768),
    maxBufferBytes: byteSizeSchema.optional().default(268435456),
  })
  .strict();

// ---------------------------------------------------------------------------
// runProfiles (§5.1, §P2-01)
// ---------------------------------------------------------------------------

export const environmentTypeSchema = z.enum(["venv", "conda", "module", "slurm", "executable"]);

export const environmentConfigSchema = z
  .object({
    type: environmentTypeSchema,
    path: z.string().optional(),
  })
  .strict();

// §P2-01: "首批 provider 为 Controller process environment 和权限受控 secret file".
export const secretEnvProviderSchema = z.enum(["process-env", "secret-file"]);

export const secretEnvRefSchema = z
  .object({
    provider: secretEnvProviderSchema,
    key: z.string().min(1),
    /** Only meaningful for provider "secret-file"; ignored otherwise. */
    path: z.string().optional(),
  })
  .strict();

export const gpuConfigSchema = z
  .object({
    required: z.boolean().optional().default(false),
    visibleDevices: z.union([z.literal("auto"), z.array(z.string())]).optional(),
  })
  .strict();

export const runProfileSchema = z
  .object({
    syncProfile: z.string().optional(),
    server: z.string().optional(),
    remoteRoot: z.string().optional(),
    environment: environmentConfigSchema,
    executable: z.string().optional(),
    allowedEntrypoints: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    secretEnv: z.record(z.string(), secretEnvRefSchema).optional(),
    gpu: gpuConfigSchema.optional(),
    timeout: durationSchema.optional(),
    defaultPush: z.boolean().optional(),
    collect: z.object({ paths: z.array(z.string()).optional() }).strict().optional(),
  })
  .strict()
  .superRefine((profile, ctx) => {
    // §5.1: "若设置 syncProfile，server 和 remoteRoot 必须从该 sync profile 派生且
    // 不得重复配置；没有 syncProfile 时两者才是必填。"
    if (profile.syncProfile !== undefined) {
      if (profile.server !== undefined || profile.remoteRoot !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "when syncProfile is set, server and remoteRoot are derived from it and must not be duplicated here (§5.1)",
        });
      }
    } else if (profile.server === undefined || profile.remoteRoot === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "server and remoteRoot are required when syncProfile is not set (§5.1)",
      });
    }
  });

// ---------------------------------------------------------------------------
// syncProfiles (§5.1, §P3-01) — schema defined now (types must be stable for
// Phase 3 retrofit per Rev.3 §0) even though the sync ENGINE is deferred.
// Parsing/validating this config is not the same as running sync; nothing
// here executes a watcher or scanner.
// ---------------------------------------------------------------------------

export const syncDirectionConfigSchema = z.enum(["push", "pull", "bidirectional"]);

export const conflictPolicySchema = z.enum(["fail", "newer-wins", "local-wins", "remote-wins", "keep-both"]);
// §5.1: "file<->dir 变更始终可单独收紧，不允许 newer-wins" — a narrower enum.
export const typeChangePolicySchema = z.enum(["fail", "local-wins", "remote-wins", "keep-both"]);

export const conflictConfigSchema = z
  .object({
    policy: conflictPolicySchema.optional().default("fail"),
    keepBothSuffix: z.string().optional().default(".conflict-{side}-{timestamp}"),
    typeChange: typeChangePolicySchema.optional().default("fail"),
  })
  .strict();

const deleteLimitsBaseSchema = z.object({
  maxCountPerRun: z.number().int().nonnegative().optional(),
  maxBytesPerRun: byteSizeSchema.optional(),
  maxPercentPerEpoch: z.number().nonnegative().max(100).optional(),
  maxCountPerEpoch: z.number().int().nonnegative().optional(),
  maxBytesPerEpoch: byteSizeSchema.optional(),
});

export const deleteRemoteLimitsSchema = deleteLimitsBaseSchema.strict();

export const deleteLocalLimitsSchema = deleteLimitsBaseSchema
  .extend({
    backupBeforeDelete: z.boolean().optional().default(true),
    backupDir: z.string().optional().default(".handfree-trash"),
  })
  .strict();

export const divergencePolicySchema = z.enum(["conflict-fail", "authoritative-overwrite", "backup-then-overwrite"]);

export const deleteConfigSchema = z
  .object({
    enabled: z.boolean().optional().default(false),
    propagate: z.enum(["none", "push", "pull", "both"]).optional().default("none"),
    requireApproval: z.boolean().optional().default(true),
    approvalTtl: durationSchema.optional(),
    rootIdentity: z.enum(["marker-and-volume"]).optional().default("marker-and-volume"),
    divergence: divergencePolicySchema.optional().default("conflict-fail"),
    backupRetention: durationSchema.optional(),
    remote: deleteRemoteLimitsSchema.optional(),
    local: deleteLocalLimitsSchema.optional(),
  })
  .strict()
  .superRefine((del, ctx) => {
    // §P3-01-A1: direction/propagate incompatibilities (e.g. direction:
    // push cannot propagate:pull) are validated where direction is known —
    // see syncProfileConfigSchema's own superRefine, which has both fields
    // in scope. This schema alone cannot see `direction`.
    if (del.propagate !== "none" && !del.enabled) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["propagate"], message: "delete.propagate requires delete.enabled: true" });
    }
  });

export const syncProfileConfigSchema = z
  .object({
    localRoot: z.string().min(1),
    server: z.string().min(1),
    remoteRoot: z.string().min(1),
    direction: syncDirectionConfigSchema,
    watch: z.boolean().optional().default(true),
    remoteScanInterval: durationSchema.optional(),
    initialSync: z.enum(["archive", "files"]).optional().default("archive"),
    archiveCompression: z.enum(["none", "gzip", "bzip2", "xz", "zstd"]).optional().default("zstd"),
    reconcileInterval: durationSchema.optional(),
    debounceMs: z.number().int().nonnegative().optional().default(500),
    maxBatchDelayMs: z.number().int().nonnegative().optional().default(5000),
    maxPendingEvents: z.number().int().positive().optional().default(4096),
    atomicWrites: z.boolean().optional().default(true),
    conflict: conflictConfigSchema.optional(),
    delete: deleteConfigSchema.optional(),
    ignore: z.array(z.string()).optional(),
  })
  .strict()
  .superRefine((profile, ctx) => {
    // §3.1 / §P3-01-A1: "direction: pull|bidirectional 未配置 remoteScanInterval
    // 时启动即失败".
    if ((profile.direction === "pull" || profile.direction === "bidirectional") && profile.remoteScanInterval === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["remoteScanInterval"],
        message: "remoteScanInterval is required when direction is pull or bidirectional (§P3-01-A1)",
      });
    }
    // direction: push cannot propagate deletes in the pull direction, and
    // vice versa for pull; bidirectional allows both.
    const propagate = profile.delete?.propagate;
    if (propagate && propagate !== "none") {
      const incompatible =
        (profile.direction === "push" && (propagate === "pull" || propagate === "both")) ||
        (profile.direction === "pull" && (propagate === "push" || propagate === "both"));
      if (incompatible) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["delete", "propagate"],
          message: `delete.propagate:${propagate} is incompatible with direction:${profile.direction} (§P3-01-A1)`,
        });
      }
    }
  });

// ---------------------------------------------------------------------------
// directRoutes (§5.1)
// ---------------------------------------------------------------------------

export const credentialModeSchema = z.enum(["existing-remote-key", "agent-forward"]);

export const directRouteConfigSchema = z
  .object({
    sourceServer: z.string().min(1),
    destinationServer: z.string().min(1),
    destinationHost: z.string().min(1),
    destinationPort: z.number().int().positive().max(65535).optional().default(22),
    destinationUser: z.string().min(1),
    // §P1-08: "destination host key 必须 pinned；禁止自动接受 unknown host key" —
    // required, not optional.
    hostKey: z.string().regex(/^SHA256:/, "hostKey must be a pinned SHA256: fingerprint"),
    credentialMode: credentialModeSchema,
    backends: z.array(directBackendSchema).min(1),
  })
  .strict();

// ---------------------------------------------------------------------------
// Top-level v2 config surface + deprecated-key handling
// ---------------------------------------------------------------------------

export const handfreeV2ConfigSchema = z
  .object({
    daemon: daemonConfigSchema.optional(),
    web: webConfigSchema.optional(),
    transferDefaults: transferDefaultsSchema.optional(),
    runProfiles: z.record(z.string(), runProfileSchema).optional(),
    syncProfiles: z.record(z.string(), syncProfileConfigSchema).optional(),
    directRoutes: z.record(z.string(), directRouteConfigSchema).optional(),
  })
  .strict();

export type HandfreeV2Config = z.infer<typeof handfreeV2ConfigSchema>;

/** No keys are deprecated yet — this is the first v2 config surface. The
 * mechanism is real and wired in now so the FIRST future rename has
 * somewhere to register itself without inventing new plumbing. */
export const DEPRECATED_KEYS: readonly string[] = [];

export interface ConfigParseResult {
  config: HandfreeV2Config;
  warnings: string[];
}

/** Pure. §5.1: "unknown key 默认报错；迁移期只有列入 deprecatedKeys 的字段产生一次
 * warning" — deprecated top-level keys are stripped (with a warning) before
 * the strict schema ever sees them, so they don't trigger the unknown-key
 * rejection; anything NOT in DEPRECATED_KEYS still hard-fails via `.strict()`. */
export function parseHandfreeV2Config(raw: unknown): ConfigParseResult {
  const { stripped, warnings } = stripDeprecatedKeys(raw);
  const config = handfreeV2ConfigSchema.parse(stripped);
  return { config, warnings };
}

function stripDeprecatedKeys(raw: unknown): { stripped: unknown; warnings: string[] } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { stripped: raw, warnings: [] };
  }
  const warnings: string[] = [];
  const clone: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
  for (const key of DEPRECATED_KEYS) {
    if (key in clone) {
      warnings.push(`config key "${key}" is deprecated and was ignored`);
      delete clone[key];
    }
  }
  return { stripped: clone, warnings };
}
