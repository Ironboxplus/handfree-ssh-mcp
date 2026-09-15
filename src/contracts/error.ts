import { z } from "zod";

// PLAN.MD §5.2: unified error object for every NEW/background tool, IPC and
// HTTP response. This is deliberately a *different shape* from the existing
// 1.x tool-error format in src/utils/tool-error.ts — see legacyErrorSchema
// below and the note on the field name difference.

/** Stable machine-readable error codes referenced anywhere in this plan
 * revision. This is not exhaustive of every future code (job/sync/run
 * services will add more as they're built), but every code currently named
 * in PLAN.MD's Phase 0-2 scope is enumerated so contract tests can assert
 * against a real, closed set rather than "any string". */
export const KNOWN_ERROR_CODES = [
  // §5.5 job state machine
  "INVALID_STATE_TRANSITION",
  // §5.7 batch upload
  "BATCH_TARGET_COLLISION",
  "BATCH_TOO_LARGE",
  "INVALID_CONFIGURATION",
  // §5.2 workspace-run sync placeholder / §P0-03 deferred Phase 3 tools
  "SYNC_NOT_AVAILABLE",
  "SYNC_PROFILE_NOT_AVAILABLE",
  // §5.3 sync plan staleness / SSE catch-up
  "STALE_SYNC_PLAN",
  "EVENT_CURSOR_EXPIRED",
  // §5.4 transfer combination rules
  "TRANSFER_STRATEGY_NOT_APPLICABLE",
  "TRANSFER_STRIPED_NOT_APPLICABLE",
  "DIRECT_CAPABILITY_UNAVAILABLE",
  // §P2-04 retry
  "SECRET_REQUIRED",
  // generic
  "UNKNOWN_ERROR",
] as const;

export type KnownErrorCode = (typeof KNOWN_ERROR_CODES)[number];

const MACHINE_CODE_RE = /^[A-Z][A-Z0-9_]*$/;

export const errorCodeSchema = z.string().regex(MACHINE_CODE_RE, "error code must be SCREAMING_SNAKE_CASE");

export const cleanupReportSchema = z.object({
  attempted: z.boolean(),
  completed: z.boolean(),
  residue: z.array(z.string()),
});

/** §5.2 unified error object. `details` must never carry secrets, private
 * keys, or unbounded remote output — this schema bounds its serialized size
 * but the caller remains responsible for redaction (the same
 * assertNoSecretLikeKeys guard used by src/contracts/identity.ts is
 * available for that). */
export const errorObjectSchema = z.object({
  code: errorCodeSchema,
  message: z.string().min(1).max(4096),
  retryable: z.boolean(),
  details: z.record(z.string(), z.unknown()).optional().default({}),
  cleanup: cleanupReportSchema.optional(),
});

export type ErrorObject = z.infer<typeof errorObjectSchema>;

export function makeErrorObject(
  code: KnownErrorCode | (string & {}),
  message: string,
  options: { retryable?: boolean; details?: Record<string, unknown>; cleanup?: z.infer<typeof cleanupReportSchema> } = {},
): ErrorObject {
  return errorObjectSchema.parse({
    code,
    message,
    retryable: options.retryable ?? false,
    details: options.details ?? {},
    cleanup: options.cleanup,
  });
}

// ---------------------------------------------------------------------------
// Legacy (1.x) error shape — characterization contract, see
// src/utils/tool-error.ts's formatToolErrorResponse. Frozen here so P0-04's
// refactor cannot silently change it.
//
// IMPORTANT, real discrepancy found while writing this contract: the legacy
// shape's boolean field is named "retriable" (sic); the new §5.2 error
// object's field is named "retryable". These are NOT the same field and
// must never be conflated during P0-04's extraction — a naive rename would
// silently break every existing caller parsing the legacy JSON text.
// ---------------------------------------------------------------------------

export const legacyErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  retriable: z.boolean(),
});

export type LegacyError = z.infer<typeof legacyErrorSchema>;
