import fs from "fs";
import path from "path";
import { Logger } from "./logger.js";

/**
 * OutputLogWriter
 *
 * Persists the FULL stdout/stderr of an `execute-command` invocation to a
 * single plain-text log file under:
 *
 *   <root>/<server-name>/<username>/<timestamp>-<pid>-<rand>.log
 *
 * The file uses simple section markers so a human (or grep) can find each
 * stream:
 *
 *   === META ===
 *   server: <server>
 *   user: <user>
 *   command: <command>
 *   started: <iso>
 *   === STDOUT ===
 *   ...full stdout bytes...
 *   === STDERR ===
 *   ...full stderr bytes...
 *   === END ===
 *   exitCode: <n>
 *   durationMs: <n>
 *   stdoutBytes: <n>
 *   stderrBytes: <n>
 *   finished: <iso>
 *
 * Failures to write are logged and swallowed; they never abort the SSH
 * command. `getPath()` always returns the intended file path even if a
 * write fails (callers can still report it to the LLM).
 *
 * Implementation note: stdout and stderr are buffered in memory until
 * `close()` so the markers stay contiguous in the file. For very large
 * outputs this still costs O(total bytes) RAM, but it keeps the log
 * readable and avoids interleaving issues with streaming.
 */
export interface OutputLogWriterOptions {
  rootDir: string;
  serverName: string;
  username: string;
  command: string;
  startedAt?: Date;
}

export class OutputLogWriter {
  private readonly filePath: string;
  private readonly serverName: string;
  private readonly username: string;
  private readonly command: string;
  private readonly startedAt: Date;
  private readonly stdoutChunks: Buffer[] = [];
  private readonly stderrChunks: Buffer[] = [];
  private stdoutBytes = 0;
  private stderrBytes = 0;
  private closed = false;
  private writeFailed = false;

  constructor(opts: OutputLogWriterOptions) {
    this.serverName = sanitizeSegment(opts.serverName) || "unknown";
    this.username = sanitizeSegment(opts.username) || "unknown";
    this.command = opts.command;
    this.startedAt = opts.startedAt ?? new Date();

    const dir = path.join(opts.rootDir, this.serverName, this.username);
    const fileName = makeLogFileName(this.startedAt);
    this.filePath = path.join(dir, fileName);
  }

  /**
   * The absolute path the log will (or did) live at.
   */
  public getPath(): string {
    return this.filePath;
  }

  public appendStdout(chunk: Buffer | string): void {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
    if (buf.length === 0) return;
    this.stdoutChunks.push(buf);
    this.stdoutBytes += buf.length;
  }

  public appendStderr(chunk: Buffer | string): void {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
    if (buf.length === 0) return;
    this.stderrChunks.push(buf);
    this.stderrBytes += buf.length;
  }

  /**
   * Flush everything to disk and finalize the META footer.
   * Safe to call multiple times; only the first call writes.
   */
  public close(meta: { exitCode: number | null; durationMs: number; finishedAt?: Date }): void {
    if (this.closed) return;
    this.closed = true;

    const finishedAt = meta.finishedAt ?? new Date();

    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });

      const header = Buffer.from(
        `=== META ===\n` +
        `server: ${this.serverName}\n` +
        `user: ${this.username}\n` +
        `command: ${this.command}\n` +
        `started: ${this.startedAt.toISOString()}\n` +
        `=== STDOUT ===\n`,
        "utf8"
      );
      const stderrMarker = Buffer.from(`\n=== STDERR ===\n`, "utf8");
      const footer = Buffer.from(
        `\n=== END ===\n` +
        `exitCode: ${meta.exitCode === null ? "null" : meta.exitCode}\n` +
        `durationMs: ${meta.durationMs}\n` +
        `stdoutBytes: ${this.stdoutBytes}\n` +
        `stderrBytes: ${this.stderrBytes}\n` +
        `finished: ${finishedAt.toISOString()}\n`,
        "utf8"
      );

      const parts: Buffer[] = [header, ...this.stdoutChunks, stderrMarker, ...this.stderrChunks, footer];
      const totalLen =
        header.length + this.stdoutBytes + stderrMarker.length + this.stderrBytes + footer.length;
      fs.writeFileSync(this.filePath, Buffer.concat(parts, totalLen));
    } catch (err) {
      this.writeFailed = true;
      Logger.log(
        `Failed to write output log to ${this.filePath}: ${(err as Error).message}`,
        "error"
      );
    }
  }

  public didWriteFail(): boolean {
    return this.writeFailed;
  }
}

/**
 * Build a filename like `20250516T021530Z-12345-ab12cd34.log` so concurrent
 * commands never collide and the names sort chronologically.
 */
function makeLogFileName(startedAt: Date): string {
  const iso = startedAt.toISOString().replace(/[-:.]/g, "").replace(/Z$/, "Z");
  // iso is now like "20250516T021530123Z"; trim millis for brevity
  const ts = iso.replace(/(\d{8}T\d{6})\d*Z$/, "$1Z");
  const pid = process.pid;
  const rand = Math.floor(Math.random() * 0x100000000).toString(16).padStart(8, "0");
  return `${ts}-${pid}-${rand}.log`;
}

/**
 * Sanitize a server / user name into a safe path segment. Replaces anything
 * outside [A-Za-z0-9._-] with `_` and forbids `..` / leading dots so the
 * result can never escape the root dir.
 */
function sanitizeSegment(seg: string): string {
  if (!seg) return "";
  let cleaned = seg.replace(/[^A-Za-z0-9._-]/g, "_");
  // Collapse leading dots so we can't accidentally produce ".." or a hidden segment.
  cleaned = cleaned.replace(/^\.+/, "");
  if (cleaned === "" || cleaned === "..") return "";
  return cleaned;
}
