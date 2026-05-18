import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { OutputLogWriter } from "../utils/output-log-writer.js";

describe("OutputLogWriter", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "handfree-ssh-mcp-logwriter-"));
  });

  afterEach(() => {
    if (fs.existsSync(root)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("writes a log under <root>/<server>/<user>/<file>.log with META / STDOUT / STDERR / END markers", () => {
    const w = new OutputLogWriter({
      rootDir: root,
      serverName: "dev",
      username: "alice",
      command: "echo hi",
    });
    w.appendStdout("hi\n");
    w.appendStderr("warn\n");
    w.close({ exitCode: 0, durationMs: 42 });

    const filePath = w.getPath();
    assert.ok(filePath.includes(path.join("dev", "alice")), `got ${filePath}`);
    assert.ok(fs.existsSync(filePath));

    const content = fs.readFileSync(filePath, "utf8");
    assert.match(content, /^=== META ===\n/);
    assert.match(content, /\nserver: dev\n/);
    assert.match(content, /\nuser: alice\n/);
    assert.match(content, /\ncommand: echo hi\n/);
    assert.match(content, /\n=== STDOUT ===\nhi\n\n=== STDERR ===\nwarn\n\n=== END ===\n/);
    assert.match(content, /\nexitCode: 0\n/);
    assert.match(content, /\ndurationMs: 42\n/);
    assert.match(content, /\nstdoutBytes: 3\n/);
    assert.match(content, /\nstderrBytes: 5\n/);
  });

  it("creates server/user directories if they do not exist", () => {
    const w = new OutputLogWriter({
      rootDir: path.join(root, "deep", "nested"),
      serverName: "prod",
      username: "bob",
      command: "ls",
    });
    w.close({ exitCode: 0, durationMs: 0 });
    assert.ok(fs.existsSync(path.join(root, "deep", "nested", "prod", "bob")));
  });

  it("sanitizes unsafe characters in server/user names", () => {
    const w = new OutputLogWriter({
      rootDir: root,
      serverName: "../escape",
      username: "name/with:bad",
      command: "ls",
    });
    w.close({ exitCode: 0, durationMs: 0 });
    const p = w.getPath();
    // Must stay inside root and not contain raw separators / colons in the leaf segments.
    assert.ok(p.startsWith(root), `path escaped root: ${p}`);
    const rel = path.relative(root, p).split(path.sep);
    // rel = [serverSeg, userSeg, fileName]
    assert.strictEqual(rel.length, 3);
    assert.doesNotMatch(rel[0], /[/:]/);
    assert.doesNotMatch(rel[1], /[/:]/);
    assert.notStrictEqual(rel[0], "..");
  });

  it("close() is idempotent", () => {
    const w = new OutputLogWriter({
      rootDir: root,
      serverName: "dev",
      username: "alice",
      command: "ls",
    });
    w.appendStdout("hello");
    w.close({ exitCode: 0, durationMs: 1 });
    const before = fs.readFileSync(w.getPath(), "utf8");
    // Second close must be a no-op; appending more should not change the file.
    w.appendStdout(" world");
    w.close({ exitCode: 99, durationMs: 999 });
    const after = fs.readFileSync(w.getPath(), "utf8");
    assert.strictEqual(before, after);
  });

  it("reports a null exitCode when the remote was signaled", () => {
    const w = new OutputLogWriter({
      rootDir: root,
      serverName: "dev",
      username: "alice",
      command: "sleep 9999",
    });
    w.close({ exitCode: null, durationMs: 0 });
    const content = fs.readFileSync(w.getPath(), "utf8");
    assert.match(content, /\nexitCode: null\n/);
  });

  it("streams large stdout through a .stdout.part temp file and cleans it up on close", () => {
    const w = new OutputLogWriter({
      rootDir: root,
      serverName: "dev",
      username: "alice",
      command: "yes",
    });

    // 2 MiB of stdout in many small writes — should never live fully in RAM.
    const chunk = Buffer.alloc(64 * 1024, 0x41); // 64 KiB of 'A'
    for (let i = 0; i < 32; i++) {
      w.appendStdout(chunk);
    }
    const partPath = `${w.getPath()}.stdout.part`;
    assert.ok(fs.existsSync(partPath), "stdout part file must exist while streaming");
    const partSize = fs.statSync(partPath).size;
    assert.strictEqual(partSize, 32 * 64 * 1024);

    w.close({ exitCode: 0, durationMs: 1 });

    // Part file must be cleaned up.
    assert.ok(!fs.existsSync(partPath), "stdout part file must be removed after close");

    // Final file must contain all the stdout bytes intact.
    const final = fs.readFileSync(w.getPath());
    const stdoutStart = final.indexOf("=== STDOUT ===\n");
    const stderrStart = final.indexOf("\n=== STDERR ===\n");
    assert.ok(stdoutStart > 0 && stderrStart > stdoutStart);
    const stdoutBody = final.subarray(
      stdoutStart + "=== STDOUT ===\n".length,
      stderrStart,
    );
    assert.strictEqual(stdoutBody.length, 32 * 64 * 1024);
    // Spot check: every byte must be 'A'.
    assert.strictEqual(stdoutBody[0], 0x41);
    assert.strictEqual(stdoutBody[stdoutBody.length - 1], 0x41);

    const content = final.toString("utf8");
    assert.match(content, /\nstdoutBytes: 2097152\n/);
    assert.match(content, /\nstderrBytes: 0\n/);
  });

  it("does not create part files when nothing is appended", () => {
    const w = new OutputLogWriter({
      rootDir: root,
      serverName: "dev",
      username: "alice",
      command: "true",
    });
    w.close({ exitCode: 0, durationMs: 0 });

    assert.ok(fs.existsSync(w.getPath()));
    assert.ok(!fs.existsSync(`${w.getPath()}.stdout.part`));
    assert.ok(!fs.existsSync(`${w.getPath()}.stderr.part`));
    const content = fs.readFileSync(w.getPath(), "utf8");
    // Empty stdout/stderr sections still produce the markers and zero byte counts.
    assert.match(content, /\n=== STDOUT ===\n\n=== STDERR ===\n\n=== END ===\n/);
    assert.match(content, /\nstdoutBytes: 0\n/);
    assert.match(content, /\nstderrBytes: 0\n/);
  });

  it("preserves byte order across interleaved stdout/stderr appends", () => {
    const w = new OutputLogWriter({
      rootDir: root,
      serverName: "dev",
      username: "alice",
      command: "noisy",
    });
    // Interleave to make sure we don't accidentally mix streams.
    w.appendStdout("out-1\n");
    w.appendStderr("err-1\n");
    w.appendStdout("out-2\n");
    w.appendStderr("err-2\n");
    w.appendStdout("out-3\n");
    w.close({ exitCode: 0, durationMs: 1 });

    const content = fs.readFileSync(w.getPath(), "utf8");
    const stdoutMatch = content.match(/=== STDOUT ===\n([\s\S]*?)\n=== STDERR ===/);
    const stderrMatch = content.match(/=== STDERR ===\n([\s\S]*?)\n=== END ===/);
    assert.ok(stdoutMatch && stderrMatch);
    assert.strictEqual(stdoutMatch![1], "out-1\nout-2\nout-3\n");
    assert.strictEqual(stderrMatch![1], "err-1\nerr-2\n");
  });

  it("ignores appends after close()", () => {
    const w = new OutputLogWriter({
      rootDir: root,
      serverName: "dev",
      username: "alice",
      command: "ls",
    });
    w.appendStdout("before\n");
    w.close({ exitCode: 0, durationMs: 1 });
    const before = fs.readFileSync(w.getPath(), "utf8");
    w.appendStdout("after\n");
    w.appendStderr("after-err\n");
    const after = fs.readFileSync(w.getPath(), "utf8");
    assert.strictEqual(before, after);
  });

  it("file names sort chronologically and avoid collisions for the same start time", () => {
    const fixedDate = new Date("2026-05-16T02:15:30.000Z");
    const a = new OutputLogWriter({
      rootDir: root,
      serverName: "dev",
      username: "alice",
      command: "ls",
      startedAt: fixedDate,
    });
    const b = new OutputLogWriter({
      rootDir: root,
      serverName: "dev",
      username: "alice",
      command: "ls",
      startedAt: fixedDate,
    });
    // Same timestamp prefix, but the random suffix makes them distinct.
    const baseA = path.basename(a.getPath());
    const baseB = path.basename(b.getPath());
    assert.match(baseA, /^20260516T021530Z-\d+-[0-9a-f]{8}\.log$/);
    assert.match(baseB, /^20260516T021530Z-\d+-[0-9a-f]{8}\.log$/);
    assert.notStrictEqual(baseA, baseB);
  });
});
