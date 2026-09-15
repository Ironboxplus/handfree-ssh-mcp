import { z } from "zod";
import { createHash } from "node:crypto";

// PLAN.MD P0-03 / §5.1: shared primitive parsers used by every contract in
// this directory. Pure functions only — no I/O, no SSH, no filesystem — so
// they are exhaustively value-tested per §7.2.1's white-box allowance for
// pure functions.

// ---------------------------------------------------------------------------
// Duration: "positive integer milliseconds, or a string like ms/s/m/h/d"
// ---------------------------------------------------------------------------

const DURATION_UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

const DURATION_STRING_RE = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/;

/** Parses a duration per §5.1 ("正整数毫秒或字符串 ms/s/m/h/d"). Throws on
 * anything else, including negative/zero/non-finite/overflow values. Pure. */
export function parseDuration(input: number | string): number {
  if (typeof input === "number") {
    if (!Number.isInteger(input) || input <= 0 || !Number.isSafeInteger(input)) {
      throw new Error(`duration must be a positive safe integer number of milliseconds, got ${input}`);
    }
    return input;
  }
  const match = DURATION_STRING_RE.exec(input);
  if (!match) {
    throw new Error(`duration string must match /${DURATION_STRING_RE.source}/, got ${JSON.stringify(input)}`);
  }
  const [, quantityStr, unit] = match;
  const quantity = Number(quantityStr);
  const ms = quantity * DURATION_UNIT_MS[unit];
  if (!Number.isFinite(ms) || ms <= 0 || !Number.isSafeInteger(ms)) {
    throw new Error(`duration ${JSON.stringify(input)} resolves to an out-of-range value: ${ms}`);
  }
  return ms;
}

export const durationSchema = z
  .union([z.number(), z.string()])
  .transform((value, ctx) => {
    try {
      return parseDuration(value);
    } catch (error) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: (error as Error).message });
      return z.NEVER;
    }
  });

// ---------------------------------------------------------------------------
// Byte size: "positive integer or IEC string KiB/MiB/GiB, case-sensitive"
// ---------------------------------------------------------------------------

const BYTE_UNIT_MULTIPLIER: Record<string, number> = {
  KiB: 1024,
  MiB: 1024 ** 2,
  GiB: 1024 ** 3,
};

const BYTE_STRING_RE = /^(\d+(?:\.\d+)?)(KiB|MiB|GiB)$/;

/** Parses a byte size per §5.1 ("正整数或 IEC 字符串 KiB/MiB/GiB，大小写敏感，
 * 溢出安全整数即失败"). Pure. */
export function parseByteSize(input: number | string): number {
  if (typeof input === "number") {
    if (!Number.isInteger(input) || input <= 0 || !Number.isSafeInteger(input)) {
      throw new Error(`byte size must be a positive safe integer, got ${input}`);
    }
    return input;
  }
  const match = BYTE_STRING_RE.exec(input);
  if (!match) {
    throw new Error(`byte size string must match /${BYTE_STRING_RE.source}/ (case-sensitive IEC units), got ${JSON.stringify(input)}`);
  }
  const [, quantityStr, unit] = match;
  const quantity = Number(quantityStr);
  const bytes = quantity * BYTE_UNIT_MULTIPLIER[unit];
  if (!Number.isFinite(bytes) || bytes <= 0 || !Number.isSafeInteger(bytes)) {
    throw new Error(`byte size ${JSON.stringify(input)} resolves to an out-of-range value: ${bytes}`);
  }
  return bytes;
}

export const byteSizeSchema = z
  .union([z.number(), z.string()])
  .transform((value, ctx) => {
    try {
      return parseByteSize(value);
    } catch (error) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: (error as Error).message });
      return z.NEVER;
    }
  });

// ---------------------------------------------------------------------------
// Canonical JSON + hashing — shared by identity.ts (§4.2) for
// instanceId/configRevision/policyFingerprint, all of which must be stable
// regardless of object key insertion order.
// ---------------------------------------------------------------------------

/** Deterministically stringifies a JSON-compatible value: object keys are
 * sorted recursively, arrays keep their order. Pure; throws on
 * non-JSON-safe input (functions, symbols, circular refs surface as a
 * thrown TypeError from the recursive walk). */
export function canonicalJsonStringify(value: unknown): string {
  return stringifyCanonical(value);
}

function stringifyCanonical(value: unknown): string {
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stringifyCanonical(entry)).join(",")}]`;
  }
  if (typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    const parts = keys.map(
      (key) => `${JSON.stringify(key)}:${stringifyCanonical((value as Record<string, unknown>)[key])}`,
    );
    return `{${parts.join(",")}}`;
  }
  throw new TypeError(`canonicalJsonStringify: unsupported value type ${typeof value}`);
}

/** Pure SHA-256 hex digest of a UTF-8 string. */
export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}
