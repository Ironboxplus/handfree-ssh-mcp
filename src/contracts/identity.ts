import { canonicalJsonStringify, sha256Hex } from "./primitives.js";

// PLAN.MD §4.2: three identity concepts that must stay strictly separate.
//
//   instanceId       stable daemon/state namespace. SHA-256 of
//                     (instanceName + canonical config source paths +
//                     enabledServers + stateDir identity). Never contains
//                     config content, policy, or secrets.
//   configRevision    revision of the current (non-secret) config content;
//                     changes every time config content changes.
//   policyFingerprint digest of the currently active permission policy
//                     (command whitelist/blacklist, allowed directories).
//
// This module intentionally exports these as three distinct functions
// (rather than one generic "hash an object" helper used three ways) so a
// caller cannot accidentally feed a config-revision input into the
// instance-id slot or vice versa — the input *shapes* are different and
// each function's doc comment states exactly what must never be inside it.
//
// Historical note: scripts/preflight.mjs's `configFingerprint` predates this
// module and is NOT the same thing as policyFingerprint/instanceId/
// configRevision above — it is only a hash of that script's own CLI inputs
// (package version, node/platform/arch, --require set), used solely to
// compare two preflight artifacts. See the comment at its call site.

const SECRET_LIKE_KEY_RE = /secret|password|passphrase|privatekey|private_key|apikey|api_key|token|credential/i;

/** Throws if any object key (recursively) looks like it holds a secret.
 * This is a defensive contract-layer guard for the §4.2 requirement that
 * "secret 原值及普通 digest 都不得进入 instanceId、公开路径或日志" — it does not
 * replace the caller's own responsibility to pass already-redacted input,
 * but it turns an accidental leak into a real, loud failure instead of a
 * silent hash of a secret. Pure. */
export function assertNoSecretLikeKeys(value: unknown, path = "$"): void {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoSecretLikeKeys(entry, `${path}[${index}]`));
    return;
  }
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_LIKE_KEY_RE.test(key)) {
      throw new Error(`refusing to hash a value containing a secret-like key "${key}" at ${path}.${key}`);
    }
    assertNoSecretLikeKeys(nested, `${path}.${key}`);
  }
}

export interface InstanceIdentityInput {
  instanceName: string;
  /** Canonical (resolved, absolute) config source paths — order-independent. */
  configSourcePaths: string[];
  /** Enabled server names — order-independent. */
  enabledServers: string[];
  /** Platform-specific state directory identity (e.g. the resolved absolute
   * state directory path). */
  stateDirIdentity: string;
}

/** §4.2 instanceId: SHA-256 hex digest, 64 hex chars (256 bit). Contains no
 * config content, policy, or secret — only naming/identity inputs. Pure. */
export function computeInstanceId(input: InstanceIdentityInput): string {
  const canonical = canonicalJsonStringify({
    instanceName: input.instanceName,
    configSourcePaths: [...input.configSourcePaths].sort(),
    enabledServers: [...input.enabledServers].sort(),
    stateDirIdentity: input.stateDirIdentity,
  });
  return sha256Hex(canonical);
}

/** §4.2: "文件路径和 pipe/socket 使用至少前 32 个十六进制字符（128 bit），hello 再
 * 校验完整 256 bit". Pure; throws if asked for more hex chars than a SHA-256
 * digest has (64) or fewer than the mandated 128-bit floor. */
export function shortInstanceId(instanceId: string, hexChars = 32): string {
  if (!/^[0-9a-f]{64}$/.test(instanceId)) {
    throw new Error(`instanceId must be a 64-hex-char SHA-256 digest, got ${JSON.stringify(instanceId)}`);
  }
  if (hexChars < 32 || hexChars > 64) {
    throw new Error(`shortInstanceId requires 32-64 hex chars (128-256 bit) per §4.2, got ${hexChars}`);
  }
  return instanceId.slice(0, hexChars);
}

/** §4.2 configRevision: hash of the current, already-redacted (non-secret)
 * config content. Callers must strip secret values before calling this —
 * assertNoSecretLikeKeys is a backstop, not a substitute for that. Pure. */
export function computeConfigRevision(nonSecretConfigContent: unknown): string {
  assertNoSecretLikeKeys(nonSecretConfigContent);
  return sha256Hex(canonicalJsonStringify(nonSecretConfigContent));
}

/** §4.2 policyFingerprint: hash of the currently active permission policy
 * (command whitelist/blacklist, allowed local/remote directories, etc). Pure. */
export function computePolicyFingerprint(policy: unknown): string {
  assertNoSecretLikeKeys(policy);
  return sha256Hex(canonicalJsonStringify(policy));
}
