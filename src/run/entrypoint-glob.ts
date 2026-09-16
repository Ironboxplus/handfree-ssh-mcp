/**
 * PLAN.MD P2-01: "allowedEntrypoints glob 相对规范化 remoteRoot 的...路径身份校验,
 * 只匹配 regular file；最终 executable/entrypoint 在启动瞬间再次验证".
 *
 * This module only covers the pure, relative-path glob matching + traversal
 * rejection (the part P1-02's full path-identity/case-sensitivity work would
 * otherwise own, per PLAN.MD -- P1-02 is not delivered yet, so this is a
 * deliberately narrow stand-in: no case-folding, no symlink resolution, just
 * "does this relative POSIX path match one of the declared glob patterns,
 * and is it even a legal relative path in the first place". The "only
 * matches a regular file" and "verified again at launch time" halves of the
 * P2-01 bullet are enforced by the caller doing a real remote stat, not by
 * this pure module.
 */

/** Pure. A relative-path candidate is rejected outright (before any glob
 * matching) if it is absolute, empty, or contains a `..` segment anywhere --
 * these would escape `remoteRoot` regardless of what the glob allows. */
export function isSafeRelativeEntrypoint(candidate: string): boolean {
  if (candidate.length === 0) return false;
  if (candidate.startsWith("/") || candidate.startsWith("~")) return false;
  if (/^[A-Za-z]:[\\/]/.test(candidate)) return false; // Windows drive-letter absolute
  const segments = candidate.split("/");
  return segments.every((segment) => segment !== ".." && segment.length > 0);
}

/**
 * Pure. Converts one glob pattern into a RegExp that matches a full
 * relative POSIX path. Supported wildcards:
 *   `*`   matches any run of characters EXCEPT `/` (single path segment)
 *   `**`  matches any run of characters INCLUDING `/` (any depth)
 *   `?`   matches exactly one character except `/`
 * Everything else is matched literally.
 */
export function compileEntrypointGlob(pattern: string): RegExp {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "*" && pattern[i + 1] === "*") {
      out += ".*";
      i++;
      // Swallow an immediately following '/' so "**/foo" also matches "foo"
      // at depth zero, matching the common glob convention.
      if (pattern[i + 1] === "/") i++;
      continue;
    }
    if (ch === "*") {
      out += "[^/]*";
      continue;
    }
    if (ch === "?") {
      out += "[^/]";
      continue;
    }
    out += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

/** Pure. `candidate` must be a safe relative path (see
 * isSafeRelativeEntrypoint) AND match at least one of `patterns`. */
export function matchesAllowedEntrypoint(candidate: string, patterns: readonly string[]): boolean {
  if (!isSafeRelativeEntrypoint(candidate)) return false;
  return patterns.some((pattern) => compileEntrypointGlob(pattern).test(candidate));
}
