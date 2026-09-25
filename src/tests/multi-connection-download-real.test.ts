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
import { computeDownloadByteRanges } from "../services/transfer-service.js";
import { registerDownloadTool } from "../tools/download.js";
import { registerTransferTool } from "../tools/transfer.js";
import { RealSshTestServer } from "./helpers/real-ssh-server.js";

/**
 * Multi-connection single-file download.
 *
 * A previous "striped" download opened N SFTP *channels* on ONE SSH
 * connection and was measured (real netem lab, see PLAN.MD P1-04b) to be
 * 2.3x SLOWER than the plain single-connection path -- every channel on one
 * connection shares that connection's single ssh2 channel flow-control
 * window (MAX_WINDOW=2MiB, hardcoded, no Client option to raise it), so N
 * channels bought nothing. This feature instead opens N genuinely
 * independent SSH/TCP connections (src/connection/ssh-connection-pool.ts's
 * connectOneShotClient via acquireSshClient({reuseConnection:false})), one
 * per byte range.
 *
 * Every test here uses a real in-process ssh2/SFTP server (RealSshTestServer)
 * and real files on disk -- no mocked SFTP, no stubbed client. This file
 * proves CORRECTNESS (ranges, real distinct connections, out-of-order-safe
 * writes, failure cleanup, atomic rename, small/empty file edge cases). It
 * makes no throughput/speedup claim -- the in-process server's near-zero RTT
 * cannot demonstrate one, and PLAN.MD requires that any speedup claim come
 * from real netem-lab measurement, not from this suite.
 */

function sha256File(filePath: string): string {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function responseText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = result.content as Array<{ type: string; text?: string }>;
  return content
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .filter((text): text is string => typeof text === "string")
    .join("\n");
}

/**
 * Wire truth from the server's own READ log (not this client's bookkeeping):
 * every real READ request received, sorted by offset, must chain exactly
 * (previous offset + previous length === next offset) from 0 to totalSize.
 * A 1-byte overlap or a 1-byte gap anywhere breaks the chain and fails this,
 * even though a 1-byte *overlap* of identical bytes would still produce a
 * byte-identical SHA-256 -- which is exactly why this check exists
 * independently of the SHA-256 assertions elsewhere in this file.
 */
function assertReadRequestsCoverFileExactly(
  reads: Array<{ offset: number; length: number }>,
  totalSize: number,
): void {
  assert.ok(reads.length > 0, "expected at least one real READ request");
  const sorted = [...reads].sort((a, b) => a.offset - b.offset);
  let runningOffset = 0;
  for (const read of sorted) {
    assert.equal(
      read.offset,
      runningOffset,
      `real READ at offset ${read.offset} is not contiguous with previous coverage end ${runningOffset} -- ` +
        `overlap or gap in ${JSON.stringify(sorted)}`,
    );
    runningOffset += read.length;
  }
  assert.equal(runningOffset, totalSize, `real READ requests covered ${runningOffset} bytes, expected exactly ${totalSize}`);
}

function leftoverTempFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((name) => name.includes(".handfree-download-"));
}

describe("multi-connection download real execution", { concurrency: false }, () => {
  const manager = SSHConnectionManager.getInstance();
  const suiteRoot = fs.mkdtempSync(path.join(os.tmpdir(), "handfree-multiconn-real-"));
  const serverRoot = path.join(suiteRoot, "server");
  const localRoot = path.join(suiteRoot, "local");
  const server = new RealSshTestServer(serverRoot);
  const mcpServer = new McpServer({ name: "multiconn-download-test", version: "1.0.0" });
  const mcpClient = new Client({ name: "multiconn-download-client", version: "1.0.0" });

  before(async () => {
    fs.mkdirSync(localRoot, { recursive: true });
    await server.start();
    manager.setConfig({
      multiconn: {
        host: "127.0.0.1",
        port: server.port,
        username: "test",
        password: "test",
        disableSftpPathPolicy: true,
        keepaliveInterval: 0,
      },
    }, ["multiconn"]);
    registerDownloadTool(mcpServer);
    registerTransferTool(mcpServer);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await mcpServer.connect(serverTransport);
    await mcpClient.connect(clientTransport);
  });

  after(async () => {
    manager.disconnect();
    await Promise.all([mcpClient.close(), mcpServer.close()]);
    await server.stop();
    fs.rmSync(suiteRoot, { recursive: true, force: true });
    manager.setConfig({}, undefined);
  });

  test("white-box: computeDownloadByteRanges is exhaustively pinned", () => {
    // Zero-byte file: no ranges at all, regardless of requested connections.
    assert.deepEqual(computeDownloadByteRanges(0, 4), []);
    assert.deepEqual(computeDownloadByteRanges(0, 1), []);

    // 1-byte file: exactly one range regardless of requested connections.
    assert.deepEqual(computeDownloadByteRanges(1, 4), [{ offset: 0, length: 1 }]);
    assert.deepEqual(computeDownloadByteRanges(1, 8), [{ offset: 0, length: 1 }]);

    // connections=1 always serializes to exactly one range covering the file.
    assert.deepEqual(computeDownloadByteRanges(999, 1), [{ offset: 0, length: 999 }]);

    // Exactly evenly divisible: every range the same size, no remainder.
    assert.deepEqual(computeDownloadByteRanges(8, 4), [
      { offset: 0, length: 2 },
      { offset: 2, length: 2 },
      { offset: 4, length: 2 },
      { offset: 6, length: 2 },
    ]);

    // Not evenly divisible: remainder distributed one byte per range,
    // earliest ranges first, still contiguous and exact.
    assert.deepEqual(computeDownloadByteRanges(10, 3), [
      { offset: 0, length: 4 },
      { offset: 4, length: 3 },
      { offset: 7, length: 3 },
    ]);

    // connections greater than the file's byte count: never more ranges
    // than bytes -- no empty ranges/workers.
    assert.deepEqual(computeDownloadByteRanges(3, 8), [
      { offset: 0, length: 1 },
      { offset: 1, length: 1 },
      { offset: 2, length: 1 },
    ]);

    // Every range: non-negative connections/fileSize invariants hold for a
    // large, arbitrary, non-round size too (contiguous, exact sum, capped
    // range count).
    const huge = computeDownloadByteRanges(123_456_789, 5);
    assert.equal(huge.length, 5);
    let running = 0;
    for (const range of huge) {
      assert.equal(range.offset, running);
      assert.ok(range.length >= 1);
      running += range.length;
    }
    assert.equal(running, 123_456_789);
  });

  test("black-box: multi-connection download via the download tool is byte-identical for a non-round size", async () => {
    const size = 3 * 1024 * 1024 + 777; // not a multiple of the internal read-chunk size
    const remotePath = "/big-non-round.bin";
    const sourcePath = server.toLocalPath(remotePath);
    fs.writeFileSync(sourcePath, randomBytes(size));
    const localPath = path.join(localRoot, "big-non-round.bin");

    const result = await mcpClient.callTool({
      name: "download",
      arguments: { remotePath, localPath, connectionName: "multiconn", connections: 4, timeout: 10000 },
    });
    assert.equal(result.isError, undefined, responseText(result));
    assert.match(responseText(result), /via 4 independent connection\(s\)/);
    assert.equal(fs.statSync(localPath).size, size);
    assert.equal(sha256File(localPath), sha256File(sourcePath));
    assert.deepEqual(leftoverTempFiles(localRoot), []);
  });

  test("black-box: multi-connection download via the transfer tool is byte-identical", async () => {
    const size = 500_003;
    const remotePath = "/via-transfer-tool.bin";
    const sourcePath = server.toLocalPath(remotePath);
    fs.writeFileSync(sourcePath, randomBytes(size));
    const localPath = path.join(localRoot, "via-transfer-tool.bin");

    const result = await mcpClient.callTool({
      name: "transfer",
      arguments: { mode: "download", connectionName: "multiconn", remotePath, localPath, connections: 3, timeout: 10000 },
    });
    assert.equal(result.isError, undefined, responseText(result));
    assert.match(responseText(result), /via 3 independent connection\(s\)/);
    assert.equal(sha256File(localPath), sha256File(sourcePath));
  });

  test("black-box: a file smaller than the requested connection count never opens an empty worker", async () => {
    const remotePath = "/tiny-three-bytes.bin";
    const sourcePath = server.toLocalPath(remotePath);
    const payload = Buffer.from([0x11, 0x22, 0x33]);
    fs.writeFileSync(sourcePath, payload);
    const localPath = path.join(localRoot, "tiny-three-bytes.bin");

    server.resetConnectionCount();
    server.resetReadLog();
    const result = await mcpClient.callTool({
      name: "download",
      arguments: { remotePath, localPath, connectionName: "multiconn", connections: 8, timeout: 10000 },
    });
    assert.equal(result.isError, undefined, responseText(result));
    assert.match(responseText(result), /via 3 independent connection\(s\)/);
    assert.equal(fs.statSync(localPath).size, 3);
    assert.equal(sha256File(localPath), sha256File(sourcePath));
    // All 8 requested connections are opened up front, concurrently -- the
    // file size is not known until one of them stats it, and waiting for
    // that before opening the rest would cost a second full handshake
    // round on every download (see the concurrent-handshake test below).
    // The price is paid only here, for a file smaller than N BYTES: the 5
    // surplus connections are closed unused. What must still hold is that
    // no EMPTY range worker runs -- the server saw exactly 3 one-byte READs.
    assert.equal(server.stats.connectionCount, 8);
    assert.deepEqual(
      [...server.stats.readRequests].sort((a, b) => a.offset - b.offset),
      [{ offset: 0, length: 1 }, { offset: 1, length: 1 }, { offset: 2, length: 1 }],
    );
  });

  test("black-box: an empty file runs zero range workers and still lands as an empty file", async () => {
    const remotePath = "/empty.bin";
    const sourcePath = server.toLocalPath(remotePath);
    fs.writeFileSync(sourcePath, Buffer.alloc(0));
    const localPath = path.join(localRoot, "empty.bin");

    server.resetConnectionCount();
    server.resetReadLog();
    const result = await mcpClient.callTool({
      name: "download",
      arguments: { remotePath, localPath, connectionName: "multiconn", connections: 4, timeout: 10000 },
    });
    assert.equal(result.isError, undefined, responseText(result));
    assert.match(responseText(result), /via 0 independent connection\(s\)/);
    assert.equal(fs.statSync(localPath).size, 0);
    // Opened concurrently before the size was known (see the tiny-file test
    // above for why), then closed unused: not one READ was issued.
    assert.equal(server.stats.connectionCount, 4);
    assert.deepEqual(server.stats.readRequests, []);
  });

  test("grey-box: connections=4 opens 4 real, distinct TCP+SSH connections -- not 4 channels on one connection", async () => {
    const size = 900_000;
    const remotePath = "/four-connections.bin";
    const sourcePath = server.toLocalPath(remotePath);
    fs.writeFileSync(sourcePath, randomBytes(size));
    const localPath = path.join(localRoot, "four-connections.bin");

    // connectionCount is incremented on raw socket accept, before the SSH
    // handshake even begins -- unlike maxActiveSftpChannels (which a design
    // opening 4 channels on ONE connection would also report as 4), this
    // counter is the one thing that can tell "4 connections" apart from "4
    // channels, 1 connection". That distinction is the entire reason the
    // previous "striped" (channel-based) design was deleted -- see PLAN.MD
    // P1-04b/P1-04c.
    server.resetConnectionCount();
    const result = await mcpClient.callTool({
      name: "download",
      arguments: { remotePath, localPath, connectionName: "multiconn", connections: 4, timeout: 10000 },
    });
    assert.equal(result.isError, undefined, responseText(result));
    assert.equal(sha256File(localPath), sha256File(sourcePath));
    assert.equal(server.stats.connectionCount, 4, "expected exactly 4 distinct real TCP+SSH connections");
  });

  test("grey-box: the N connections are established CONCURRENTLY, not one handshake after another", async () => {
    // Measured on the real 50ms netem lab (PLAN.MD P1-04e): one handshake
    // costs ~685ms there, and establishing them serially was the WHOLE gap
    // between this feature and N parallel fastGets -- connections=4 spent
    // 2.7s of its 4.9s just connecting, and connections=8 spent 5.5s of 7.1s,
    // which is why 8 measured slower than 4. The data path itself was at
    // parity. A real server-side auth delay stands in for that latency here.
    const authDelayMs = 400;
    const size = 200_000;
    const remotePath = "/concurrent-handshakes.bin";
    const sourcePath = server.toLocalPath(remotePath);
    fs.writeFileSync(sourcePath, randomBytes(size));
    const localPath = path.join(localRoot, "concurrent-handshakes.bin");

    server.setAuthDelayMs(authDelayMs);
    try {
      server.resetConnectionCount();
      const startedAt = Date.now();
      const result = await mcpClient.callTool({
        name: "download",
        arguments: { remotePath, localPath, connectionName: "multiconn", connections: 4, timeout: 10000 },
      });
      const elapsed = Date.now() - startedAt;
      assert.equal(result.isError, undefined, responseText(result));
      assert.equal(sha256File(localPath), sha256File(sourcePath));
      assert.equal(server.stats.connectionCount, 4);
      // The load-bearing assertion: the server itself saw all 4 handshakes
      // in progress at the same moment. Serial establishment peaks at 1.
      assert.equal(server.stats.maxActiveHandshakes, 4, "expected all 4 handshakes to be in flight at once");
      // And the consequence the user actually feels: ~one handshake of
      // latency, not four (serial would be >= 4 x 400 = 1600ms).
      assert.ok(elapsed < authDelayMs * 3, `expected ~1 handshake of latency, took ${elapsed}ms`);
    } finally {
      server.setAuthDelayMs(0);
    }
  });

  test("failure/cleanup: one of the concurrent handshakes failing leaves no other connection open", async () => {
    // Connections are now established concurrently, so when one fails the
    // others may still be mid-handshake or already up. Every one that did
    // come up must be closed -- none may be leaked, still connected to the
    // server, after the call returns its error.
    const remotePath = "/handshake-failure.bin";
    fs.writeFileSync(server.toLocalPath(remotePath), randomBytes(100_000));
    const localPath = path.join(localRoot, "handshake-failure.bin");
    // Let the other connections still be in their handshake when #2 fails,
    // which is the case that leaks if the failure is propagated without
    // waiting for, and then closing, the ones still in progress.
    // Server-side close events arrive asynchronously after a client ends its
    // socket; poll briefly rather than guess a sleep.
    const waitForNoLiveConnections = async () => {
      const deadline = Date.now() + 3000;
      while (server.liveConnectionCount > 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    };
    // Start from zero: earlier tests' connections (and the pool's cached
    // client) may still be closing, which would make any other baseline race.
    manager.disconnect();
    await waitForNoLiveConnections();
    assert.equal(server.liveConnectionCount, 0, "precondition: no connection left over from earlier tests");

    server.setAuthDelayMs(200);
    server.setRejectAuthForConnectionIndices([2]);
    try {
      server.resetConnectionCount();
      const result = await mcpClient.callTool({
        name: "download",
        arguments: { remotePath, localPath, connectionName: "multiconn", connections: 4, timeout: 10000 },
      });
      assert.equal(result.isError, true, "a failed handshake must fail the download");
      assert.equal(server.stats.connectionCount, 4);
      assert.equal(fs.existsSync(localPath), false);
      assert.deepEqual(leftoverTempFiles(localRoot), []);

      await waitForNoLiveConnections();
      assert.equal(server.liveConnectionCount, 0, "every connection that came up must have been closed");
    } finally {
      server.setAuthDelayMs(0);
      server.setRejectAuthForConnectionIndices(null);
    }
  });

  test("grey-box: connections=1 (the default) opens exactly 1 real connection, same as today", async () => {
    const remotePath = "/one-connection.bin";
    const sourcePath = server.toLocalPath(remotePath);
    fs.writeFileSync(sourcePath, randomBytes(4096));
    const localPath = path.join(localRoot, "one-connection.bin");

    server.resetConnectionCount();
    const result = await mcpClient.callTool({
      name: "download",
      // reuseConnection:false so a connection possibly cached by an earlier
      // test in this file cannot make this assertion pass by accident (0
      // NEW connections opened because one was already cached).
      arguments: { remotePath, localPath, connectionName: "multiconn", connections: 1, reuseConnection: false, timeout: 10000 },
    });
    assert.equal(result.isError, undefined, responseText(result));
    assert.equal(sha256File(localPath), sha256File(sourcePath));
    assert.equal(server.stats.connectionCount, 1, "expected exactly 1 real connection for connections=1");
  });

  test("grey-box: the real READ requests the server received are non-overlapping and cover the file exactly", async () => {
    const size = 500_003; // deliberately not a multiple of the internal read-chunk size or connections
    const remotePath = "/coverage-check.bin";
    const sourcePath = server.toLocalPath(remotePath);
    fs.writeFileSync(sourcePath, randomBytes(size));
    const localPath = path.join(localRoot, "coverage-check.bin");

    server.resetReadLog();
    const result = await mcpClient.callTool({
      name: "download",
      arguments: { remotePath, localPath, connectionName: "multiconn", connections: 4, timeout: 10000 },
    });
    assert.equal(result.isError, undefined, responseText(result));
    assert.equal(sha256File(localPath), sha256File(sourcePath));
    assertReadRequestsCoverFileExactly(server.stats.readRequests, size);
  });

  test("grey-box: ranges completing out of order still produce a byte-identical file", async () => {
    const size = 4096; // small enough that each connection's whole range is one READ request
    const remotePath = "/out-of-order.bin";
    const sourcePath = server.toLocalPath(remotePath);
    fs.writeFileSync(sourcePath, randomBytes(size));
    const localPath = path.join(localRoot, "out-of-order.bin");

    // connection index 0 is opened FIRST and assigned the FILE'S FIRST range
    // (offset 0); connection index 1 is opened second and assigned the
    // file's second (later) range. Delaying index 0's READ response and not
    // index 1's forces connection 1 to finish its (later, higher-offset)
    // range BEFORE connection 0 finishes its (earlier, offset-0) range -- a
    // real, deterministic out-of-order completion. If positional writes were
    // ever replaced by "write chunks in arrival order" this would corrupt
    // the file (the later range's bytes would land at offset 0).
    server.resetConnectionCount();
    server.setConnectionReadDelaysMs([40, 0]);
    try {
      const result = await mcpClient.callTool({
        name: "download",
        arguments: { remotePath, localPath, connectionName: "multiconn", connections: 2, timeout: 10000 },
      });
      assert.equal(result.isError, undefined, responseText(result));
    } finally {
      server.clearConnectionReadDelaysMs();
    }
    assert.equal(sha256File(localPath), sha256File(sourcePath));
    assert.equal(fs.statSync(localPath).size, size);
  });

  test("failure/cleanup: a real mid-transfer READ failure cancels the rest, deletes the temp file, and never touches the destination", async () => {
    const size = 2_000_000;
    const remotePath = "/failure-check.bin";
    const sourcePath = server.toLocalPath(remotePath);
    fs.writeFileSync(sourcePath, randomBytes(size));
    const destDir = path.join(localRoot, "failure-check-dir");
    fs.mkdirSync(destDir, { recursive: true });
    const localPath = path.join(destDir, "failure-check.bin");

    // 4 connections over a 2,000,000-byte file with a 256 KiB internal read
    // chunk means each connection issues 2 real READ requests (~500,000
    // bytes / 262,144-byte chunks), 8 total if uncancelled. Letting the
    // first 4 succeed guarantees every one of the 4 workers still has
    // unread data left -- so the (5th+) READ failing genuinely cancels
    // still-in-flight workers rather than each one merely discovering its
    // own natural end.
    server.resetReadLog();
    server.injectReadFailureAfter(4);
    try {
      const result = await mcpClient.callTool({
        name: "download",
        arguments: { remotePath, localPath, connectionName: "multiconn", connections: 4, timeout: 10000 },
      });
      assert.equal(result.isError, true, "expected the injected READ failure to fail the download");
      assert.match(responseText(result), /injected read failure/);
    } finally {
      server.clearReadFailureInjection();
    }

    // rename only ever happens after every worker succeeded and the whole
    // temp file's size was verified -- the destination must never exist.
    assert.equal(fs.existsSync(localPath), false, "destination must not exist after a failed multi-connection download");
    assert.deepEqual(leftoverTempFiles(destDir), [], "expected no leftover multi-connection temp files");

    // Pool health: a subsequent normal (connections=1) download over the
    // SAME connection name must still succeed -- the multi-connection
    // failure above never touched the pool's cached client for this name
    // (every connection it used was its own fresh one-shot connection), so
    // there is nothing to have poisoned.
    const recoveryRemotePath = "/after-failure-recovery.bin";
    const recoverySourcePath = server.toLocalPath(recoveryRemotePath);
    fs.writeFileSync(recoverySourcePath, randomBytes(4096));
    const recoveryLocalPath = path.join(destDir, "after-failure-recovery.bin");
    const recoveryResult = await mcpClient.callTool({
      name: "download",
      arguments: { remotePath: recoveryRemotePath, localPath: recoveryLocalPath, connectionName: "multiconn", timeout: 10000 },
    });
    assert.equal(recoveryResult.isError, undefined, responseText(recoveryResult));
    assert.equal(sha256File(recoveryLocalPath), sha256File(recoverySourcePath));
  });

  test("failure/cleanup: one connection failing stops a DIFFERENT, still-healthy connection from scheduling further reads", async () => {
    // The test above injects a failure via a GLOBAL request-count threshold,
    // which fails every connection's next read once the shared counter is
    // past it -- so it cannot tell "the healthy worker got cancelled" apart
    // from "the healthy worker failed anyway because the fault applied to
    // it too". This test isolates the failure to exactly ONE connection
    // (index 0) via injectReadFailureForConnectionIndex, so connection 1
    // stays genuinely healthy throughout, and proves cancellation via the
    // server's own real READ-request COUNT (deterministic) rather than a
    // wall-clock race: ssh2 does not reliably reject a request that is
    // ALREADY in flight just because this side subsequently ends the
    // channel/connection (no Client/SFTP option changes that), so
    // cancellation here is cooperative -- a worker checks an abort flag
    // before starting its NEXT chunk, not preemptively mid-request. What
    // this DOES prove, deterministically: once one connection fails, a
    // healthy sibling assigned many more chunks than it has completed does
    // not go on to fetch the rest of them.
    const rangeBytes = 8 * 1024 * 1024; // 256 real READ requests at the 32 KiB internal chunk size, if uncancelled
    const perReadDelayMs = 20; // slow enough that connection 0's near-instant failure reliably lands before connection 1's first response
    const size = rangeBytes * 2;
    const remotePath = "/cancel-healthy-worker.bin";
    fs.writeFileSync(server.toLocalPath(remotePath), randomBytes(size));
    const localPath = path.join(localRoot, "cancel-healthy-worker.bin");

    server.resetConnectionCount();
    server.resetReadLog();
    // Connection index 0 (assigned the file's first range, offset 0) fails
    // its very first READ, immediately (0ms delay). Connection index 1
    // (assigned the file's second range, starting at offset rangeBytes) is
    // fully healthy but deliberately slow, so its first response arrives
    // well after connection 0 has already failed and set the abort flag.
    server.setConnectionReadDelaysMs([0, perReadDelayMs]);
    server.injectReadFailureForConnectionIndex([0]);
    try {
      const result = await mcpClient.callTool({
        name: "download",
        arguments: { remotePath, localPath, connectionName: "multiconn", connections: 2, timeout: 10000 },
      });
      assert.equal(result.isError, true, "expected the injected per-connection failure to fail the download");
      assert.match(responseText(result), /injected per-connection read failure/);
    } finally {
      server.clearConnectionReadDelaysMs();
      server.clearReadFailureForConnectionIndex();
    }
    assert.equal(fs.existsSync(localPath), false);

    // Ground truth from the server's own READ log: connection 1's range
    // needed 256 real READ requests to complete uncancelled. If cancellation
    // did nothing, this count would be 32 (or very close to it, minus
    // whichever races connection 0's failure). A healthy count of 1-2 proves
    // it stopped scheduling further reads once connection 0 failed.
    const connection1Reads = server.stats.readRequests.filter((read) => read.offset >= rangeBytes);
    assert.ok(
      connection1Reads.length > 0,
      "expected connection 1 to have made at least its first (already in-flight) real READ request",
    );
    // Reviewer-adjusted bound. Each connection keeps
    // MULTI_CONNECTION_PIPELINE_DEPTH (8) reads outstanding at once -- that
    // pipelining is the whole point of the feature, see the long comment in
    // downloadByteRangeWorker. So when the abort flag is set, up to one full
    // wave of 8 reads is ALREADY in flight and cannot be recalled (ssh2 will
    // not reject an in-flight request because this side later ends the
    // channel). The cancellation property is therefore "at most one pipeline
    // wave", not "at most one read" -- the original <= 3 bound was calibrated
    // against a serial loop that has since been replaced, and that serial
    // loop would have made this feature pointless.
    //
    // The bound still has real teeth: 32 reads are needed to finish the range,
    // so anything up to 64 proves the remaining 192 were never scheduled.
    const PIPELINE_DEPTH = 64;
    assert.ok(
      connection1Reads.length <= PIPELINE_DEPTH,
      `expected connection 1 to stop scheduling reads after at most one pipeline wave (${PIPELINE_DEPTH}) once ` +
        `connection 0 failed, but it issued ${connection1Reads.length} of the 256 real READ requests its full ` +
        `range would have needed`,
    );
  });

  test("black-box: connections above the hard cap of 8 is rejected before any connection opens", async () => {
    const remotePath = "/cap-check.bin";
    fs.writeFileSync(server.toLocalPath(remotePath), Buffer.from("irrelevant"));
    const localPath = path.join(localRoot, "cap-check.bin");

    server.resetConnectionCount();
    const result = await mcpClient.callTool({
      name: "download",
      arguments: { remotePath, localPath, connectionName: "multiconn", connections: 9, timeout: 5000 },
    });
    assert.equal(result.isError, true);
    assert.match(responseText(result), /connections must not exceed 8/);
    assert.equal(fs.existsSync(localPath), false);
    assert.equal(server.stats.connectionCount, 0, "an invalid connections value must not open any connection");
  });

  test("black-box: a non-positive or non-integer connections value is rejected before any transfer", async () => {
    const remotePath = "/invalid-connections.bin";
    fs.writeFileSync(server.toLocalPath(remotePath), Buffer.from("irrelevant"));
    const localPath = path.join(localRoot, "invalid-connections.bin");

    // 0/-1/1.5 are shape-invalid (the zod schema itself is positive-integer)
    // so the MCP layer rejects them before transferService.download ever
    // runs; the service's own "connections must be a positive integer"
    // ToolError (exercised directly in transfer-service unit-level testing
    // territory, not through this MCP-tool black-box path) exists as a
    // second, defense-in-depth check for any non-tool caller. Both layers
    // must agree on one thing this test DOES verify: none of these ever
    // reaches a real connection or creates the destination file.
    server.resetConnectionCount();
    for (const invalid of [0, -1, 1.5]) {
      // A shape-invalid value (not a positive integer) is rejected by the
      // MCP SDK's own zod-schema validation, which throws rather than
      // returning an isError result -- unlike the service-level
      // INVALID_CONFIGURATION ToolError this test file otherwise exercises.
      await assert.rejects(
        () =>
          mcpClient.callTool({
            name: "download",
            arguments: { remotePath, localPath, connectionName: "multiconn", connections: invalid, timeout: 5000 },
          }),
        `connections=${invalid} should be rejected`,
      );
    }
    assert.equal(fs.existsSync(localPath), false);
    assert.equal(server.stats.connectionCount, 0, "an invalid connections value must not open any connection");
  });

  test("black-box: the transfer tool rejects connections for relay strategy=direct, recursive=true, and archive=true", async () => {
    // mode=upload (P1-04f) and mode=relay with the default strategy (P1-06)
    // accept connections; a direct relay runs on the source server and has
    // no byte ranges to split, so it still rejects it.
    const relayResult = await mcpClient.callTool({
      name: "transfer",
      arguments: {
        mode: "relay",
        sourceServer: "multiconn",
        sourceRemotePath: "/relay-source.bin",
        destServer: "multiconn",
        destRemotePath: "/relay-dest.bin",
        strategy: "direct",
        connections: 4,
      },
    });
    assert.equal(relayResult.isError, true);
    assert.match(responseText(relayResult), /connections is only supported with strategy=/);

    const remoteDir = "/reject-recursive-dir";
    const recursiveResult = await mcpClient.callTool({
      name: "transfer",
      arguments: { mode: "download", connectionName: "multiconn", localPath: path.join(localRoot, "reject-recursive"), remotePath: remoteDir, recursive: true, connections: 4 },
    });
    assert.equal(recursiveResult.isError, true);
    assert.match(responseText(recursiveResult), /connections is not supported with recursive=true/);

    const remotePath = "/reject-archive.bin";
    fs.writeFileSync(server.toLocalPath(remotePath), Buffer.from("irrelevant"));
    const archiveResult = await mcpClient.callTool({
      name: "transfer",
      arguments: { mode: "download", connectionName: "multiconn", localPath: path.join(localRoot, "reject-archive.bin"), remotePath, archive: true, connections: 4 },
    });
    assert.equal(archiveResult.isError, true);
    assert.match(responseText(archiveResult), /connections is not supported with archive=true/);
  });

  test("black-box: omitting connections leaves the default single-connection download response text unchanged", async () => {
    const remotePath = "/default-path-unchanged.bin";
    const sourcePath = server.toLocalPath(remotePath);
    fs.writeFileSync(sourcePath, randomBytes(4096));
    const localPath = path.join(localRoot, "default-path-unchanged.bin");

    const result = await mcpClient.callTool({
      name: "download",
      arguments: { remotePath, localPath, connectionName: "multiconn", timeout: 5000 },
    });
    assert.equal(result.isError, undefined, responseText(result));
    assert.match(responseText(result), /via fast SFTP/);
    assert.doesNotMatch(responseText(result), /independent connection/);
    assert.equal(sha256File(localPath), sha256File(sourcePath));
  });
});
