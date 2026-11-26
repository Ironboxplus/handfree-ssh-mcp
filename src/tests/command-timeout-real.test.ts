import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, test } from "node:test";
import { SSHConnectionManager } from "../services/ssh-connection-manager.js";
import { ToolError } from "../utils/tool-error.js";
import { RealSshTestServer } from "./helpers/real-ssh-server.js";

/**
 * The command timeout ends the wait, never the command (user decision
 * 2026-11-27: "大部分都是长任务超时了，本来就不应该被kill"). Before, a timeout
 * reported "Remote process killed" while a build on an OpenSSH 8.9 server kept
 * writing its log for 95 more seconds. Against a real ssh2 server running a
 * real shell: the command must outlive the timeout, keep a working stdout
 * after it (a closed channel would break its pipe on the next write), and
 * its later output must reach the log.
 */

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return true;
    await sleep(50);
  }
  return check();
}

describe("command timeout detaches instead of stopping the command", { concurrency: false }, () => {
  const manager = SSHConnectionManager.getInstance();
  const suiteRoot = fs.mkdtempSync(path.join(os.tmpdir(), "handfree-command-timeout-"));
  const server = new RealSshTestServer(path.join(suiteRoot, "server"));
  const logRoot = path.join(suiteRoot, "logs");
  const shellPath = (file: string) => file.replace(/\\/g, "/");
  // Writes to stdout after the timeout, then leaves a marker: the marker
  // exists only if the process survived and its stdout still worked.
  const command = (marker: string) => `sleep 1; echo late-output; sleep 1; echo done > '${shellPath(marker)}'`;

  before(async () => {
    await server.start();
    manager.setConfig({
      srv: { host: "127.0.0.1", port: server.port, username: "test", password: "test", keepaliveInterval: 0 },
    }, ["srv"]);
    manager.setOutputLogRoot(logRoot);
  });

  after(async () => {
    manager.disconnect();
    manager.setOutputLogRoot(null);
    await server.stop();
    fs.rmSync(suiteRoot, { recursive: true, force: true });
    manager.setConfig({}, undefined);
  });

  test("stream=false: COMMAND_TIMEOUT says it was not stopped; the command finishes and its later output reaches the log", async () => {
    const marker = path.join(suiteRoot, "foreground.done");
    let logPath = "";
    await assert.rejects(
      () => manager.executeCommand(command(marker), "srv", { timeout: 300, maxRetries: 0 }),
      (error: unknown) => {
        assert.ok(error instanceof ToolError);
        assert.equal(error.code, "COMMAND_TIMEOUT");
        assert.match(error.message, /not stopped/);
        assert.doesNotMatch(error.message, /killed/i);
        const match = /keeps going to (.+)\.$/.exec(error.message);
        assert.ok(match, error.message);
        logPath = match![1];
        return true;
      },
    );
    assert.ok(await waitFor(() => fs.existsSync(marker), 10_000), "the command kept running after the timeout");
    assert.ok(
      await waitFor(() => fs.existsSync(logPath) && /late-output/.test(fs.readFileSync(logPath, "utf8")), 5_000),
      "output written after the timeout is in the log",
    );
  });

  test("stream=true: the command stays tracked as running past the timeout and completes with its output", async () => {
    const marker = path.join(suiteRoot, "background.done");
    const started = manager.startCommandBackground(command(marker), "srv", { timeout: 300, maxRetries: 0 });
    await sleep(800);
    assert.equal(manager.getBackgroundCommandStatus(started.runId, 65536, undefined, false).status, "running");

    assert.ok(
      await waitFor(() => manager.getBackgroundCommandStatus(started.runId, 65536, undefined, false).status !== "running", 10_000),
      "the background command finished",
    );
    const status = manager.getBackgroundCommandStatus(started.runId, 65536, undefined, false);
    assert.equal(status.status, "completed", status.error);
    assert.ok(fs.existsSync(marker));
    assert.match(status.outputTail ?? "", /still running after 300ms; it was not stopped/);
    assert.match(status.outputTail ?? "", /late-output/);
  });
});
