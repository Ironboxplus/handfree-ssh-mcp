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
import { registerDownloadTool } from "../tools/download.js";
import { registerTransferTool } from "../tools/transfer.js";
import { RealSshTestServer } from "./helpers/real-ssh-server.js";

/**
 * PLAN.MD P1-04a: striped (multi-channel) SFTP download.
 *
 * Every test here uses a real in-process ssh2/SFTP server (RealSshTestServer)
 * and real files on disk -- no mocked SFTP, no stubbed client. Per the P1-04
 * split record at the top of PLAN.MD's P1-04 section, this file proves
 * correctness only (ranges, concurrency via real channel/READ counters,
 * verification, cleanup). It intentionally makes NO wall-clock speedup
 * assertion: the in-process server has ~zero RTT, so striping cannot show a
 * throughput benefit here (that is P1-04b, gated on the .88 netem lab).
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
 * Validate a computeDownloadStripeRanges() result against the invariants
 * every caller relies on: ranges are contiguous (no gap, no overlap, in
 * file order) and their lengths sum to exactly totalSize.
 */
function assertRangesValid(
  ranges: Array<{ offset: number; length: number }>,
  totalSize: number,
  expectedCount: number,
): void {
  assert.equal(ranges.length, expectedCount, `expected ${expectedCount} ranges, got ${ranges.length}`);
  let runningOffset = 0;
  for (const range of ranges) {
    assert.equal(range.offset, runningOffset, `range offset ${range.offset} is not contiguous with previous end ${runningOffset}`);
    assert.ok(range.length >= 1, "every range must be at least 1 byte");
    runningOffset += range.length;
  }
  assert.equal(runningOffset, totalSize, `ranges sum to ${runningOffset}, expected totalSize ${totalSize}`);
  if (ranges.length > 1) {
    const lengths = ranges.map((r) => r.length);
    assert.ok(
      Math.max(...lengths) - Math.min(...lengths) <= 1,
      `stripe lengths should differ by at most 1 byte, got ${JSON.stringify(lengths)}`,
    );
  }
}

/**
 * Validate that the real READ requests a server received (ground truth from
 * the wire, not the client's own bookkeeping) are themselves contiguous and
 * non-overlapping and cover [0, totalSize) exactly.
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

describe("striped download real execution (PLAN.MD P1-04a)", { concurrency: false }, () => {
  const manager = SSHConnectionManager.getInstance();
  const suiteRoot = fs.mkdtempSync(path.join(os.tmpdir(), "handfree-striped-real-"));
  const serverRoot = path.join(suiteRoot, "server");
  const localRoot = path.join(suiteRoot, "local");
  // A small real per-READ delay makes genuinely concurrent stripe channels
  // reliably overlap in wall-clock terms (same rationale as
  // readdirResponseDelayMs in walker-real.test.ts) -- local disk reads
  // otherwise resolve too fast to observe overlap.
  const server = new RealSshTestServer(serverRoot, 8, 0, 3);
  const mcpServer = new McpServer({ name: "striped-download-test", version: "1.0.0" });
  const mcpClient = new Client({ name: "striped-download-client", version: "1.0.0" });

  before(async () => {
    fs.mkdirSync(localRoot, { recursive: true });
    await server.start();
    manager.setConfig({
      striped: {
        host: "127.0.0.1",
        port: server.port,
        username: "test",
        password: "test",
        disableSftpPathPolicy: true,
        keepaliveInterval: 0,
      },
    }, ["striped"]);
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

  test("white-box: computeDownloadStripeRanges is exhaustively pinned", () => {
    const privateManager = manager as any;
    const compute = (totalSize: number, stripeCount: number): Array<{ offset: number; length: number }> =>
      privateManager.transferService.computeDownloadStripeRanges(totalSize, stripeCount);

    // Zero-byte file: no ranges at all.
    assert.deepEqual(compute(0, 4), []);
    assert.deepEqual(compute(0, 1), []);

    // 1-byte file: exactly one range regardless of requested stripeCount.
    assert.deepEqual(compute(1, 4), [{ offset: 0, length: 1 }]);
    assert.deepEqual(compute(1, 8), [{ offset: 0, length: 1 }]);

    // stripeCount=1 always serializes to exactly one range covering the file.
    assert.deepEqual(compute(999, 1), [{ offset: 0, length: 999 }]);

    // Exactly evenly divisible: every range the same size, no remainder.
    assert.deepEqual(compute(8, 4), [
      { offset: 0, length: 2 },
      { offset: 2, length: 2 },
      { offset: 4, length: 2 },
      { offset: 6, length: 2 },
    ]);
    assert.deepEqual(compute(4, 4), [
      { offset: 0, length: 1 },
      { offset: 1, length: 1 },
      { offset: 2, length: 1 },
      { offset: 3, length: 1 },
    ]);

    // One stripe-width plus one leftover byte: remainder=1 goes to the first range.
    assert.deepEqual(compute(5, 4), [
      { offset: 0, length: 2 },
      { offset: 2, length: 1 },
      { offset: 3, length: 1 },
      { offset: 4, length: 1 },
    ]);

    // Non-divisible, remainder spread across more than one range.
    assert.deepEqual(compute(10, 3), [
      { offset: 0, length: 4 },
      { offset: 4, length: 3 },
      { offset: 7, length: 3 },
    ]);

    // stripeCount larger than the file: never more ranges than bytes.
    assertRangesValid(compute(3, 8), 3, 3);
    assert.deepEqual(compute(3, 8), [
      { offset: 0, length: 1 },
      { offset: 1, length: 1 },
      { offset: 2, length: 1 },
    ]);

    // Huge size: only the invariants are checked (contiguous, sums exactly,
    // never more ranges than requested).
    assertRangesValid(compute(5_000_000_000, 8), 5_000_000_000, 8);
    assertRangesValid(compute(123_456_789, 5), 123_456_789, 5);
  });

  test("black-box: striped download via the download tool is byte-identical for a non-stripe-multiple size", async () => {
    const size = 3 * 1024 * 1024 + 777; // not a multiple of any default stripe boundary
    const remotePath = "/big-non-multiple.bin";
    const sourcePath = server.toLocalPath(remotePath);
    fs.writeFileSync(sourcePath, randomBytes(size));
    const localPath = path.join(localRoot, "big-non-multiple.bin");

    const result = await mcpClient.callTool({
      name: "download",
      arguments: { remotePath, localPath, connectionName: "striped", striped: true, timeout: 10000 },
    });
    assert.equal(result.isError, undefined, responseText(result));
    assert.match(responseText(result), /striped multi-channel SFTP/);
    assert.equal(fs.statSync(localPath).size, size);
    assert.equal(sha256File(localPath), sha256File(sourcePath));
  });

  test("black-box: striped download via the transfer tool handles a file smaller than one stripe", async () => {
    const remotePath = "/tiny-one-byte.bin";
    const sourcePath = server.toLocalPath(remotePath);
    fs.writeFileSync(sourcePath, Buffer.from([0x5a]));
    const localPath = path.join(localRoot, "tiny-one-byte.bin");

    const result = await mcpClient.callTool({
      name: "transfer",
      arguments: {
        mode: "download",
        connectionName: "striped",
        remotePath,
        localPath,
        striped: true,
        stripeCount: 4,
        timeout: 10000,
      },
    });
    assert.equal(result.isError, undefined, responseText(result));
    assert.equal(fs.statSync(localPath).size, 1);
    assert.equal(sha256File(localPath), sha256File(sourcePath));
  });

  test("black-box: striped download handles an empty file", async () => {
    const remotePath = "/empty.bin";
    const sourcePath = server.toLocalPath(remotePath);
    fs.writeFileSync(sourcePath, Buffer.alloc(0));
    const localPath = path.join(localRoot, "empty.bin");

    const result = await mcpClient.callTool({
      name: "download",
      arguments: { remotePath, localPath, connectionName: "striped", striped: true, stripeCount: 4, timeout: 10000 },
    });
    assert.equal(result.isError, undefined, responseText(result));
    assert.equal(fs.statSync(localPath).size, 0);
    assert.equal(sha256File(localPath), sha256File(sourcePath));
  });

  test("grey-box: striped download reaches real concurrent SFTP channels without exceeding stripeCount", async () => {
    const size = 800_000;
    const remotePath = "/concurrency-check.bin";
    const sourcePath = server.toLocalPath(remotePath);
    fs.writeFileSync(sourcePath, randomBytes(size));
    const localPath = path.join(localRoot, "concurrency-check.bin");

    // Reset to the current live count immediately before the transfer under
    // test so the assertion below can only be satisfied by concurrency this
    // transfer itself produced (see resetChannelPeak()'s own doc comment).
    server.resetChannelPeak();
    const result = await mcpClient.callTool({
      name: "download",
      arguments: {
        remotePath,
        localPath,
        connectionName: "striped",
        striped: true,
        stripeCount: 4,
        chunkSize: 50_000,
        timeout: 10000,
      },
    });
    assert.equal(result.isError, undefined, responseText(result));
    assert.equal(sha256File(localPath), sha256File(sourcePath));

    const peak = server.stats.maxActiveSftpChannels;
    // > 1 proves genuine concurrency (not an accidentally-serial run). The
    // +1 headroom above stripeCount allows for the transient stat channel
    // (opened once, briefly, before the stripe workers) still closing while
    // the first worker channels open -- the real invariant this exists to
    // protect is that concurrency never runs away unbounded.
    assert.ok(peak > 1, `expected genuine concurrency, observed peak: ${peak}`);
    assert.ok(peak <= 4 + 1, `observed peak concurrent SFTP channels: ${peak}, stripeCount cap is 4`);
  });

  test("grey-box: the real READ requests the server received are non-overlapping and cover the file exactly", async () => {
    const size = 500_003; // deliberately not a multiple of chunkSize or stripeCount
    const remotePath = "/coverage-check.bin";
    const sourcePath = server.toLocalPath(remotePath);
    fs.writeFileSync(sourcePath, randomBytes(size));
    const localPath = path.join(localRoot, "coverage-check.bin");

    server.resetReadLog();
    const result = await mcpClient.callTool({
      name: "download",
      arguments: {
        remotePath,
        localPath,
        connectionName: "striped",
        striped: true,
        stripeCount: 4,
        chunkSize: 30_000,
        timeout: 10000,
      },
    });
    assert.equal(result.isError, undefined, responseText(result));
    assert.equal(sha256File(localPath), sha256File(sourcePath));
    // Ground truth from the server's own wire-level counters, not this
    // client's bookkeeping.
    assertReadRequestsCoverFileExactly(server.stats.readRequests, size);
  });

  test("black-box: stripeCount above the shared MaxSessions-derived cap is rejected before any transfer", async () => {
    const remotePath = "/cap-check.bin";
    fs.writeFileSync(server.toLocalPath(remotePath), Buffer.from("irrelevant"));
    const localPath = path.join(localRoot, "cap-check.bin");

    const result = await mcpClient.callTool({
      name: "download",
      arguments: { remotePath, localPath, connectionName: "striped", striped: true, stripeCount: 9, timeout: 5000 },
    });
    assert.equal(result.isError, true);
    assert.match(responseText(result), /stripeCount must not exceed 8/);
    assert.equal(fs.existsSync(localPath), false);
  });

  test("black-box: an oversized stripeCount x chunkSize window is rejected by maxBufferBytes before any transfer", async () => {
    const remotePath = "/buffer-check.bin";
    fs.writeFileSync(server.toLocalPath(remotePath), Buffer.from("irrelevant"));
    const localPath = path.join(localRoot, "buffer-check.bin");

    const result = await mcpClient.callTool({
      name: "download",
      arguments: {
        remotePath,
        localPath,
        connectionName: "striped",
        striped: true,
        stripeCount: 4,
        chunkSize: 1_000_000,
        maxBufferBytes: 2_000_000,
        timeout: 5000,
      },
    });
    assert.equal(result.isError, true);
    assert.match(responseText(result), /buffer window is too large/);
    assert.equal(fs.existsSync(localPath), false);
  });

  test("failure/cleanup: a real mid-transfer READ failure cancels the rest, cleans the temp file, and does not poison the connection", async () => {
    const size = 2_000_000;
    const remotePath = "/failure-check.bin";
    const sourcePath = server.toLocalPath(remotePath);
    fs.writeFileSync(sourcePath, randomBytes(size));
    const destDir = path.join(localRoot, "failure-check-dir");
    fs.mkdirSync(destDir, { recursive: true });
    const localPath = path.join(destDir, "failure-check.bin");

    // stripeCount=4 over a 2,000,000-byte file with a 50,000-byte chunk
    // means 40 real READ requests total if uncancelled (10 per stripe).
    // Letting the first 6 succeed guarantees every one of the 4 stripe
    // workers still has far more of its own range left to read -- so when
    // the (7th+) READ starts failing, at least one worker is genuinely
    // cancelled mid-flight rather than merely discovering its own natural
    // EOF, which is the actual "cancel the rest" branch this test targets.
    server.resetReadLog();
    server.injectReadFailureAfter(6);
    try {
      const result = await mcpClient.callTool({
        name: "download",
        arguments: {
          remotePath,
          localPath,
          connectionName: "striped",
          striped: true,
          stripeCount: 4,
          chunkSize: 50_000,
          timeout: 10000,
        },
      });
      assert.equal(result.isError, true, "expected the injected READ failure to fail the download");
      assert.match(responseText(result), /injected read failure/);
    } finally {
      server.clearReadFailureInjection();
    }

    // The destination must never have been created (rename only happens
    // after every stripe succeeded and verification passed).
    assert.equal(fs.existsSync(localPath), false, "destination must not exist after a failed striped download");

    // No striped-download temp file may be left behind in the destination
    // directory.
    const leftoverTempFiles = fs.readdirSync(destDir).filter((name) => name.includes(".striped-"));
    assert.deepEqual(leftoverTempFiles, [], `expected no leftover temp files, found: ${JSON.stringify(leftoverTempFiles)}`);

    // Pool health: a subsequent normal download over the SAME connection
    // name must still succeed -- proving the earlier real failure did not
    // poison the cached SSH connection/session.
    const recoveryRemotePath = "/after-failure-recovery.bin";
    const recoverySourcePath = server.toLocalPath(recoveryRemotePath);
    fs.writeFileSync(recoverySourcePath, randomBytes(4096));
    const recoveryLocalPath = path.join(destDir, "after-failure-recovery.bin");
    const recoveryResult = await mcpClient.callTool({
      name: "download",
      arguments: { remotePath: recoveryRemotePath, localPath: recoveryLocalPath, connectionName: "striped", timeout: 10000 },
    });
    assert.equal(recoveryResult.isError, undefined, responseText(recoveryResult));
    assert.equal(sha256File(recoveryLocalPath), sha256File(recoverySourcePath));
  });

  test("black-box: omitting striped leaves the default (non-striped) download path and its response text unchanged", async () => {
    const remotePath = "/default-path-unchanged.bin";
    const sourcePath = server.toLocalPath(remotePath);
    fs.writeFileSync(sourcePath, randomBytes(4096));
    const localPath = path.join(localRoot, "default-path-unchanged.bin");

    const result = await mcpClient.callTool({
      name: "download",
      arguments: { remotePath, localPath, connectionName: "striped", timeout: 5000 },
    });
    assert.equal(result.isError, undefined, responseText(result));
    assert.match(responseText(result), /via fast SFTP/);
    assert.doesNotMatch(responseText(result), /striped/);
    assert.equal(sha256File(localPath), sha256File(sourcePath));
  });
});
