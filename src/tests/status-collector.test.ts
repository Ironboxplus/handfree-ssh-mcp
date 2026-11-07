/**
 * Whitebox tests for collectSystemStatus hang-hardening:
 *  - single exec channel (not ~17 parallel)
 *  - hard client-side timeout that closes the channel
 *  - KEY=value probe parsing
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import { EventEmitter } from "node:events";
import {
  collectSystemStatus,
  DEFAULT_STATUS_COLLECT_TIMEOUT_MS,
} from "../utils/status-collector.js";

class FakeChannel extends EventEmitter {
  stderr = new EventEmitter();
  closed = false;
  destroyed = false;

  close() {
    this.closed = true;
    // Do not auto-emit "close" — hang scenarios never get a close event.
  }

  destroy() {
    this.destroyed = true;
    this.closed = true;
  }

  writeStdout(text: string) {
    this.emit("data", Buffer.from(text));
  }

  finish(code: number | null = 0) {
    this.emit("close", code);
  }
}

function makeClient(onExec: (cmd: string, channel: FakeChannel) => void) {
  return {
    exec(command: string, cb: (err: Error | null, stream: FakeChannel) => void) {
      const channel = new FakeChannel();
      // Defer so the timeout timer is armed first (mirrors real async exec).
      queueMicrotask(() => {
        cb(null, channel);
        onExec(command, channel);
      });
      return undefined;
    },
  } as any;
}

describe("collectSystemStatus hang-hardening", () => {
  it("exports a positive default timeout", () => {
    assert.ok(DEFAULT_STATUS_COLLECT_TIMEOUT_MS > 0);
    assert.ok(DEFAULT_STATUS_COLLECT_TIMEOUT_MS <= 60_000);
  });

  it("opens exactly one exec channel with a single probe script", async () => {
    let execCount = 0;
    let seenCmd = "";
    const client = makeClient((cmd, channel) => {
      execCount += 1;
      seenCmd = cmd;
      channel.writeStdout(
        [
          "__STATUS_BEGIN__",
          "HOSTNAME=gpu-box",
          "IP=10.0.0.5",
          "OS_NAME=Linux",
          "OS_VERSION=Ubuntu 22.04",
          "KERNEL=5.15.0",
          "UPTIME=up 3 days",
          "DISK=free:100G total:500G",
          "MEMORY=free:32G total:64G",
          "CPU_NAME=AMD EPYC",
          "CPU_USAGE=12.5",
          "GPUS=NVIDIA|RTX 4090|40",
          "GPU_PATHS=/dev/dri/card0",
          "DRIVES=/dev/sda1|500G|400G|100G|80%|/",
          "PROCESSES=120",
          "THREADS=400",
          "SERVICES_RUNNING=50",
          "SERVICES_INSTALLED=200",
          "__STATUS_END__",
        ].join("\n"),
      );
      channel.finish(0);
    });

    const status = await collectSystemStatus(client, "dev", { timeoutMs: 2000 });
    assert.strictEqual(execCount, 1, "must use a single exec channel");
    // Probe is base64-encoded so remote quoting cannot break the multi-line script.
    assert.ok(
      seenCmd.includes("base64") || seenCmd.includes("__STATUS_BEGIN__"),
      `expected base64-wrapped probe, got: ${seenCmd.slice(0, 120)}`,
    );
    assert.strictEqual(status.reachable, true);
    assert.strictEqual(status.hostname, "gpu-box");
    assert.deepStrictEqual(status.ipAddresses, ["10.0.0.5"]);
    assert.strictEqual(status.osName, "Linux");
    assert.strictEqual(status.cpu?.name, "AMD EPYC");
    assert.strictEqual(status.cpu?.usage, "12.5%");
    assert.strictEqual(status.gpus?.[0]?.name, "RTX 4090");
    assert.strictEqual(status.gpus?.[0]?.usage, "40.0%");
    assert.strictEqual(status.gpus?.[0]?.path, "/dev/dri/card0");
    assert.strictEqual(status.diskSpace?.free, "100G");
    assert.strictEqual(status.memory?.total, "64G");
    assert.strictEqual(status.drives?.[0]?.mountPoint, "/");
    assert.ok((status.processes?.running ?? 0) > 0);
  });

  it("times out and marks unreachable when the remote channel never closes", async () => {
    let channelRef: FakeChannel | undefined;
    const client = makeClient((_cmd, channel) => {
      channelRef = channel;
      // Never emit close — simulates wedged nvidia-smi / dead peer.
    });

    const start = Date.now();
    const status = await collectSystemStatus(client, "gpu", { timeoutMs: 80 });
    const elapsed = Date.now() - start;

    assert.strictEqual(status.reachable, false);
    assert.ok(elapsed < 2000, `must not hang; took ${elapsed}ms`);
    assert.ok(elapsed >= 60, `should wait roughly for the timeout; took ${elapsed}ms`);
    assert.ok(
      channelRef?.closed || channelRef?.destroyed,
      "must close/destroy the hung channel so the session is released",
    );
  });

  it("still parses partial KEY=value output when exit code is non-zero but marker present", async () => {
    const client = makeClient((_cmd, channel) => {
      channel.writeStdout("__STATUS_BEGIN__\nHOSTNAME=partial-host\n__STATUS_END__\n");
      channel.finish(1);
    });
    const status = await collectSystemStatus(client, "dev", { timeoutMs: 1000 });
    assert.strictEqual(status.reachable, true);
    assert.strictEqual(status.hostname, "partial-host");
  });
});

describe("refreshStatus connect/probe budgets", () => {
  it("refreshStatus returns reachable:false quickly when connect fails", async () => {
    const { SSHConnectionManager } = await import(
      "../services/ssh-connection-manager.js"
    );
    const manager = SSHConnectionManager.getInstance() as any;

    manager.setConfig(
      {
        dead: {
          host: "127.0.0.1",
          port: 1,
          username: "nobody",
          password: "x",
        },
      },
      ["dead"],
    );

    const originalEnsure = manager.ensureConnected;
    // Simulate a connect that fails after a short delay (the production path
    // passes a 15s budget into ensureConnected; we keep this unit test fast).
    manager.ensureConnected = async () => {
      await new Promise((r) => setTimeout(r, 30));
      throw new Error("connect failed for test");
    };

    try {
      const start = Date.now();
      const results = await manager.refreshStatus();
      const elapsed = Date.now() - start;
      assert.ok(elapsed < 2000, `refreshStatus must not hang; took ${elapsed}ms`);
      assert.strictEqual(results.dead?.reachable, false);
      assert.strictEqual(manager.statusCache.get("dead")?.reachable, false);
    } finally {
      manager.ensureConnected = originalEnsure;
      manager.setConfig({}, undefined);
      manager.statusCache?.clear?.();
    }
  });

  it("refreshStatus passes a finite connect timeout into ensureConnected", async () => {
    const { SSHConnectionManager } = await import(
      "../services/ssh-connection-manager.js"
    );
    const manager = SSHConnectionManager.getInstance() as any;
    manager.setConfig(
      { a: { host: "127.0.0.1", port: 22, username: "u", password: "p" } },
      ["a"],
    );

    let seenTimeout: number | undefined;
    const originalEnsure = manager.ensureConnected;

    // Stub ensureConnected to capture the timeout arg, then throw so we never
    // need a real SSH peer.
    manager.ensureConnected = async (_name: string, timeout?: number) => {
      seenTimeout = timeout;
      throw new Error("stop after timeout capture");
    };

    try {
      await manager.refreshStatus("a");
      assert.ok(
        typeof seenTimeout === "number" && seenTimeout > 0 && seenTimeout <= 60_000,
        `expected a positive connect budget, got ${seenTimeout}`,
      );
    } finally {
      manager.ensureConnected = originalEnsure;
      manager.setConfig({}, undefined);
      manager.statusCache?.clear?.();
    }
  });
});
