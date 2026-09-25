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
import { registerUploadTool } from "../tools/upload.js";
import { registerTransferTool } from "../tools/transfer.js";
import { RealSshTestServer } from "./helpers/real-ssh-server.js";

/**
 * Multi-connection single-file upload (PLAN.MD P1-04f).
 *
 * The upload-direction twin of multi-connection download: N genuinely
 * independent TCP+SSH connections, each writing its own non-overlapping byte
 * range of one remote temp file, which then replaces the target. Every test
 * runs against a real in-process ssh2/SFTP server and real files -- no
 * mocked SFTP, no stubbed client. It proves CORRECTNESS only; the
 * throughput claim comes from the real netem lab (P1-04f-A4), never from the
 * near-zero-RTT in-process server.
 *
 * The fixture's RENAME fails when the target exists (OpenSSH semantics) and
 * cannot advertise posix-rename@openssh.com, so every test here exercises
 * the plain-RENAME fallback; the atomic posix-rename path runs against real
 * OpenSSH in the lab.
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

/** Wire truth from the server's own WRITE log: sorted by offset, the writes
 * must chain exactly from 0 to totalSize -- a 1-byte overlap or gap fails. */
function assertWriteRequestsCoverFileExactly(
  writes: Array<{ offset: number; length: number }>,
  totalSize: number,
): void {
  assert.ok(writes.length > 0, "expected at least one real WRITE request");
  const sorted = [...writes].sort((a, b) => a.offset - b.offset);
  let runningOffset = 0;
  for (const write of sorted) {
    assert.equal(write.offset, runningOffset, `real WRITE at ${write.offset} is not contiguous with ${runningOffset}`);
    runningOffset += write.length;
  }
  assert.equal(runningOffset, totalSize);
}

function remoteTempLeftovers(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((name) => name.includes(".handfree-upload-"));
}

describe("multi-connection upload real execution", { concurrency: false }, () => {
  const manager = SSHConnectionManager.getInstance();
  const suiteRoot = fs.mkdtempSync(path.join(os.tmpdir(), "handfree-multiconn-upload-"));
  const serverRoot = path.join(suiteRoot, "server");
  // Local sources must live under the MCP working directory (validateLocalPath),
  // so they go in a unique directory under cwd, removed in after().
  const localRoot = fs.mkdtempSync(path.join(process.cwd(), ".handfree-multiconn-upload-src-"));
  const server = new RealSshTestServer(serverRoot);
  const mcpServer = new McpServer({ name: "multiconn-upload-test", version: "1.0.0" });
  const mcpClient = new Client({ name: "multiconn-upload-client", version: "1.0.0" });

  const writeLocal = (name: string, data: Buffer): string => {
    const localPath = path.join(localRoot, name);
    fs.writeFileSync(localPath, data);
    return localPath;
  };
  const upload = (args: Record<string, unknown>) =>
    mcpClient.callTool({ name: "upload", arguments: { connectionName: "multiconn", timeout: 10000, ...args } });
  const waitForNoLiveConnections = async () => {
    const deadline = Date.now() + 3000;
    while (server.liveConnectionCount > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };

  before(async () => {
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
    registerUploadTool(mcpServer);
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
    fs.rmSync(localRoot, { recursive: true, force: true });
    manager.setConfig({}, undefined);
  });

  test("black-box: upload with connections=4 lands a byte-identical file for a non-round size", async () => {
    const data = randomBytes(3 * 1024 * 1024 + 777);
    const localPath = writeLocal("big-non-round.bin", data);

    const result = await upload({ localPath, remotePath: "/big-non-round.bin", connections: 4 });
    assert.equal(result.isError, undefined, responseText(result));
    assert.match(responseText(result), /via 4 independent connection\(s\)/);
    assert.equal(sha256(fs.readFileSync(server.toLocalPath("/big-non-round.bin"))), sha256(data));
    assert.deepEqual(remoteTempLeftovers(serverRoot), []);
  });

  test("black-box: transfer mode=upload accepts connections too", async () => {
    const data = randomBytes(500_003);
    const localPath = writeLocal("via-transfer.bin", data);

    const result = await mcpClient.callTool({
      name: "transfer",
      arguments: { mode: "upload", connectionName: "multiconn", localPath, remotePath: "/via-transfer.bin", connections: 3, timeout: 10000 },
    });
    assert.equal(result.isError, undefined, responseText(result));
    assert.match(responseText(result), /via 3 independent connection\(s\)/);
    assert.equal(sha256(fs.readFileSync(server.toLocalPath("/via-transfer.bin"))), sha256(data));
  });

  test("black-box: an existing different target is replaced, and no temp file is left behind", async () => {
    // The fixture's RENAME refuses to overwrite (OpenSSH semantics), so this
    // passes only if the client removes the old target itself first.
    fs.writeFileSync(server.toLocalPath("/replace-me.bin"), Buffer.from("old contents"));
    const data = randomBytes(700_001);
    const localPath = writeLocal("replace-me.bin", data);

    const result = await upload({ localPath, remotePath: "/replace-me.bin", connections: 4 });
    assert.equal(result.isError, undefined, responseText(result));
    assert.equal(sha256(fs.readFileSync(server.toLocalPath("/replace-me.bin"))), sha256(data));
    assert.deepEqual(remoteTempLeftovers(serverRoot), []);
  });

  test("grey-box: connections=4 opens 4 real, distinct TCP+SSH connections, with the handshakes concurrent", async () => {
    // connectionCount counts raw socket accepts, so 4 channels on ONE
    // connection (the deleted striped design) could never satisfy it.
    const data = randomBytes(900_000);
    const localPath = writeLocal("four-connections.bin", data);
    server.setAuthDelayMs(300);
    try {
      // Cold pool: otherwise warm transfer lanes from earlier tests are reused.
      manager.disconnect();
      server.resetConnectionCount();
      const result = await upload({ localPath, remotePath: "/four-connections.bin", connections: 4 });
      assert.equal(result.isError, undefined, responseText(result));
      assert.equal(server.stats.connectionCount, 4, "expected exactly 4 distinct real TCP+SSH connections");
      assert.equal(server.stats.maxActiveHandshakes, 4, "expected all 4 handshakes in flight at once");
    } finally {
      server.setAuthDelayMs(0);
    }
  });

  test("grey-box: the real WRITE requests are non-overlapping, cover the file exactly, and are spread over every connection", async () => {
    const size = 500_003;
    const data = randomBytes(size);
    const localPath = writeLocal("coverage.bin", data);

    server.resetWriteLog();
    const result = await upload({ localPath, remotePath: "/coverage.bin", connections: 4 });
    assert.equal(result.isError, undefined, responseText(result));
    assertWriteRequestsCoverFileExactly(server.stats.writeRequests, size);
    const connectionsThatWrote = new Set(server.stats.writeRequests.map((write) => write.connectionIndex));
    assert.equal(connectionsThatWrote.size, 4, "every one of the 4 connections must have written its own range");
  });

  test("failure/cleanup: one connection's writes failing keeps the old target intact, deletes the temp, and closes every connection", async () => {
    const original = Buffer.from("precious original contents that must survive a failed upload");
    fs.writeFileSync(server.toLocalPath("/keep-original.bin"), original);
    const localPath = writeLocal("keep-original.bin", randomBytes(600_000));

    manager.disconnect();
    await waitForNoLiveConnections();
    server.setFailWritesForConnectionIndices([2]);
    try {
      server.resetConnectionCount();
      const result = await upload({ localPath, remotePath: "/keep-original.bin", connections: 4 });
      assert.equal(result.isError, true, "a failed range write must fail the upload");
      assert.deepEqual(fs.readFileSync(server.toLocalPath("/keep-original.bin")), original, "the target must be untouched");
      assert.deepEqual(remoteTempLeftovers(serverRoot), [], "the remote temp file must be deleted");
      await waitForNoLiveConnections();
      assert.equal(server.liveConnectionCount, 0, "every connection must be closed");
    } finally {
      server.setFailWritesForConnectionIndices(null);
    }
  });

  test("failure/cleanup: one of the concurrent handshakes failing leaves no connection open and writes nothing", async () => {
    const localPath = writeLocal("handshake-failure.bin", randomBytes(100_000));
    manager.disconnect();
    await waitForNoLiveConnections();
    server.setAuthDelayMs(200);
    server.setRejectAuthForConnectionIndices([2]);
    try {
      server.resetConnectionCount();
      server.resetWriteLog();
      const result = await upload({ localPath, remotePath: "/handshake-failure.bin", connections: 4 });
      assert.equal(result.isError, true);
      assert.deepEqual(server.stats.writeRequests, []);
      assert.equal(fs.existsSync(server.toLocalPath("/handshake-failure.bin")), false);
      await waitForNoLiveConnections();
      assert.equal(server.liveConnectionCount, 0, "every connection that came up must have been closed");
    } finally {
      server.setAuthDelayMs(0);
      server.setRejectAuthForConnectionIndices(null);
    }
  });

  test("black-box: skip-if-identical still applies -- an identical remote file is skipped with zero WRITEs", async () => {
    const data = randomBytes(300_000);
    fs.writeFileSync(server.toLocalPath("/identical.bin"), data);
    const localPath = writeLocal("identical.bin", data);

    server.resetWriteLog();
    const result = await upload({ localPath, remotePath: "/identical.bin", connections: 4 });
    assert.equal(result.isError, undefined, responseText(result));
    assert.match(responseText(result), /^Upload skipped:/);
    assert.deepEqual(server.stats.writeRequests, []);
  });

  test("black-box: a shell script's CRLF->LF fix still happens with connections", async () => {
    const localPath = writeLocal("script.sh", Buffer.from("#!/bin/sh\r\necho one\r\necho two\r\n"));

    const result = await upload({ localPath, remotePath: "/script.sh", connections: 2, skipIfIdentical: false });
    assert.equal(result.isError, undefined, responseText(result));
    assert.match(responseText(result), /CRLF→LF auto-fix/);
    assert.equal(fs.readFileSync(server.toLocalPath("/script.sh"), "utf8"), "#!/bin/sh\necho one\necho two\n");
  });

  test("black-box: a file smaller than the connection count runs no empty range worker", async () => {
    const localPath = writeLocal("tiny.bin", Buffer.from([0x11, 0x22, 0x33]));

    server.resetWriteLog();
    const result = await upload({ localPath, remotePath: "/tiny.bin", connections: 8, skipIfIdentical: false });
    assert.equal(result.isError, undefined, responseText(result));
    assert.match(responseText(result), /via 3 independent connection\(s\)/);
    assert.deepEqual(fs.readFileSync(server.toLocalPath("/tiny.bin")), Buffer.from([0x11, 0x22, 0x33]));
    assert.deepEqual(
      server.stats.writeRequests.map(({ offset, length }) => ({ offset, length })).sort((a, b) => a.offset - b.offset),
      [{ offset: 0, length: 1 }, { offset: 1, length: 1 }, { offset: 2, length: 1 }],
    );
  });

  test("black-box: an empty file lands as an empty remote file", async () => {
    const localPath = writeLocal("empty.bin", Buffer.alloc(0));
    const result = await upload({ localPath, remotePath: "/empty.bin", connections: 4, skipIfIdentical: false });
    assert.equal(result.isError, undefined, responseText(result));
    assert.equal(fs.statSync(server.toLocalPath("/empty.bin")).size, 0);
  });

  test("black-box: invalid connections values are rejected before any connection opens", async () => {
    const localPath = writeLocal("invalid.bin", randomBytes(1000));
    manager.disconnect();
    server.resetConnectionCount();
    // Above the cap: a well-shaped value the service itself must reject.
    const tooMany = await upload({ localPath, remotePath: "/invalid.bin", connections: 9 });
    assert.equal(tooMany.isError, true, "connections=9 must be rejected");
    assert.match(responseText(tooMany), /must not exceed 8/);
    // Shape-invalid values are rejected by the tool's zod schema, which makes
    // the MCP SDK throw rather than return an isError result (same convention
    // as the multi-connection download tests).
    for (const invalid of [0, -1, 1.5]) {
      await assert.rejects(() => upload({ localPath, remotePath: "/invalid.bin", connections: invalid }), `connections=${invalid} must be rejected`);
    }
    assert.equal(server.stats.connectionCount, 0, "an invalid connections value must not open any connection");
    assert.equal(fs.existsSync(server.toLocalPath("/invalid.bin")), false);
  });

  test("black-box: connections is rejected for batch, recursive and archive uploads", async () => {
    const localPath = writeLocal("shape.bin", randomBytes(1000));
    const batch = await upload({ localPath: [localPath], remotePath: "/shape-dir", connections: 2 });
    assert.equal(batch.isError, true);
    assert.match(responseText(batch), /connections/);

    for (const extra of [{ recursive: true }, { archive: true }]) {
      const result = await mcpClient.callTool({
        name: "transfer",
        arguments: { mode: "upload", connectionName: "multiconn", localPath, remotePath: "/shape.bin", connections: 2, ...extra },
      });
      assert.equal(result.isError, true, `connections with ${JSON.stringify(extra)} must be rejected`);
      assert.match(responseText(result), /connections/);
    }
  });

  test("black-box: omitting connections leaves the single-connection upload response unchanged", async () => {
    const data = randomBytes(10_000);
    const localPath = writeLocal("default.bin", data);
    const result = await upload({ localPath, remotePath: "/default.bin" });
    assert.equal(result.isError, undefined, responseText(result));
    assert.equal(responseText(result), "File uploaded successfully (10000 bytes via fast SFTP)");
  });
});
