import crypto from "crypto";

/**
 * PLAN.MD P2-03: run ids are the path component of every remote state
 * directory (`~/.handfree-runs/<runId>/`), so an id must be safe to splice
 * into a POSIX path segment with zero risk of traversal (`..`, `/`) or shell
 * metacharacters, even though every caller also goes through
 * posixShellQuote() as defense in depth. Restricting the *generated*
 * charset is not enough on its own -- run-status/run-logs/run-cancel accept
 * a caller-supplied runId back, so isValidRunId() is the real boundary.
 */
const RUN_ID_RE = /^run_[0-9]{8}T[0-9]{6}Z_[0-9a-f]{8}$/;

/** Pure given `now` and `random`; both default to real sources at call time. */
export function generateRunId(now: Date = new Date(), random: () => Buffer = () => crypto.randomBytes(4)): string {
  const ts = now.toISOString().replace(/[-:.]/g, "").replace(/(\d{8}T\d{6})\d*Z$/, "$1Z");
  return `run_${ts}_${random().toString("hex")}`;
}

/** Pure. The only gate that matters for defense-in-depth: no `/`, no `..`,
 * no leading `.`, no shell metacharacters -- just the exact shape this
 * package itself generates. Reject anything else, including a
 * syntactically-plausible but foreign runId. */
export function isValidRunId(candidate: string): boolean {
  return RUN_ID_RE.test(candidate);
}
