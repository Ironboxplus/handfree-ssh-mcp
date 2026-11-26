import path from "path";

/**
 * Remote SFTP path syntax for Linux, macOS and Windows servers.
 *
 * Linux and macOS servers take POSIX paths. Win32-OpenSSH accepts a drive
 * path as `C:\x`, `C:/x`, `/C:\x` or `/C:/x` and its realpath reports all of
 * them as `/C:/x` (measured against OpenSSH_for_Windows_9.5, 2026-11-26), so
 * that is the one normalized form here. Backslashes are converted only in a
 * drive path: on a POSIX server a backslash is an ordinary filename character.
 *
 * `~` and relative paths are rejected: SFTP servers do not expand `~` (a
 * literal `~` directory is looked up instead, measured on both OpenSSH for
 * Windows 9.5 and OpenSSH 10.3), and a relative path cannot be checked against
 * an allowlist without a round trip to the server.
 */

const DRIVE_PATH = /^\/?([A-Za-z]):(?:[\\/]|$)/;

/** True for a normalized Windows drive path (`/C:/...`). */
export function isWindowsRemotePath(remotePath: string): boolean {
  return /^\/[A-Za-z]:\//.test(remotePath);
}

export type RemotePathResult =
  | { ok: true; path: string }
  | { ok: false; reason: string };

/**
 * Normalize an absolute remote path, or explain why it is not one. `..`
 * segments are rejected before normalization so `/allowed/../etc` cannot
 * collapse into a path outside an allowlist.
 */
export function normalizeRemotePath(raw: string): RemotePathResult {
  if (typeof raw !== "string" || raw.length === 0) {
    return { ok: false, reason: "Remote path must be a non-empty string." };
  }
  if (raw.includes("\0")) {
    return { ok: false, reason: "Remote path must not contain null bytes." };
  }
  const drive = DRIVE_PATH.exec(raw);
  let candidate: string;
  if (drive) {
    const rest = raw.slice(drive[0].length).replace(/\\/g, "/");
    candidate = `/${drive[1].toUpperCase()}:/${rest}`;
  } else if (raw.startsWith("/")) {
    candidate = raw;
  } else {
    return {
      ok: false,
      reason:
        `Remote path must be absolute: /home/me/file on Linux or macOS, C:\\Users\\me\\file or C:/Users/me/file on Windows. ` +
        `SFTP servers do not expand ~ or resolve relative paths for the policy check. Got: ${raw}`,
    };
  }
  if (candidate.split("/").includes("..")) {
    return { ok: false, reason: `Remote path must not contain '..' segments: ${raw}` };
  }
  return { ok: true, path: path.posix.normalize(candidate) };
}

/**
 * Whether `remotePath` is `root` or inside it. Both must be normalized.
 * Windows paths compare case-insensitively, as the server resolves them.
 */
export function remotePathWithin(remotePath: string, root: string): boolean {
  const windows = isWindowsRemotePath(remotePath) || isWindowsRemotePath(root);
  const p = windows ? remotePath.toLowerCase() : remotePath;
  const r = windows ? root.toLowerCase() : root;
  return p === r || p.startsWith(r.endsWith("/") ? r : `${r}/`);
}
