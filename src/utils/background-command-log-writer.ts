import fs from "fs";
import path from "path";
import { Logger } from "./logger.js";

export interface BackgroundCommandLogWriterOptions {
  rootDir: string;
  serverName: string;
  username: string;
  command: string;
  runId: string;
  startedAt?: Date;
}

/**
 * Single-file live log for background commands.
 *
 * Unlike OutputLogWriter, this file is readable while the SSH command is still
 * running. It deliberately favors operational visibility over exact
 * stdout/stderr reconstruction.
 */
export class BackgroundCommandLogWriter {
  private readonly filePath: string;
  private readonly serverName: string;
  private readonly username: string;
  private readonly command: string;
  private readonly runId: string;
  private readonly startedAt: Date;
  private initialized = false;
  private closed = false;
  private writeFailed = false;
  private fd: number | null = null;

  constructor(opts: BackgroundCommandLogWriterOptions) {
    this.serverName = sanitizeSegment(opts.serverName) || "unknown";
    this.username = sanitizeSegment(opts.username) || "unknown";
    this.command = opts.command;
    this.runId = sanitizeSegment(opts.runId) || "run";
    this.startedAt = opts.startedAt ?? new Date();

    const dir = path.join(opts.rootDir, this.serverName, this.username, "background");
    const fileName = `${formatTimestamp(this.startedAt)}-${this.runId}.log`;
    this.filePath = path.join(dir, fileName);
  }

  public getPath(): string {
    return this.filePath;
  }

  public append(chunk: Buffer | string): void {
    if (this.closed || this.writeFailed) return;
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
    if (buf.length === 0) return;
    this.write(buf);
  }

  public appendStdout(chunk: Buffer | string): void {
    this.append(chunk);
  }

  public appendStderr(chunk: Buffer | string): void {
    this.append("[STDERR] ");
    this.append(chunk);
  }

  public appendLine(line: string): void {
    this.append(`${line}\n`);
  }

  public close(meta: {
    status: "completed" | "failed";
    durationMs: number;
    finishedAt?: Date;
    error?: string;
  }): void {
    if (this.closed) return;
    this.closed = true;
    const finishedAt = meta.finishedAt ?? new Date();
    const footer =
      `\n=== END ===\n` +
      `status: ${meta.status}\n` +
      `durationMs: ${meta.durationMs}\n` +
      `finished: ${finishedAt.toISOString()}\n` +
      (meta.error ? `error: ${meta.error}\n` : "");
    this.write(Buffer.from(footer, "utf8"), true);
    this.closeFd();
  }

  private write(buf: Buffer, closing = false): void {
    if (this.writeFailed) return;
    try {
      this.ensureInitialized();
      if (this.fd === null) {
        this.fd = fs.openSync(this.filePath, "a");
      }
      fs.writeSync(this.fd, buf);
    } catch (err) {
      this.writeFailed = true;
      this.closeFd();
      Logger.log(
        `BackgroundCommandLogWriter failure for ${this.filePath}: ${(err as Error).message}`,
        "error",
      );
    }
  }

  private ensureInitialized(): void {
    if (this.initialized) return;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const header =
      `=== META ===\n` +
      `runId: ${this.runId}\n` +
      `server: ${this.serverName}\n` +
      `user: ${this.username}\n` +
      `command: ${this.command}\n` +
      `started: ${this.startedAt.toISOString()}\n` +
      `=== LIVE OUTPUT ===\n`;
    fs.writeFileSync(this.filePath, header);
    this.fd = fs.openSync(this.filePath, "a");
    this.initialized = true;
  }

  private closeFd(): void {
    if (this.fd === null) return;
    try {
      fs.closeSync(this.fd);
    } catch {
      // Ignore close errors after writing the terminal footer.
    } finally {
      this.fd = null;
    }
  }
}

function formatTimestamp(date: Date): string {
  const iso = date.toISOString().replace(/[-:.]/g, "").replace(/Z$/, "Z");
  return iso.replace(/(\d{8}T\d{6})\d*Z$/, "$1Z");
}

function sanitizeSegment(seg: string): string {
  if (!seg) return "";
  let cleaned = seg.replace(/[^A-Za-z0-9._-]/g, "_");
  cleaned = cleaned.replace(/^\.+/, "");
  if (cleaned === "" || cleaned === "..") return "";
  return cleaned;
}
