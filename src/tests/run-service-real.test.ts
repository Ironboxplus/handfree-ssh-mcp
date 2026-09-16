import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, test } from "node:test";
import { SSHConnectionManager } from "../services/ssh-connection-manager.js";
import { RunService, HEARTBEAT_STALE_THRESHOLD_MS } from "../run/run-service.js";
import { RunServiceError } from "../run/run-errors.js";
import { resolveRemoteHomeDir } from "../run/remote-sftp.js";
import { RealSshTestServer } from "./helpers/real-ssh-server.js";

// PLAN.MD P2-03/04: grey/black-box against a REAL ssh2 server (real SFTP,
// real bytes, real files -- see real-ssh-server.ts). This exercises every
// SFTP-only code path in RunService (getStatus/getLogs/list/cancel's
// early-return branches) against hand-seeded state-directory files that
// mirror exactly what the remote wrapper (wrapper-script.ts) would have
// written for real on Linux. What this file deliberately does NOT attempt:
// actually launching a process or sending a signal -- those require real
// Linux process semantics (setsid/proc/kill) this Windows dev box cannot
// genuinely provide; see run-acceptance-linux-pending.test.ts.

function isoMinus(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value), "utf8");
}

const identity = { bootId: "boot-1", pid: 4242, pgid: 4242, startTicks: "998877", wrapperToken: "token-abc" };

function baseMeta(runId: string, overrides: Record<string, unknown> = {}) {
  return {
    runId,
    profile: "qwen-dev",
    server: "remote",
    remoteRoot: "/data/arc/qwen",
    workdir: "/data/arc/qwen",
    executable: "/data/arc/venvs/qwen/bin/python",
    entrypoint: "/data/arc/qwen/train.py",
    args: ["--epochs", "3"],
    env: { PYTHONUNBUFFERED: "1" },
    createdAt: isoMinus(1000),
    identity,
    ...overrides,
  };
}

describe("P2-03/04 grey-box: RunService against a real ssh2/SFTP server", { concurrency: false }, () => {
  const manager = SSHConnectionManager.getInstance();
  const runService = RunService.getInstance();
  const suiteRoot = fs.mkdtempSync(path.join(os.tmpdir(), "handfree-run-service-"));
  const remoteServerRoot = path.join(suiteRoot, "remote-server");
  const server = new RealSshTestServer(remoteServerRoot);
  const runsRoot = path.join(remoteServerRoot, ".handfree-runs");

  before(async () => {
    await server.start();
    manager.setConfig(
      {
        remote: {
          host: "127.0.0.1",
          port: server.port,
          username: "test",
          password: "test",
          disableSftpPathPolicy: true,
          keepaliveInterval: 0,
        },
      },
      ["remote"],
    );
  });

  after(async () => {
    manager.disconnect();
    await server.stop();
    fs.rmSync(suiteRoot, { recursive: true, force: true });
    manager.setConfig({}, undefined);
  });

  test("resolveRemoteHomeDir discovers the sftp-server's starting directory via REALPATH('.')", async () => {
    const home = await resolveRemoteHomeDir("remote");
    assert.equal(home, "/");
  });

  test("getStatus: heartbeat present and fresh -> running", async () => {
    const runId = "run_20260915T120000Z_aaaaaaaa";
    writeJson(path.join(runsRoot, runId, "meta.json"), baseMeta(runId));
    fs.writeFileSync(path.join(runsRoot, runId, "heartbeat"), isoMinus(1000), "utf8");
    const status = await runService.getStatus("remote", runId);
    assert.equal(status.state, "running");
    assert.equal(status.phase, "remote-running");
    assert.equal(status.exitCode, null);
  });

  test("getStatus: exit.json waitStatus 0 -> completed", async () => {
    const runId = "run_20260915T120000Z_bbbbbbbb";
    writeJson(path.join(runsRoot, runId, "meta.json"), baseMeta(runId));
    writeJson(path.join(runsRoot, runId, "exit.json"), { waitStatus: 0, finishedAt: isoMinus(500), cancelled: false });
    const status = await runService.getStatus("remote", runId);
    assert.equal(status.state, "completed");
    assert.equal(status.exitCode, 0);
    assert.equal(status.signal, null);
  });

  test("getStatus: exit.json waitStatus 1 -> failed", async () => {
    const runId = "run_20260915T120000Z_cccccccc";
    writeJson(path.join(runsRoot, runId, "meta.json"), baseMeta(runId));
    writeJson(path.join(runsRoot, runId, "exit.json"), { waitStatus: 1, finishedAt: isoMinus(500), cancelled: false });
    const status = await runService.getStatus("remote", runId);
    assert.equal(status.state, "failed");
    assert.equal(status.exitCode, 1);
  });

  test("getStatus: exit.json waitStatus 143 (SIGTERM) + cancelled:true -> cancelled, signal decoded", async () => {
    const runId = "run_20260915T120000Z_dddddddd";
    writeJson(path.join(runsRoot, runId, "meta.json"), baseMeta(runId));
    writeJson(path.join(runsRoot, runId, "exit.json"), { waitStatus: 143, finishedAt: isoMinus(500), cancelled: true });
    const status = await runService.getStatus("remote", runId);
    assert.equal(status.state, "cancelled");
    assert.equal(status.exitCode, null);
    assert.equal(status.signal, "SIGTERM");
  });

  test("getStatus: orphaned.json present, no exit.json -> orphaned", async () => {
    const runId = "run_20260915T120000Z_eeeeeeee";
    writeJson(path.join(runsRoot, runId, "meta.json"), baseMeta(runId));
    writeJson(path.join(runsRoot, runId, "orphaned.json"), { detectedAt: isoMinus(200), reason: "pid reuse" });
    const status = await runService.getStatus("remote", runId);
    assert.equal(status.state, "orphaned");
    assert.equal(status.orphaned?.reason, "pid reuse");
  });

  test("getStatus: heartbeat stale and run not recently created -> recovering (ambiguous)", async () => {
    const runId = "run_20260915T120000Z_ffffffff";
    writeJson(path.join(runsRoot, runId, "meta.json"), baseMeta(runId, { createdAt: isoMinus(HEARTBEAT_STALE_THRESHOLD_MS * 5) }));
    fs.writeFileSync(path.join(runsRoot, runId, "heartbeat"), isoMinus(HEARTBEAT_STALE_THRESHOLD_MS * 5), "utf8");
    const status = await runService.getStatus("remote", runId);
    assert.equal(status.state, "recovering");
  });

  test("getStatus: unknown runId -> RUN_NOT_FOUND", async () => {
    await assert.rejects(
      () => runService.getStatus("remote", "run_20260915T120000Z_00000000"),
      (error: unknown) => error instanceof RunServiceError && error.code === "RUN_NOT_FOUND",
    );
  });

  test("getStatus: corrupt meta.json -> RUN_STATE_UNREADABLE, not a crash", async () => {
    const runId = "run_20260915T120000Z_11111111";
    fs.mkdirSync(path.join(runsRoot, runId), { recursive: true });
    fs.writeFileSync(path.join(runsRoot, runId, "meta.json"), "{not json", "utf8");
    await assert.rejects(
      () => runService.getStatus("remote", runId),
      (error: unknown) => error instanceof RunServiceError && error.code === "RUN_STATE_UNREADABLE",
    );
  });

  test("getStatus: invalid runId shape -> INVALID_RUN_ID before any SFTP call", async () => {
    await assert.rejects(
      () => runService.getStatus("remote", "../../etc/passwd"),
      (error: unknown) => error instanceof RunServiceError && error.code === "INVALID_RUN_ID",
    );
  });

  test("getLogs: real SFTP byte-offset paging across a UTF-8 character split at the window boundary", async () => {
    const runId = "run_20260915T120000Z_22222222";
    writeJson(path.join(runsRoot, runId, "meta.json"), baseMeta(runId));
    const content = "prefix-ab中cd-suffix-" + "x".repeat(100);
    fs.writeFileSync(path.join(runsRoot, runId, "stdout.log"), content, "utf8");

    server.resetReadLog();
    const cap = Buffer.byteLength("prefix-ab", "utf8") + 1; // lands one byte into the 3-byte character
    const first = await runService.getLogs("remote", runId, "stdout", 0, cap);
    assert.equal(content.startsWith(first.text), true);
    assert.equal(first.startOffset, 0);
    assert.equal(first.hasMore, true);

    const second = await runService.getLogs("remote", runId, "stdout", first.nextOffset, 1_000_000);
    assert.equal(first.text + second.text, content);
    assert.equal(second.hasMore, false);
    assert.equal(second.fileSize, Buffer.byteLength(content, "utf8"));

    // Grey-box: the bytes really were fetched over ranged real SFTP READ
    // requests (not read whole and sliced client-side after the fact).
    assert.ok(server.stats.readRequests.length >= 2);
    assert.equal(server.stats.readRequests[0].offset, 0);
  });

  test("getLogs: reading a stream that does not exist yet returns an empty, non-error chunk", async () => {
    const runId = "run_20260915T120000Z_33333333";
    writeJson(path.join(runsRoot, runId, "meta.json"), baseMeta(runId));
    const chunk = await runService.getLogs("remote", runId, "stderr", 0, 1000);
    assert.deepEqual(chunk, { text: "", startOffset: 0, nextOffset: 0, fileSize: 0, hasMore: false });
  });

  test("list: newest-first, profile filter, and a corrupt run directory is silently omitted", async () => {
    const ids = [
      "run_20260915T090000Z_10000001",
      "run_20260915T100000Z_10000002",
      "run_20260915T110000Z_10000003",
    ];
    writeJson(path.join(runsRoot, ids[0], "meta.json"), baseMeta(ids[0], { profile: "other-profile" }));
    writeJson(path.join(runsRoot, ids[1], "meta.json"), baseMeta(ids[1], { profile: "list-test-profile" }));
    writeJson(path.join(runsRoot, ids[2], "meta.json"), baseMeta(ids[2], { profile: "list-test-profile" }));
    fs.mkdirSync(path.join(runsRoot, "run_20260915T120000Z_99999999"), { recursive: true });
    fs.writeFileSync(path.join(runsRoot, "run_20260915T120000Z_99999999", "meta.json"), "{not json", "utf8");

    const runs = await runService.list("remote", { profile: "list-test-profile" });
    assert.deepEqual(runs.map((r) => r.runId), [ids[2], ids[1]]);
  });

  test("list: limit is respected", async () => {
    const runs = await runService.list("remote", { limit: 1 });
    assert.equal(runs.length <= 1, true);
  });

  test("cancel: exit.json already present -> already-exited, no signal path taken", async () => {
    const runId = "run_20260915T120000Z_44444444";
    writeJson(path.join(runsRoot, runId, "meta.json"), baseMeta(runId));
    writeJson(path.join(runsRoot, runId, "exit.json"), { waitStatus: 0, finishedAt: isoMinus(100), cancelled: false });
    const result = await runService.cancel("remote", runId);
    assert.deepEqual(result, { runId, outcome: "already-exited" });
  });

  test("cancel: orphaned.json already present -> orphaned, idempotent, reports the stored reason", async () => {
    const runId = "run_20260915T120000Z_55555555";
    writeJson(path.join(runsRoot, runId, "meta.json"), baseMeta(runId));
    writeJson(path.join(runsRoot, runId, "orphaned.json"), { detectedAt: isoMinus(100), reason: "previously detected pid reuse" });
    const result = await runService.cancel("remote", runId);
    assert.deepEqual(result, { runId, outcome: "orphaned", reason: "previously detected pid reuse" });
  });
});
