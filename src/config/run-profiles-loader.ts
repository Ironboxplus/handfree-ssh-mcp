import { z } from "zod";
import { runProfileSchema } from "../contracts/config-schema.js";

/**
 * PLAN.MD P2-01: "解析 runProfiles". Reuses the already-built, already-tested
 * Zod schema in src/contracts/config-schema.ts (§5.1/§P2-01) instead of
 * hand-rolling a second parser for the same YAML shape -- src/contracts/ is
 * frozen for this delivery round (no new schema surface added there), but
 * importing what already exists is exactly the kind of reuse the plan asks
 * for, not "building" it.
 *
 * This dispatch's runner only implements the `venv` and `executable`
 * environment types (see src/run/run-service.ts); `conda`/`module`/`slurm`
 * and `gpu.required`/`secretEnv` parse successfully here (so a profile using
 * them doesn't fail config load) but are rejected with a clear
 * *_NOT_AVAILABLE error at launch time -- never silently ignored.
 *
 * PLAN.MD P2-02/P2-06 (this round): the push and collect phases need two
 * config fields (a local push source list, and a collect local destination
 * + byte/file caps) that do not exist on the frozen `runProfileSchema`
 * object above -- it is `.strict()` and already wrapped in a
 * `.superRefine()` (so it cannot be `.extend()`-ed or safely intersected:
 * either would still run the original strict shape check against the extra
 * key first and reject it as unrecognized). Rather than touching
 * src/contracts/config-schema.ts (out of scope this round), `parseRunProfiles`
 * below strips `push`/`collect` off each raw entry, validates the REST
 * through the untouched, frozen `runProfileSchema`, and separately validates
 * `push`/`collect` through the two small schemas declared here, then merges
 * the result. `collect.paths` continues to mean exactly what the frozen
 * schema already declared (a glob list); `localDir`/`maxBytes`/`maxFiles`
 * are new, additive fields the frozen schema never validated one way or the
 * other.
 */
export const runProfilePushConfigSchema = z
  .object({
    /**
     * Local filesystem paths (files or directories) pushed to `remoteRoot`
     * before launch. A directory is uploaded recursively (TransferService's
     * `uploadDirectory`); a file is batched with any other file entries into
     * one `uploadBatch` call. Each lands at `remoteRoot/<basename>`.
     */
    paths: z.array(z.string().min(1)).min(1),
  })
  .strict();
export type RunProfilePushConfig = z.infer<typeof runProfilePushConfigSchema>;

export const runProfileCollectConfigSchema = z
  .object({
    /** Glob patterns, relative to remoteRoot. Absent/empty -> collect is skipped. */
    paths: z.array(z.string().min(1)).optional(),
    /** Local destination directory collected files are written under. Required
     * when `paths` is non-empty (checked at collect time, not here, so a
     * profile can declare `collect: { paths: [] }` without also needing a
     * localDir it will never use). */
    localDir: z.string().min(1).optional(),
    maxBytes: z.number().int().positive().optional(),
    maxFiles: z.number().int().positive().optional(),
  })
  .strict();
export type RunProfileCollectConfig = z.infer<typeof runProfileCollectConfigSchema>;

const baseRunProfilesYamlSchema = z.record(z.string(), runProfileSchema);
export type RunProfilesConfig = Record<string, RunProfileEntry>;
export type RunProfileEntry = z.infer<typeof runProfileSchema> & {
  push?: RunProfilePushConfig;
  collect?: RunProfileCollectConfig;
};

/** Pure. `undefined` (no `runProfiles:` key at all -- the overwhelming
 * majority of existing 1.x configs) returns an empty map without invoking
 * the schema at all, so an absent key can never fail config load. Any
 * other value is validated strictly. */
export function parseRunProfiles(raw: unknown): RunProfilesConfig {
  if (raw === undefined) return {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    // Let the frozen schema produce its own real Zod error for a
    // structurally-wrong `runProfiles:` value instead of a confusing one
    // from the per-entry loop below.
    baseRunProfilesYamlSchema.parse(raw);
    return {};
  }

  const result: RunProfilesConfig = {};
  for (const [name, rawEntry] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof rawEntry !== "object" || rawEntry === null || Array.isArray(rawEntry)) {
      // Let the frozen per-entry schema raise the real error for a
      // structurally-wrong entry.
      result[name] = runProfileSchema.parse(rawEntry) as RunProfileEntry;
      continue;
    }
    const { push: rawPush, collect: rawCollect, ...rest } = rawEntry as Record<string, unknown>;
    const parsed = runProfileSchema.parse(rest) as RunProfileEntry;
    if (rawPush !== undefined) {
      parsed.push = runProfilePushConfigSchema.parse(rawPush);
    }
    if (rawCollect !== undefined) {
      parsed.collect = runProfileCollectConfigSchema.parse(rawCollect);
    }
    result[name] = parsed;
  }
  return result;
}
