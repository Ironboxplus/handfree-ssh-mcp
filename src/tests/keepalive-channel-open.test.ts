/**
 * Whitebox tests for the reused-dead-connection hardening:
 *
 *   - resolveKeepalive: ssh2 keepalive is ON by default, tunable, and disablable.
 *   - resolveChannelOpenTimeout: short exec-channel-open timeout, tunable.
 *   - runCommandStream: when the exec channel never opens (a reused-but-dead
 *     connection accepts yet never replies), the command fails fast within the
 *     SHORT channel-open timeout instead of hanging until the full command
 *     timeout — and the error is retriable so the caller drops the stale client.
 *
 * Reaches into SSHConnectionManager via `as any`, matching recent-fixes.test.ts.
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import { EventEmitter } from "node:events";
import { SSHConnectionManager } from "../services/ssh-connection-manager.js";
import { TransferService } from "../services/transfer-service.js";
import { ToolError } from "../utils/tool-error.js";

describe("unavailable SFTP subsystem", () => {
  for (const [message, code, dropped] of [
    ["Received exit code 127 while establishing SFTP session", "SFTP_ERROR", false],
    ["No response from server", "SSH_CONNECTION_FAILED", true],
  ] as const) {
    it(`${message}: preserves transport only for missing subsystem`, async () => {
      let closed = false;
      const pool = {
        acquireSshClient: async () => ({ client: { sftp: (cb: Function) => cb(new Error(message)) } }),
        normalizeConnectTimeout: () => 1000,
        withConnectionTimeout: (pending: Promise<unknown>) => pending,
        isConnectionError: (error: ToolError) => error.code === "SSH_CONNECTION_FAILED",
        closeClient: () => { closed = true; },
      };
      const service = new TransferService(pool as any) as any;
      const scope = service.openTransferScope("test", {}, undefined, 1);
      try {
        await assert.rejects(scope.run(0, () => assert.fail("SFTP is unavailable")),
          (error: ToolError) => error.code === code && error.retriable === dropped);
        assert.equal(closed, dropped);
      } finally {
        await scope.close();
      }
    });
  }
});

describe("resolveKeepalive", () => {
  const manager = SSHConnectionManager.getInstance() as any;

  it("defaults keepalive ON with sane interval/count when unset", () => {
    const k = manager.resolveKeepalive({});
    assert.strictEqual(k.keepaliveInterval, 5000);
    assert.strictEqual(k.keepaliveCountMax, 2);
  });

  it("honors explicit interval and count", () => {
    const k = manager.resolveKeepalive({ keepaliveInterval: 5000, keepaliveCountMax: 6 });
    assert.strictEqual(k.keepaliveInterval, 5000);
    assert.strictEqual(k.keepaliveCountMax, 6);
  });

  it("disables keepalive (empty object, no keys) when interval <= 0", () => {
    assert.deepStrictEqual(manager.resolveKeepalive({ keepaliveInterval: 0 }), {});
    assert.deepStrictEqual(manager.resolveKeepalive({ keepaliveInterval: -1 }), {});
  });

  it("falls back to default count when count is invalid but interval is set", () => {
    const k = manager.resolveKeepalive({ keepaliveInterval: 8000, keepaliveCountMax: 0 });
    assert.strictEqual(k.keepaliveInterval, 8000);
    assert.strictEqual(k.keepaliveCountMax, 2);
  });
});

describe("resolveChannelOpenTimeout", () => {
  const manager = SSHConnectionManager.getInstance() as any;

  it("defaults to 10000ms when unset", () => {
    assert.strictEqual(manager.resolveChannelOpenTimeout({}), 10000);
  });

  it("honors an explicit positive value", () => {
    assert.strictEqual(manager.resolveChannelOpenTimeout({ channelOpenTimeout: 5000 }), 5000);
  });

  it("ignores non-positive/invalid values and uses the default", () => {
    assert.strictEqual(manager.resolveChannelOpenTimeout({ channelOpenTimeout: 0 }), 10000);
    assert.strictEqual(manager.resolveChannelOpenTimeout({ channelOpenTimeout: -5 }), 10000);
  });
});

describe("resolveCircuitOpenTimeout (jump-circuit fast-fail bound)", () => {
  const manager = SSHConnectionManager.getInstance() as any;

  it("defaults to the 10000ms channel-open timeout when no connect cap", () => {
    assert.strictEqual(manager.resolveCircuitOpenTimeout({}), 10000);
  });

  it("caps the circuit-open timeout at the connect timeout (never longer)", () => {
    // The whole point: a dead bastion must not be waited on for the full command
    // timeout. With a 5000ms connect cap the short bound stays 5000, and with a
    // huge cap it stays the 10000ms default — always the smaller of the two.
    assert.strictEqual(manager.resolveCircuitOpenTimeout({}, 5000), 5000);
    assert.strictEqual(manager.resolveCircuitOpenTimeout({}, 150000), 10000);
  });

  it("honors a per-server channelOpenTimeout for the circuit too", () => {
    // A slow-but-live bastion can be accommodated by bumping channelOpenTimeout.
    assert.strictEqual(manager.resolveCircuitOpenTimeout({ channelOpenTimeout: 30000 }, 150000), 30000);
    assert.strictEqual(manager.resolveCircuitOpenTimeout({ channelOpenTimeout: 30000 }, 20000), 20000);
  });
});

/** A fake ssh2 Client whose exec() never invokes its callback (dead channel). */
class DeadChannelClient extends EventEmitter {
  exec(_cmd: string, _cb: (err: Error | undefined, stream: unknown) => void): void {
    // Intentionally never calls back: the channel-open request gets no reply,
    // exactly like a reused-but-dead SSH connection.
  }
}

describe("runCommandStream channel-open timeout", () => {
  const manager = SSHConnectionManager.getInstance() as any;

  it("fails fast within the short channel-open timeout, not the long command timeout", async () => {
    const client = new DeadChannelClient();
    const start = Date.now();
    await assert.rejects(
      manager.runCommandStream("sleep 999", client, 10000, {
        channelOpenTimeout: 60, // short open timeout
      }),
      (err: any) =>
        err?.code === "SSH_CONNECTION_FAILED" &&
        err?.retriable === true &&
        /channel|timeout/i.test(err.message),
    );
    const elapsed = Date.now() - start;
    // Must abort near the 60ms open timeout, far below the 10s command timeout.
    assert.ok(elapsed < 3000, `expected fast fail, took ${elapsed}ms`);
  });

  it("caps the open timeout at the command timeout when the latter is smaller", async () => {
    const client = new DeadChannelClient();
    const start = Date.now();
    await assert.rejects(
      manager.runCommandStream("sleep 999", client, 50, {
        channelOpenTimeout: 60000, // larger than the command timeout
      }),
      (err: any) => err?.code === "SSH_CONNECTION_FAILED" && err?.retriable === true,
    );
    assert.ok(Date.now() - start < 3000, "must not wait the full 60s open timeout");
  });
});
