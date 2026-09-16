import crypto from "crypto";

/**
 * PLAN.MD P2-02: "push 完成后对 entrypoint 做 stat + hash，连同已推送文件清单摘要
 * 记为该 run 的 revision". Pure bookkeeping only -- the actual stat/hash of the
 * remote entrypoint and the actual list of pushed files are gathered by
 * run-service.ts via remote-sftp.ts / TransferService; this module just
 * turns "a list of remote paths that got pushed" into one deterministic
 * digest, independent of upload/traversal order.
 */
export function computePushedFilesDigest(remotePaths: readonly string[]): string {
  const sorted = [...remotePaths].sort();
  return crypto.createHash("sha256").update(sorted.join("\n")).digest("hex");
}
