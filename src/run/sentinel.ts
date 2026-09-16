/**
 * Shared line-scan helper for the sentinel-prefixed lines every remote
 * script in src/run/ prints (HANDFREE_LAUNCHED:, HANDFREE_LAUNCH_ERROR:,
 * HANDFREE_PROBE:, HANDFREE_CANCEL:). SSHConnectionManager.executeCommand's
 * returned text may interleave stdout/stderr under `[STDERR]`/`[EXIT CODE]`
 * markers depending on the remote exit code, so callers scan the whole
 * blob for a known-prefixed line rather than assuming stdout is the only
 * content or the last line.
 */
export function findSentinelLine(output: string, prefix: string): string | null {
  for (const rawLine of output.split(/\r?\n/)) {
    if (rawLine.startsWith(prefix)) {
      return rawLine.slice(prefix.length);
    }
  }
  return null;
}
