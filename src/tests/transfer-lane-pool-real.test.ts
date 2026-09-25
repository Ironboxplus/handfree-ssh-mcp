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
import { registerCloseConnectionTool } from "../tools/close-connection.js";
import { registerDownloadTool } from "../tools/download.js";
import { registerTransferTool } from "../tools/transfer.js";
import { registerUploadTool } from "../tools/upload.js";
import { RealSshTestServer } from "./helpers/real-ssh-server.js";

/**
 * Transfer-lane pool (SshConnectionPool.reserveTransferLanes /
 * openTransferLanes): the independent connections a connections=N download,
 * upload or relay runs on are pooled per server, so a repeated transfer skips
 * the N handshakes, while a per-server budget of 8 bounds how many exist.
 * Two real in-process ssh2/SFTP servers, real files, no mocks; every
 * connection count below is the SERVER's own count of accepted TCP
 * connections.
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

async function waitFor(condition: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("transfer-lane pool real execution", { concurrency: false }, () => {
  const manager = SSHConnectionManager.getInstance();
  const pool = manager["pool"];
  const suiteRoot = fs.mkdtempSync(path.join(os.tmpdir(), "handfree-lane-pool-"));
  const localRoot = path.join(suiteRoot, "local");
  const server = new RealSshTestServer(path.join(suiteRoot, "server"));
  const peer = new RealSshTestServer(path.join(suiteRoot, "peer"));
  const mcpServer = new McpServer({ name: "lane-pool-test", version: "1.0.0" });
  const mcpClient = new Client({ name: "lane-pool-client", version: "1.0.0" });

  const seed = (target: RealSshTestServer, remotePath: string, data: Buffer): void => {
    fs.writeFileSync(target.toLocalPath(remotePath), data);
  };
  const download = (remotePath: string, localName: string, args: Record<string, unknown> = {}) =>
    mcpClient.callTool({
      name: "download",
      arguments: { remotePath, localPath: path.join(localRoot, localName), connectionName: "lanes", timeout: 10000, ...args },
    });
  const assertDownloaded = (result: Awaited<ReturnType<Client["callTool"]>>, remotePath: string, localName: string) => {
    assert.equal(result.isError, undefined, responseText(result));
    assert.equal(
      sha256(fs.readFileSync(path.join(localRoot, localName))),
      sha256(fs.readFileSync(server.toLocalPath(remotePath))),
    );
  };
  // Cold start: no pooled lane and no cached client left from an earlier test.
  const coldStart = async () => {
    manager.disconnect();
    await waitFor(() => server.liveConnectionCount === 0 && peer.liveConnectionCount === 0, "all connections closed");
    server.resetConnectionCount();
    peer.resetConnectionCount();
  };

  before(async () => {
    fs.mkdirSync(localRoot, { recursive: true });
    await server.start();
    await peer.start();
    const common = { host: "127.0.0.1", username: "test", password: "test", disableSftpPathPolicy: true, keepaliveInterval: 0 };
    manager.setConfig({
      lanes: { ...common, port: server.port },
      peer: { ...common, port: peer.port },
    }, ["lanes", "peer"]);
    registerDownloadTool(mcpServer);
    registerUploadTool(mcpServer);
    registerTransferTool(mcpServer);
    registerCloseConnectionTool(mcpServer);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await mcpServer.connect(serverTransport);
    await mcpClient.connect(clientTransport);
  });

  after(async () => {
    manager.disconnect();
    await Promise.all([mcpClient.close(), mcpServer.close()]);
    await server.stop();
    await peer.stop();
    fs.rmSync(suiteRoot, { recursive: true, force: true });
    manager.setConfig({}, undefined);
  });

  test("grey-box: a repeated connections=4 download reuses the pooled lanes -- zero new connections", async () => {
    seed(server, "/reuse.bin", randomBytes(700_001));
    await coldStart();
    assertDownloaded(await download("/reuse.bin", "reuse-1.bin", { connections: 4 }), "/reuse.bin", "reuse-1.bin");
    assert.equal(server.stats.connectionCount, 4);
    assert.equal(pool.idleTransferLaneCount("lanes"), 4, "a successful transfer parks its lanes");

    server.resetConnectionCount();
    const second = await download("/reuse.bin", "reuse-2.bin", { connections: 4, vvv: true });
    assertDownloaded(second, "/reuse.bin", "reuse-2.bin");
    assert.equal(server.stats.connectionCount, 0, "the second download must not open a single new connection");
    assert.match(responseText(second), /transfer lanes for \[lanes\]: 4 reused, 0 opened/);
  });

  test("grey-box: lanes are per server, not per operation -- an upload reuses a download's lanes", async () => {
    seed(server, "/shared.bin", randomBytes(300_000));
    await coldStart();
    assertDownloaded(await download("/shared.bin", "shared.bin", { connections: 4 }), "/shared.bin", "shared.bin");
    server.resetConnectionCount();
    const data = randomBytes(500_003);
    const localPath = path.join(localRoot, "up.bin");
    fs.writeFileSync(localPath, data);
    const result = await mcpClient.callTool({
      name: "upload",
      arguments: { localPath, remotePath: "/up.bin", connectionName: "lanes", connections: 4, timeout: 10000 },
    });
    assert.equal(result.isError, undefined, responseText(result));
    assert.equal(sha256(fs.readFileSync(server.toLocalPath("/up.bin"))), sha256(data));
    assert.equal(server.stats.connectionCount, 0);
  });

  test("grey-box: idle lanes are closed after the idle timeout", async () => {
    seed(server, "/idle.bin", randomBytes(200_000));
    await coldStart();
    pool.setTransferLaneIdleMs(200);
    try {
      assertDownloaded(await download("/idle.bin", "idle.bin", { connections: 3 }), "/idle.bin", "idle.bin");
      assert.equal(pool.idleTransferLaneCount("lanes"), 3);
      await waitFor(() => pool.idleTransferLaneCount("lanes") === 0, "idle lanes expired");
      await waitFor(() => server.liveConnectionCount === 0, "expired lanes closed on the server side");
    } finally {
      pool.setTransferLaneIdleMs(60_000);
    }
  });

  test("failure/cleanup: lanes the server dropped while idle leave the pool, and the next transfer opens fresh ones", async () => {
    seed(server, "/dropped.bin", randomBytes(400_000));
    await coldStart();
    assertDownloaded(await download("/dropped.bin", "dropped-1.bin", { connections: 4 }), "/dropped.bin", "dropped-1.bin");
    assert.equal(pool.idleTransferLaneCount("lanes"), 4);
    server.dropAllConnections();
    await waitFor(() => pool.idleTransferLaneCount("lanes") === 0, "dropped lanes removed from the pool");

    server.resetConnectionCount();
    assertDownloaded(await download("/dropped.bin", "dropped-2.bin", { connections: 4 }), "/dropped.bin", "dropped-2.bin");
    assert.equal(server.stats.connectionCount, 4);
  });

  test("failure/cleanup: a pooled lane that can no longer open SFTP is replaced and the transfer still succeeds", async () => {
    seed(server, "/stale.bin", randomBytes(300_007));
    await coldStart();
    assertDownloaded(await download("/stale.bin", "stale-1.bin", { connections: 2 }), "/stale.bin", "stale-1.bin");
    // Connections 0 and 1 are the two pooled lanes: still up, but refusing
    // SFTP from now on -- dead to a transfer without the pool knowing it.
    server.setRejectSftpForConnectionIndices([0, 1]);
    try {
      const result = await download("/stale.bin", "stale-2.bin", { connections: 2, vvv: true });
      assertDownloaded(result, "/stale.bin", "stale-2.bin");
      assert.equal(server.stats.connectionCount, 4, "exactly one replacement connection per dead lane");
      assert.equal((responseText(result).match(/was dead; replaced with a fresh connection/g) ?? []).length, 2);
      assert.equal(pool.idleTransferLaneCount("lanes"), 2, "the replacements are pooled");
      await waitFor(() => server.liveConnectionCount === 2, "the dead lanes closed");
    } finally {
      server.setRejectSftpForConnectionIndices(null);
    }
  });

  test("failure/cleanup: a failed transfer closes its lanes instead of pooling them", async () => {
    seed(server, "/fails.bin", randomBytes(600_000));
    await coldStart();
    assertDownloaded(await download("/fails.bin", "fails-1.bin", { connections: 4 }), "/fails.bin", "fails-1.bin");
    assert.equal(pool.idleTransferLaneCount("lanes"), 4);
    server.injectReadFailureForConnectionIndex([2]);
    try {
      const result = await download("/fails.bin", "fails-2.bin", { connections: 4 });
      assert.equal(result.isError, true, responseText(result));
      assert.equal(pool.idleTransferLaneCount("lanes"), 0);
      await waitFor(() => server.liveConnectionCount === 0, "every lane of the failed transfer closed");
    } finally {
      server.clearReadFailureForConnectionIndex();
    }
  });

  test("black-box: reuseConnection=false bypasses the pool -- fresh connections, closed afterwards", async () => {
    seed(server, "/fresh.bin", randomBytes(250_000));
    await coldStart();
    assertDownloaded(await download("/fresh.bin", "fresh-1.bin", { connections: 4 }), "/fresh.bin", "fresh-1.bin");
    server.resetConnectionCount();
    const result = await download("/fresh.bin", "fresh-2.bin", { connections: 4, reuseConnection: false });
    assertDownloaded(result, "/fresh.bin", "fresh-2.bin");
    assert.equal(server.stats.connectionCount, 4, "reuseConnection=false must not take pooled lanes");
    assert.equal(pool.idleTransferLaneCount("lanes"), 4, "the pooled lanes are untouched");
    await waitFor(() => server.liveConnectionCount === 4, "the fresh connections closed, not pooled");
  });

  test("black-box: close-connection closes the server's idle lanes too", async () => {
    seed(server, "/closeconn.bin", randomBytes(250_000));
    await coldStart();
    assertDownloaded(await download("/closeconn.bin", "closeconn-1.bin", { connections: 4 }), "/closeconn.bin", "closeconn-1.bin");
    assert.equal(pool.idleTransferLaneCount("lanes"), 4);
    const closed = await mcpClient.callTool({ name: "close-connection", arguments: { connectionName: "lanes" } });
    assert.equal(closed.isError, undefined, responseText(closed));
    assert.equal(pool.idleTransferLaneCount("lanes"), 0);
    await waitFor(() => server.liveConnectionCount === 0, "idle lanes closed on the server side");
    server.resetConnectionCount();
    assertDownloaded(await download("/closeconn.bin", "closeconn-2.bin", { connections: 4 }), "/closeconn.bin", "closeconn-2.bin");
    assert.equal(server.stats.connectionCount, 4);
  });

  test("grey-box: two concurrent connections=8 downloads stay within the per-server budget of 8 -- the second waits, then reuses", async () => {
    seed(server, "/budget.bin", randomBytes(900_000));
    await coldStart();
    // A real handshake duration, so the second transfer is genuinely
    // waiting while the first's lanes are being set up.
    server.setAuthDelayMs(200);
    try {
      const [first, second] = await Promise.all([
        download("/budget.bin", "budget-1.bin", { connections: 8 }),
        download("/budget.bin", "budget-2.bin", { connections: 8 }),
      ]);
      assertDownloaded(first, "/budget.bin", "budget-1.bin");
      assertDownloaded(second, "/budget.bin", "budget-2.bin");
      assert.ok(server.stats.maxLiveConnections <= 8, `peak ${server.stats.maxLiveConnections} live connections, budget is 8`);
      assert.equal(server.stats.connectionCount, 8, "the second download ran on the first one's released lanes");
    } finally {
      server.setAuthDelayMs(0);
    }
  });

  test("black-box: opposite-direction connections=8 relays run concurrently without deadlocking on each other's budget", async () => {
    const forward = randomBytes(600_011);
    const backward = randomBytes(500_009);
    seed(server, "/fwd.bin", forward);
    seed(peer, "/bwd.bin", backward);
    await coldStart();
    const relay = (sourceServer: string, destServer: string, remotePath: string) =>
      mcpClient.callTool({
        name: "transfer",
        arguments: {
          mode: "relay", sourceServer, destServer, sourceRemotePath: remotePath, destRemotePath: remotePath,
          connections: 8, timeout: 10000,
        },
      });
    let timer: NodeJS.Timeout | undefined;
    const deadlock = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("relays did not finish: deadlocked on the lane budget")), 8000);
    });
    try {
      const [ab, ba] = await Promise.race([
        Promise.all([relay("lanes", "peer", "/fwd.bin"), relay("peer", "lanes", "/bwd.bin")]),
        deadlock,
      ]);
      assert.equal(ab.isError, undefined, responseText(ab));
      assert.equal(ba.isError, undefined, responseText(ba));
    } finally {
      clearTimeout(timer);
    }
    assert.equal(sha256(fs.readFileSync(peer.toLocalPath("/fwd.bin"))), sha256(forward));
    assert.equal(sha256(fs.readFileSync(server.toLocalPath("/bwd.bin"))), sha256(backward));
    assert.ok(server.stats.maxLiveConnections <= 8 && peer.stats.maxLiveConnections <= 8);
  });
});
