import { isSafeRelativeEntrypoint, matchesAllowedEntrypoint } from "./entrypoint-glob.js";
import { listRemoteDirectory, statRemoteFile, type RemoteDirEntry } from "./remote-sftp.js";

/**
 * PLAN.MD P2-06 / §5.8: "glob 解析相对 remoteRoot...拒绝逃逸" and "Reuse
 * src/run/entrypoint-glob.ts's traversal rejection rather than writing a
 * second one" (dispatch note). `isSafeRelativeEntrypoint`/
 * `matchesAllowedEntrypoint` already reject `..`, absolute paths, and
 * Windows drive-letter paths for a single candidate string -- reused as-is
 * here, unmodified. What collect adds on top is the walk itself (glob
 * matching needs a set of real candidate paths to test, which entrypoint
 * validation never needed since it only ever checks one caller-supplied
 * path) and the symlink rule below, which is collect-specific: an
 * entrypoint is executed (its target matters), a collect artifact is merely
 * copied, so simply never walking through a symlink is sufficient and
 * strictly safer than trying to resolve+contain its target.
 */

export interface CollectCandidate {
  /** Path relative to remoteRoot, POSIX-separated. */
  relativePath: string;
  isSymlink: boolean;
}

/**
 * Pure. A candidate is eligible to be collected iff its relative path is
 * itself a safe (non-escaping) relative path AND it is not a symlink.
 * Never given `..`/absolute candidates in practice (the walker below only
 * ever constructs relativePath by joining real traversed segments), but
 * kept as an explicit, independently-testable precondition rather than
 * trusted-by-construction -- exactly the shape P2-06-A3 exhaustively value-
 * tests (`..`, absolute paths, symlinks).
 */
export function isCollectCandidateSafe(candidate: CollectCandidate): boolean {
  if (candidate.isSymlink) return false;
  return isSafeRelativeEntrypoint(candidate.relativePath);
}

/**
 * Pure. Does `candidate` match at least one of the declared collect globs?
 * Thin wrapper over matchesAllowedEntrypoint so collect and entrypoint
 * validation share one glob dialect (`*`, `**`, `?`) instead of drifting
 * into two.
 */
export function matchesCollectGlob(relativePath: string, patterns: readonly string[]): boolean {
  return matchesAllowedEntrypoint(relativePath, patterns);
}

export interface CollectMatch {
  relativePath: string;
  absolutePath: string;
  bytes: number;
}

const MAX_COLLECT_WALK_ENTRIES = 200_000;

/**
 * Real remote walk (SFTP readdir, breadth-first) under `remoteRootAbsolute`,
 * returning every regular file (never a directory, never a symlink -- see
 * isCollectCandidateSafe) whose remoteRoot-relative path matches at least
 * one of `patterns`, each stat'd for its byte size. Sorted by relativePath
 * for a deterministic result independent of directory-listing order.
 *
 * `patterns` empty means "collect nothing" at the caller layer (§5.8: never
 * default to the whole tree) -- enforced by the caller not even invoking
 * this walk in that case, not by this function silently no-op'ing, so an
 * empty-patterns call here is a caller bug, not a supported no-op.
 */
export async function findRemoteCollectFiles(
  serverName: string | undefined,
  remoteRootAbsolute: string,
  patterns: readonly string[],
): Promise<CollectMatch[]> {
  if (patterns.length === 0) {
    throw new Error("findRemoteCollectFiles: patterns must not be empty (caller must skip collect instead)");
  }

  const matches: CollectMatch[] = [];
  let visitedEntries = 0;
  const queue: string[] = [""]; // relative dir paths, "" = remoteRootAbsolute itself

  while (queue.length > 0) {
    const relativeDir = queue.shift()!;
    const absoluteDir = relativeDir.length > 0 ? `${remoteRootAbsolute}/${relativeDir}` : remoteRootAbsolute;
    const entries: RemoteDirEntry[] = await listRemoteDirectory(serverName, absoluteDir);

    for (const entry of entries) {
      visitedEntries += 1;
      if (visitedEntries > MAX_COLLECT_WALK_ENTRIES) {
        throw new Error(`findRemoteCollectFiles: remoteRoot tree has more than ${MAX_COLLECT_WALK_ENTRIES} entries; declare a narrower collect.paths`);
      }
      const relativePath = relativeDir.length > 0 ? `${relativeDir}/${entry.filename}` : entry.filename;
      if (!isCollectCandidateSafe({ relativePath, isSymlink: entry.isSymlink })) {
        continue;
      }
      if (entry.isDirectory) {
        queue.push(relativePath);
        continue;
      }
      if (!matchesCollectGlob(relativePath, patterns)) {
        continue;
      }
      const absolutePath = `${remoteRootAbsolute}/${relativePath}`;
      const stat = await statRemoteFile(serverName, absolutePath);
      if (stat === null || !stat.isFile) {
        continue; // vanished or changed type between readdir and stat
      }
      matches.push({ relativePath, absolutePath, bytes: stat.size });
    }
  }

  matches.sort((a, b) => (a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0));
  return matches;
}

export interface CollectCapExceeded {
  reason: string;
  atRelativePath: string;
}

export interface CollectCapSelection {
  accepted: CollectMatch[];
  totalBytes: number;
  exceeded: CollectCapExceeded | null;
}

/**
 * Pure. PLAN.MD P2-06/§5.8: "总字节上限与文件数上限；超限则collect phase失败并
 * 报告已拉取清单，不静默截断". Walks `matches` in order, accumulating into
 * `accepted` until adding the next one would exceed `maxFiles` or
 * `maxBytes` -- at that point it stops (does NOT skip the offending file and
 * keep going, which would be a silent partial truncation) and reports which
 * file tripped the cap. `accepted` is exactly the set the caller should
 * download; a caller that downloads them in the same order and then sees
 * `exceeded !== null` has an accurate "already pulled" list by construction.
 */
export function selectWithinCollectCaps(
  matches: readonly CollectMatch[],
  maxBytes: number,
  maxFiles: number,
): CollectCapSelection {
  const accepted: CollectMatch[] = [];
  let totalBytes = 0;
  for (const match of matches) {
    const nextCount = accepted.length + 1;
    const nextBytes = totalBytes + match.bytes;
    if (nextCount > maxFiles) {
      return { accepted, totalBytes, exceeded: { reason: `file count exceeds maxFiles=${maxFiles}`, atRelativePath: match.relativePath } };
    }
    if (nextBytes > maxBytes) {
      return { accepted, totalBytes, exceeded: { reason: `total bytes exceeds maxBytes=${maxBytes}`, atRelativePath: match.relativePath } };
    }
    accepted.push(match);
    totalBytes = nextBytes;
  }
  return { accepted, totalBytes, exceeded: null };
}
