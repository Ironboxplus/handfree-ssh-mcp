/**
 * PLAN.MD P2-01: "env 覆盖只允许 profile 声明的 key 或 allowlist". A profile's
 * `env` map doubles as both the default values AND the allowlist of keys a
 * caller-supplied `env` override may touch -- introducing a brand-new key
 * the profile never declared is rejected, not silently accepted.
 */
export type EnvOverrideResult =
  | { ok: true; merged: Record<string, string> }
  | { ok: false; rejectedKeys: string[] };

/** Pure. `profileEnv` is both the base values and the allowlist; any key in
 * `callerEnv` that is not already a key of `profileEnv` is rejected. */
export function applyEnvOverride(
  profileEnv: Readonly<Record<string, string>> | undefined,
  callerEnv: Readonly<Record<string, string>> | undefined,
): EnvOverrideResult {
  const base = profileEnv ?? {};
  const overrides = callerEnv ?? {};
  const rejectedKeys = Object.keys(overrides).filter((key) => !(key in base));
  if (rejectedKeys.length > 0) {
    return { ok: false, rejectedKeys };
  }
  return { ok: true, merged: { ...base, ...overrides } };
}
