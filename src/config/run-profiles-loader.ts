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
 */
export const runProfilesYamlSchema = z.record(z.string(), runProfileSchema);
export type RunProfilesConfig = z.infer<typeof runProfilesYamlSchema>;
export type RunProfileEntry = z.infer<typeof runProfileSchema>;

/** Pure. `undefined` (no `runProfiles:` key at all -- the overwhelming
 * majority of existing 1.x configs) returns an empty map without invoking
 * the schema at all, so an absent key can never fail config load. Any
 * other value is validated strictly. */
export function parseRunProfiles(raw: unknown): RunProfilesConfig {
  if (raw === undefined) return {};
  return runProfilesYamlSchema.parse(raw);
}
