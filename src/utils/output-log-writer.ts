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
 * Format:
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
 * Streaming strategy: stdout and stderr each flow into their own temp file
 * (`<path>.stdout.part`, `<path>.stderr.part`) as chunks arrive, so memory
 * is bounded by a single chunk. On `close()`, we assemble the final file by
 * streaming the header, then the stdout part, then the stderr marker, then
 * the stderr part, then the footer, and delete the temp parts.
 *
 * Any write failure is logged and swallowed; it never aborts the SSH
 * command. `getPath()` always returns the intended final path so callers
 * can still report it.
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
  private readonly stdoutPartPath: string;
  private readonly stderrPartPath: string;
  private readonly serverName: string;
  private readonly username: string;
  private readonly command: string;
  private readonly startedAt: Date;
  private stdoutBytes = 0;
  private stderrBytes = 0;
  private stdoutFd: number | null = null;
  private stderrFd: number | null = null;
  private dirEnsured = false;
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
    this.stdoutPartPath = `${this.filePath}.stdout.part`;
    this.stderrPartPath = `${this.filePath}.stderr.part`;
  }

  /**
   * The absolute path the log will (or did) live at.
   */
  public getPath(): string {
    return this.filePath;
  }

  public appendStdout(chunk: Buffer | string): void {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
    if (buf.length === 0 || this.writeFailed || this.closed) return;
    const fd = this.openPartLazily("stdout");
    if (fd === null) return;
    try {
      fs.writeSync(fd, buf);
      this.stdoutBytes += buf.length;
    } catch (err) {
      this.markFailed(`stdout write: ${(err as Error).message}`);
    }
  }

  public appendStderr(chunk: Buffer | string): void {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
    if (buf.length === 0 || this.writeFailed || this.closed) return;
    const fd = this.openPartLazily("stderr");
    if (fd === null) return;
    try {
      fs.writeSync(fd, buf);
      this.stderrBytes += buf.length;
    } catch (err) {
      this.markFailed(`stderr write: ${(err as Error).message}`);
    }
  }

  /**
   * Finalize the log: assemble header + stdout part + stderr part + footer
   * into the final file, then delete the parts. Safe to call multiple
   * times; only the first call performs work.
   */
  public close(meta: { exitCode: number | null; durationMs: number; finishedAt?: Date }): void {
    if (this.closed) return;
    this.closed = true;

    // Always close FDs first so the parts are flushed on disk.
    this.closeFd("stdout");
    this.closeFd("stderr");

    if (this.writeFailed) {
      // Best-effort: clean up any partial parts so we don't leave junk.
      this.unlinkQuiet(this.stdoutPartPath);
      this.unlinkQuiet(this.stderrPartPath);
      return;
    }

    const finishedAt = meta.finishedAt ?? new Date();
    try {
      this.ensureDir();

      const header =
        `=== META ===\n` +
        `server: ${this.serverName}\n` +
        `user: ${this.username}\n` +
        `command: ${this.command}\n` +
        `started: ${this.startedAt.toISOString()}\n` +
        `=== STDOUT ===\n`;
      const stderrMarker = `\n=== STDERR ===\n`;
      const footer =
        `\n=== END ===\n` +
        `exitCode: ${meta.exitCode === null ? "null" : meta.exitCode}\n` +
        `durationMs: ${meta.durationMs}\n` +
        `stdoutBytes: ${this.stdoutBytes}\n` +
        `stderrBytes: ${this.stderrBytes}\n` +
        `finished: ${finishedAt.toISOString()}\n`;

      const outFd = fs.openSync(this.filePath, "w");
      try {
        fs.writeSync(outFd, header);
        this.appendPartTo(outFd, this.stdoutPartPath);
        fs.writeSync(outFd, stderrMarker);
        this.appendPartTo(outFd, this.stderrPartPath);
        fs.writeSync(outFd, footer);
      } finally {
        fs.closeSync(outFd);
      }
    } catch (err) {
      this.markFailed(`finalize: ${(err as Error).message}`);
    } finally {
      this.unlinkQuiet(this.stdoutPartPath);
      this.unlinkQuiet(this.stderrPartPath);
    }
  }

  public didWriteFail(): boolean {
    return this.writeFailed;
  }

  /**
   * Open the stdout/stderr part file on first use. Returns the FD or null
   * if the open failed (in which case the writer is marked failed).
   */
  private openPartLazily(which: "stdout" | "stderr"): number | null {
    const existing = which === "stdout" ? this.stdoutFd : this.stderrFd;
    if (existing !== null) return existing;
    try {
      this.ensureDir();
      const partPath = which === "stdout" ? this.stdoutPartPath : this.stderrPartPath;
      const fd = fs.openSync(partPath, "w");
      if (which === "stdout") this.stdoutFd = fd;
      else this.stderrFd = fd;
      return fd;
    } catch (err) {
      this.markFailed(`open ${which} part: ${(err as Error).message}`);
      return null;
    }
  }

  private closeFd(which: "stdout" | "stderr"): void {
    const fd = which === "stdout" ? this.stdoutFd : this.stderrFd;
    if (fd === null) return;
    try {
      fs.closeSync(fd);
    } catch {
      // Ignore close errors — we still want to attempt finalization.
    }
    if (which === "stdout") this.stdoutFd = null;
    else this.stderrFd = null;
  }

  private ensureDir(): void {
    if (this.dirEnsured) return;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    this.dirEnsured = true;
  }

  /**
   * Stream the contents of a part file into the given output FD, 64 KiB at
   * a time. Missing parts are silently skipped (they just mean that stream
   * never produced any bytes).
   */
  private appendPartTo(outFd: number, partPath: string): void {
    let inFd: number;
    try {
      inFd = fs.openSync(partPath, "r");
    } catch {
      return; // part never created
    }
    try {
      const chunk = Buffer.allocUnsafe(64 * 1024);
      while (true) {
        const n = fs.readSync(inFd, chunk, 0, chunk.length, null);
        if (n <= 0) break;
        fs.writeSync(outFd, chunk, 0, n);
      }
    } finally {
      fs.closeSync(inFd);
    }
  }

  private unlinkQuiet(p: string): void {
    try {
      fs.unlinkSync(p);
    } catch {
      // Missing or in-use: ignore. Cleanup is best-effort.
    }
  }

  private markFailed(reason: string): void {
    this.writeFailed = true;
    Logger.log(
      `OutputLogWriter failure for ${this.filePath}: ${reason}`,
      "error",
    );
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
