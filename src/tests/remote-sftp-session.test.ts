import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, test } from "node:test";
import { SSHConnectionManager } from "../services/ssh-connection-manager.js";
import { RunService } from "../run/run-service.js";
import { readRemoteTextFile, DEFAULT_SFTP_OPERATION_TIMEOUT_MS } from "../run/remote-sftp.js";
import { RealSshTestServer } from "./helpers/real-ssh-server.js";

/**
 * Grey-box, real ssh2 server, real SFTP, real injected latency -- no mocks.
 *
 * Guards the defect that made a real `workspace-run` call hang far past the
 * timeout its caller set: every SFTP request in src/run/remote-sftp.ts used
 * to have NO timeout at all. A silently-dropped connection (routine on cloud
 * GPU hosts behind NAT/proxy idle reaping) leaves an SFTP callback that never
 * fires, and RunService's collect wait loop only checks its own deadline
 * BETWEEN polls -- so one wedged read hung the whole call indefinitely and
 * the caller's `timeout` could never fire.
 *
 * The fixture's readResponseDelayMs injects a real, server-side delay before
 * answering a READ. A request bounded at well under that delay must reject
 * with a timeout rather than wait it out -- which is exactly the shape of the
 * hang, reproduced deterministically instead of by unplugging a cable.
 */

const READ_DELAY_MS = 4000;
const SHORT_TIMEOUT_MS = 250;

describe("remote-sftp: per-request timeouts against a real slow SFTP server", { concurrency: false }, () => {
  const manager = SSHConnectionManager.getInstance();
  const suiteRoot = fs.mkdtempSync(path.join(os.tmpdir(), "handfree-sftp-timeout-"));
  const remoteServerRoot = path.join(suiteRoot, "remote-server");
  // Third constructor arg is readResponseDelayMs: a real delay before the
  // server answers any READ. readdir/stat/realpath stay fast, so only the
  // operations that actually read file bytes are slowed.
  const server = new RealSshTestServer(remoteServerRoot, 8, 0, READ_DELAY_MS);

  before(async () => {
    await server.start();
    fs.mkdirSync(remoteServerRoot, { recursive: true });
    fs.writeFileSync(path.join(remoteServerRoot, "slow.txt"), "payload", "utf8");
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

  test("a read slower than the timeout rejects promptly instead of hanging", async () => {
    const startedAt = Date.now();
    await assert.rejects(
      () => readRemoteTextFile("remote", "/slow.txt", undefined, undefined, SHORT_TIMEOUT_MS),
      (error: unknown) => {
        assert.match((error as Error).message, /timed out after 250ms/i);
        return true;
      },
      "a wedged SFTP read must surface as a timeout, not hang until the server eventually answers",
    );
    const elapsed = Date.now() - startedAt;
    // The load-bearing assertion: it came back on the TIMEOUT's schedule, not
    // the server's. Without a per-request timeout this resolves successfully
    // at ~4000ms instead.
    assert.ok(
      elapsed < READ_DELAY_MS / 2,
      `expected the timeout to fire at ~${SHORT_TIMEOUT_MS}ms, but the call took ${elapsed}ms (i.e. it waited for the slow server)`,
    );
  });

  test("the same read succeeds when the bound is generous -- it is a timeout, not a blanket failure", async () => {
    // Proves the previous test measured a timeout and not simply a broken
    // read path: same server, same file, only the bound changes.
    const text = await readRemoteTextFile("remote", "/slow.txt", undefined, undefined, READ_DELAY_MS + 4000);
    assert.equal(text, "payload");
  });

  test("the default bound is generous enough that ordinary slowness still succeeds", async () => {
    // The complement: adding a per-request bound must not turn ordinary
    // slowness into failure. The fixture answers READs after 4s, well inside
    // the 30s default, so this must SUCCEED -- if the default were set too
    // aggressively, this is the test that catches it.
    const startedAt = Date.now();
    const text = await readRemoteTextFile("remote", "/slow.txt");
    const elapsed = Date.now() - startedAt;
    assert.equal(text, "payload");
    assert.ok(elapsed >= READ_DELAY_MS - 500, "expected the read to actually go through the slow server");
    assert.ok(
      elapsed < DEFAULT_SFTP_OPERATION_TIMEOUT_MS,
      `should settle well inside the ${DEFAULT_SFTP_OPERATION_TIMEOUT_MS}ms default bound, took ${elapsed}ms`,
    );
  });

  test("RunService.getStatus still works against a slow-but-responsive server", async () => {
    const runId = "run_20260915T120000Z_dead0001";
    const runDir = path.join(remoteServerRoot, ".handfree-runs", runId);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(
      path.join(runDir, "meta.json"),
      JSON.stringify({
        runId,
        profile: "(ad-hoc)",
        server: "remote",
        remoteRoot: "/data/proj",
        workdir: "/data/proj",
        executable: "/data/venv/bin/python",
        entrypoint: "/data/proj/train.py",
        args: [],
        env: {},
        createdAt: new Date().toISOString(),
        identity: { bootId: "b", pid: 1, pgid: 1, startTicks: "1", wrapperToken: "t" },
      }),
      "utf8",
    );

    const runService = RunService.getInstance();
    const startedAt = Date.now();
    const status = await runService.getStatus("remote", runId);
    const elapsed = Date.now() - startedAt;

    assert.equal(status.runId, runId);
    assert.equal(status.profile, "(ad-hoc)");
    assert.ok(
      elapsed < DEFAULT_SFTP_OPERATION_TIMEOUT_MS,
      `getStatus should settle inside the ${DEFAULT_SFTP_OPERATION_TIMEOUT_MS}ms default bound, took ${elapsed}ms`,
    );
  });
});
