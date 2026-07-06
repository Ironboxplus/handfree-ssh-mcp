/**
 * Whitebox tests for the SFTP transfer stall watchdog.
 *
 * Bug: the non-fast SFTP stream paths (sftpWriteBuffer, sftpReadBuffer, and the
 * download/relay pipes) only settled on close/finish/error. On a reused-but-dead
 * SSH connection the channel opens yet the data write/read never progresses and
 * never errors, so the transfer hung until the caller's outer timeout (~300s).
 *
 * These tests drive the fix: each stream path must abort with a retriable
 * SSH_CONNECTION_FAILED stall error when no bytes move for `timeout` ms, while a
 * healthy streaming transfer still completes.
 *
 * Reaches into SSHConnectionManager via `as any`, matching recent-fixes.test.ts.
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import { EventEmitter } from "node:events";
import { SSHConnectionManager } from "../services/ssh-connection-manager.js";

const STALL_MS = 80;

/** A writable that accepts writes but never acknowledges them (dead channel). */
class StallWriteStream extends EventEmitter {
  write(_chunk: Buffer, _cb?: (e?: Error | null) => void): boolean {
    // Never invoke the callback: simulates a write whose ack never returns.
    return false;
  }
  end(): void {
    // Never emits "close": the transfer can never complete.
  }
  destroy(): void {
    /* no-op */
  }
}

/** A writable that acks every write and closes cleanly. */
class HealthyWriteStream extends EventEmitter {
  write(_chunk: Buffer, cb?: (e?: Error | null) => void): boolean {
    if (cb) queueMicrotask(() => cb());
    return true;
  }
  end(): void {
    queueMicrotask(() => {
      this.emit("finish");
      this.emit("close");
    });
  }
  destroy(): void {
    /* no-op */
  }
}

/** A readable that never emits anything (dead channel). */
class StallReadStream extends EventEmitter {
  pipe(dest: unknown): unknown {
    return dest;
  }
  unpipe(): void {
    /* no-op */
  }
  destroy(): void {
    /* no-op */
  }
}

/**
 * A readable that streams the given chunks then ends. Emission is deferred to a
 * macrotask so it fires AFTER the code under test has attached its listeners
 * (createReadStream must be called lazily, at the moment listeners are wired).
 */
class HealthyReadStream extends EventEmitter {
  constructor(private readonly chunks: Buffer[]) {
    super();
    setImmediate(() => {
      for (const c of this.chunks) this.emit("data", c);
      this.emit("end");
    });
  }
  pipe(dest: unknown): unknown {
    return dest;
  }
  unpipe(): void {
    /* no-op */
  }
  destroy(): void {
    /* no-op */
  }
}

function fakeClient(sftp: unknown): any {
  return {
    sftp: (cb: (err: Error | undefined, sftp: unknown) => void) => cb(undefined, sftp),
  };
}

function fakeSftp(overrides: Record<string, unknown>): any {
  return {
    end: () => {},
    ...overrides,
  };
}

describe("sftpWriteBuffer stall watchdog", () => {
  const manager = SSHConnectionManager.getInstance() as any;

  it("rejects with a retriable stall error when the write never acks", async () => {
    const ws = new StallWriteStream();
    const sftp = fakeSftp({ createWriteStream: () => ws });
    const client = fakeClient(sftp);

    const start = Date.now();
    await assert.rejects(
      manager.sftpWriteBuffer(client, "/remote/f", Buffer.alloc(4096), STALL_MS),
      (err: any) =>
        err?.code === "SSH_CONNECTION_FAILED" &&
        err?.retriable === true &&
        /stall/i.test(err.message),
    );
    assert.ok(Date.now() - start < 5000, "must abort quickly, not hang");
  });

  it("resolves when the write acks and closes", async () => {
    const ws = new HealthyWriteStream();
    const sftp = fakeSftp({ createWriteStream: () => ws });
    const client = fakeClient(sftp);

    await manager.sftpWriteBuffer(client, "/remote/f", Buffer.alloc(4096), STALL_MS);
  });
});

describe("sftpReadBuffer stall watchdog", () => {
  const manager = SSHConnectionManager.getInstance() as any;

  it("rejects with a retriable stall error when no data arrives", async () => {
    const rs = new StallReadStream();
    const sftp = fakeSftp({ createReadStream: () => rs });
    const client = fakeClient(sftp);

    const start = Date.now();
    await assert.rejects(
      manager.sftpReadBuffer(client, "/remote/f", 1024, STALL_MS),
      (err: any) =>
        err?.code === "SSH_CONNECTION_FAILED" &&
        err?.retriable === true &&
        /stall/i.test(err.message),
    );
    assert.ok(Date.now() - start < 5000, "must abort quickly, not hang");
  });

  it("resolves with the concatenated bytes when data streams to end", async () => {
    const payload = Buffer.from("hello world");
    // Construct lazily so emission (setImmediate) fires after listeners attach.
    const sftp = fakeSftp({
      createReadStream: () => new HealthyReadStream([payload.subarray(0, 5), payload.subarray(5)]),
    });
    const client = fakeClient(sftp);

    const result: Buffer = await manager.sftpReadBuffer(
      client,
      "/remote/f",
      payload.length,
      STALL_MS,
    );
    assert.ok(result.equals(payload));
  });
});

describe("pipeWithInactivityTimeout watchdog", () => {
  const manager = SSHConnectionManager.getInstance() as any;

  it("rejects with a retriable stall error when the pipe makes no progress", async () => {
    const rs = new StallReadStream();
    const ws = new StallWriteStream();

    const start = Date.now();
    await assert.rejects(
      manager.pipeWithInactivityTimeout(
        rs,
        ws,
        STALL_MS,
        "test pipe",
        undefined,
        (e: Error) => e,
        (e: Error) => e,
      ),
      (err: any) => err?.code === "SSH_CONNECTION_FAILED" && err?.retriable === true,
    );
    assert.ok(Date.now() - start < 5000, "must abort quickly, not hang");
  });

  it("resolves when the write side finishes", async () => {
    const rs = new HealthyReadStream([Buffer.from("a")]);
    const ws = new HealthyWriteStream();
    const p = manager.pipeWithInactivityTimeout(
      rs,
      ws,
      STALL_MS,
      "test pipe",
      undefined,
      (e: Error) => e,
      (e: Error) => e,
    );
    // Healthy read emits data (progress) then the write finishes on its own end,
    // but pipe() is faked, so emit finish explicitly to close the write side.
    queueMicrotask(() => ws.emit("finish"));
    await p;
  });
});
