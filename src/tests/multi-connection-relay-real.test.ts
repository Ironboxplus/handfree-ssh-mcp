import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSHConnectionManager } from "../services/ssh-connection-manager.js";
import { registerTransferTool } from "../tools/transfer.js";
import { RealSshTestServer } from "./helpers/real-ssh-server.js";

/**
 * Multi-connection relay (PLAN.MD P1-06): remote A -> remote B through this
 * host over N PAIRS of independent TCP+SSH connections -- N to the source,
 * N to the destination -- each pair carrying one non-overlapping byte range.
 * Two real in-process ssh2/SFTP servers, real files, no mocks. Correctness
 * only; throughput comes from the real netem lab (P1-06-A3).
 *
 * The fixture's RENAME refuses to overwrite (OpenSSH semantics) and cannot
 * advertise posix-rename, so replacing an existing target here exercises the
 * remove-then-rename fallback.
 */

function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function responseText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = result.content as Array<{ type: string; text?: string }>;
  return content
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .filter((text): text is string => typeof text === "string")
    .join("\n");
}

function assertRequestsCoverFileExactly(requests: Array<{ offset: number; length: number }>, totalSize: number, what: string): void {
  assert.ok(requests.length > 0, `expected at least one real ${what} request`);
  const sorted = [...requests].sort((a, b) => a.offset - b.offset);
  let runningOffset = 0;
  for (const request of sorted) {
    assert.equal(request.offset, runningOffset, `real ${what} at ${request.offset} is not contiguous with ${runningOffset}`);
    runningOffset += request.length;
  }
  assert.equal(runningOffset, totalSize, `real ${what} requests covered ${runningOffset} bytes, expected ${totalSize}`);
}

function tempLeftovers(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((name) => name.includes(".handfree-"));
}

describe("multi-connection relay real execution", { concurrency: false }, () => {
  const manager = SSHConnectionManager.getInstance();
  const suiteRoot = fs.mkdtempSync(path.join(os.tmpdir(), "handfree-multiconn-relay-"));
  const sourceRoot = path.join(suiteRoot, "source");
  const destRoot = path.join(suiteRoot, "dest");
  const source = new RealSshTestServer(sourceRoot);
  const dest = new RealSshTestServer(destRoot);
  const mcpServer = new McpServer({ name: "multiconn-relay-test", version: "1.0.0" });
  const mcpClient = new Client({ name: "multiconn-relay-client", version: "1.0.0" });

  const relay = (args: Record<string, unknown>) =>
    mcpClient.callTool({
      name: "transfer",
      arguments: { mode: "relay", sourceServer: "src", destServer: "dst", timeout: 10000, ...args },
    });
  const seedSource = (remotePath: string, data: Buffer): void => {
    fs.writeFileSync(source.toLocalPath(remotePath), data);
  };
  const resetBoth = () => {
    for (const server of [source, dest]) {
      server.resetConnectionCount();
      server.resetReadLog();
      server.resetWriteLog();
    }
  };
  const waitForNoLiveConnections = async () => {
    const deadline = Date.now() + 3000;
    while ((source.liveConnectionCount > 0 || dest.liveConnectionCount > 0) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };

  before(async () => {
    await source.start();
    await dest.start();
    const common = { host: "127.0.0.1", username: "test", password: "test", disableSftpPathPolicy: true, keepaliveInterval: 0 };
    manager.setConfig({
      src: { ...common, port: source.port },
      dst: { ...common, port: dest.port },
    }, ["src", "dst"]);
    registerTransferTool(mcpServer);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await mcpServer.connect(serverTransport);
    await mcpClient.connect(clientTransport);
  });

  after(async () => {
    manager.disconnect();
    await Promise.all([mcpClient.close(), mcpServer.close()]);
    await source.stop();
    await dest.stop();
    fs.rmSync(suiteRoot, { recursive: true, force: true });
    manager.setConfig({}, undefined);
  });

  test("black-box: connections=4 relays a byte-identical file of a non-round size, verified by md5", async () => {
    const data = randomBytes(3 * 1024 * 1024 + 777);
    seedSource("/big.bin", data);

    const result = await relay({ sourceRemotePath: "/big.bin", destRemotePath: "/big.bin", connections: 4 });
    assert.equal(result.isError, undefined, responseText(result));
    assert.match(responseText(result), /via 4 independent connection pair\(s\)/);
    assert.match(responseText(result), /md5=[0-9a-f]{32} ✓/);
    assert.equal(sha256(fs.readFileSync(dest.toLocalPath("/big.bin"))), sha256(data));
    assert.deepEqual(tempLeftovers(destRoot), []);
  });

  test("black-box: an existing different target is replaced, with no temp file left", async () => {
    fs.writeFileSync(dest.toLocalPath("/replace.bin"), Buffer.from("old destination contents"));
    const data = randomBytes(700_001);
    seedSource("/replace.bin", data);

    const result = await relay({ sourceRemotePath: "/replace.bin", destRemotePath: "/replace.bin", connections: 4 });
    assert.equal(result.isError, undefined, responseText(result));
    assert.equal(sha256(fs.readFileSync(dest.toLocalPath("/replace.bin"))), sha256(data));
    assert.deepEqual(tempLeftovers(destRoot), []);
  });

  test("grey-box: 4 real connections on EACH side, with every handshake concurrent", async () => {
    seedSource("/pairs.bin", randomBytes(900_000));
    source.setAuthDelayMs(300);
    dest.setAuthDelayMs(300);
    try {
      resetBoth();
      const result = await relay({ sourceRemotePath: "/pairs.bin", destRemotePath: "/pairs.bin", connections: 4, skipIfIdentical: false });
      assert.equal(result.isError, undefined, responseText(result));
      for (const [name, server] of [["source", source], ["dest", dest]] as const) {
        assert.equal(server.stats.connectionCount, 4, `${name}: expected exactly 4 distinct real TCP+SSH connections`);
        assert.equal(server.stats.maxActiveHandshakes, 4, `${name}: expected all 4 handshakes in flight at once`);
      }
    } finally {
      source.setAuthDelayMs(0);
      dest.setAuthDelayMs(0);
    }
  });

  test("grey-box: source READs and destination WRITEs are each non-overlapping, exact, and spread over every connection", async () => {
    const size = 500_003;
    seedSource("/coverage.bin", randomBytes(size));
    resetBoth();
    const result = await relay({ sourceRemotePath: "/coverage.bin", destRemotePath: "/coverage.bin", connections: 4, skipIfIdentical: false });
    assert.equal(result.isError, undefined, responseText(result));
    assertRequestsCoverFileExactly(source.stats.readRequests, size, "source READ");
    assertRequestsCoverFileExactly(dest.stats.writeRequests, size, "destination WRITE");
    const writers = new Set(dest.stats.writeRequests.map((write) => write.connectionIndex));
    assert.equal(writers.size, 4, "every one of the 4 destination connections must have written its own range");
  });

  test("failure/cleanup: a destination write failure keeps the old target, deletes the temp, closes both sides, and names the destination", async () => {
    const original = Buffer.from("destination contents that must survive");
    fs.writeFileSync(dest.toLocalPath("/dst-fail.bin"), original);
    seedSource("/dst-fail.bin", randomBytes(600_000));

    manager.disconnect();
    await waitForNoLiveConnections();
    dest.setFailWritesForConnectionIndices([2]);
    try {
      resetBoth();
      const result = await relay({ sourceRemotePath: "/dst-fail.bin", destRemotePath: "/dst-fail.bin", connections: 4, skipIfIdentical: false });
      assert.equal(result.isError, true);
      assert.match(responseText(result), /Dest write error/);
      assert.deepEqual(fs.readFileSync(dest.toLocalPath("/dst-fail.bin")), original, "the target must be untouched");
      assert.deepEqual(tempLeftovers(destRoot), [], "the destination temp file must be deleted");
      await waitForNoLiveConnections();
      assert.equal(source.liveConnectionCount, 0, "every source connection must be closed");
      assert.equal(dest.liveConnectionCount, 0, "every destination connection must be closed");
    } finally {
      dest.setFailWritesForConnectionIndices(null);
    }
  });

  test("failure/cleanup: a source read failure keeps the old target, deletes the temp, closes both sides, and names the source", async () => {
    const original = Buffer.from("another destination that must survive");
    fs.writeFileSync(dest.toLocalPath("/src-fail.bin"), original);
    seedSource("/src-fail.bin", randomBytes(600_000));

    manager.disconnect();
    await waitForNoLiveConnections();
    source.injectReadFailureForConnectionIndex([1]);
    try {
      resetBoth();
      const result = await relay({ sourceRemotePath: "/src-fail.bin", destRemotePath: "/src-fail.bin", connections: 4, skipIfIdentical: false });
      assert.equal(result.isError, true);
      assert.match(responseText(result), /Source read error/);
      assert.deepEqual(fs.readFileSync(dest.toLocalPath("/src-fail.bin")), original);
      assert.deepEqual(tempLeftovers(destRoot), []);
      await waitForNoLiveConnections();
      assert.equal(source.liveConnectionCount, 0);
      assert.equal(dest.liveConnectionCount, 0);
    } finally {
      source.clearReadFailureForConnectionIndex();
    }
  });

  test("failure/cleanup: one destination handshake failing leaves no connection open on either side", async () => {
    seedSource("/handshake.bin", randomBytes(100_000));
    manager.disconnect();
    await waitForNoLiveConnections();
    source.setAuthDelayMs(200);
    dest.setRejectAuthForConnectionIndices([3]);
    try {
      resetBoth();
      const result = await relay({ sourceRemotePath: "/handshake.bin", destRemotePath: "/handshake.bin", connections: 4 });
      assert.equal(result.isError, true);
      assert.deepEqual(dest.stats.writeRequests, []);
      assert.equal(fs.existsSync(dest.toLocalPath("/handshake.bin")), false);
      await waitForNoLiveConnections();
      assert.equal(source.liveConnectionCount, 0, "source connections that came up must be closed");
      assert.equal(dest.liveConnectionCount, 0, "destination connections that came up must be closed");
    } finally {
      source.setAuthDelayMs(0);
      dest.setRejectAuthForConnectionIndices(null);
    }
  });

  test("black-box: skip-if-identical still applies -- an identical destination is skipped with zero WRITEs", async () => {
    const data = randomBytes(300_000);
    seedSource("/same.bin", data);
    fs.writeFileSync(dest.toLocalPath("/same.bin"), data);
    resetBoth();
    const result = await relay({ sourceRemotePath: "/same.bin", destRemotePath: "/same.bin", connections: 4 });
    assert.equal(result.isError, undefined, responseText(result));
    assert.match(responseText(result), /^Transfer skipped: destination already identical/);
    assert.deepEqual(dest.stats.writeRequests, []);
  });

  test("black-box: self-relay (source and destination are the same server) uses N connections, not 2N", async () => {
    const data = randomBytes(400_009);
    seedSource("/self-in.bin", data);
    source.resetConnectionCount();
    const result = await mcpClient.callTool({
      name: "transfer",
      arguments: {
        mode: "relay", sourceServer: "src", destServer: "src",
        sourceRemotePath: "/self-in.bin", destRemotePath: "/self-out.bin", connections: 3, timeout: 10000,
      },
    });
    assert.equal(result.isError, undefined, responseText(result));
    assert.equal(sha256(fs.readFileSync(source.toLocalPath("/self-out.bin"))), sha256(data));
    assert.equal(source.stats.connectionCount, 3, "self-relay: one connection per pair, carrying both a read and a write channel");
  });

  test("black-box: a file smaller than the pair count and an empty file both land correctly", async () => {
    seedSource("/tiny.bin", Buffer.from([7, 8, 9]));
    resetBoth();
    const tiny = await relay({ sourceRemotePath: "/tiny.bin", destRemotePath: "/tiny.bin", connections: 8, skipIfIdentical: false });
    assert.equal(tiny.isError, undefined, responseText(tiny));
    assert.deepEqual(fs.readFileSync(dest.toLocalPath("/tiny.bin")), Buffer.from([7, 8, 9]));
    assert.equal(dest.stats.writeRequests.length, 3, "a 3-byte file runs exactly 3 one-byte ranges, no empty worker");

    seedSource("/empty.bin", Buffer.alloc(0));
    const empty = await relay({ sourceRemotePath: "/empty.bin", destRemotePath: "/empty.bin", connections: 4, skipIfIdentical: false });
    assert.equal(empty.isError, undefined, responseText(empty));
    assert.equal(fs.statSync(dest.toLocalPath("/empty.bin")).size, 0);
  });

  test("black-box: connections is rejected with strategy direct/auto and with archive, before any connection opens", async () => {
    seedSource("/reject.bin", randomBytes(1000));
    manager.disconnect();
    resetBoth();
    for (const extra of [{ strategy: "direct" }, { strategy: "auto" }, { archive: true }]) {
      const result = await relay({ sourceRemotePath: "/reject.bin", destRemotePath: "/reject.bin", connections: 2, ...extra });
      assert.equal(result.isError, true, `connections with ${JSON.stringify(extra)} must be rejected`);
      assert.match(responseText(result), /connections/);
    }
    const tooMany = await relay({ sourceRemotePath: "/reject.bin", destRemotePath: "/reject.bin", connections: 9 });
    assert.equal(tooMany.isError, true);
    assert.match(responseText(tooMany), /must not exceed 8/);
    assert.equal(source.stats.connectionCount, 0, "a rejected request must not open any source connection");
    assert.equal(dest.stats.connectionCount, 0, "a rejected request must not open any destination connection");
  });

  test("black-box: omitting connections keeps the existing single-connection relay response", async () => {
    const data = randomBytes(10_000);
    seedSource("/default.bin", data);
    const result = await relay({ sourceRemotePath: "/default.bin", destRemotePath: "/default.bin", skipIfIdentical: false });
    assert.equal(result.isError, undefined, responseText(result));
    assert.match(responseText(result), /^Transfer complete \(windowed via SFTP, verified: /);
    assert.equal(sha256(fs.readFileSync(dest.toLocalPath("/default.bin"))), sha256(data));
  });
});
