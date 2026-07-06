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

describe("resolveKeepalive", () => {
  const manager = SSHConnectionManager.getInstance() as any;

  it("defaults keepalive ON with sane interval/count when unset", () => {
    const k = manager.resolveKeepalive({});
    assert.strictEqual(k.keepaliveInterval, 15000);
    assert.strictEqual(k.keepaliveCountMax, 3);
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
    assert.strictEqual(k.keepaliveCountMax, 3);
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
