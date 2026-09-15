import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSHConnectionManager } from "../services/ssh-connection-manager.js";
import {
  MAX_BATCH_UPLOAD_SIZE,
  batchUploadBasename,
  findBatchTargetCollisions,
  validateBatchUploadTargets,
  type BatchUploadResult,
} from "../services/transfer-service.js";
import { registerUploadTool } from "../tools/upload.js";
import { registerTransferTool } from "../tools/transfer.js";
import { RealSshTestServer } from "./helpers/real-ssh-server.js";

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function responseText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = result.content as Array<{ type: string; text?: string }>;
  return content
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .filter((text): text is string => typeof text === "string")
    .join("\n");
}

function parseBatchResult(result: Awaited<ReturnType<Client["callTool"]>>): BatchUploadResult {
  return JSON.parse(responseText(result)) as BatchUploadResult;
}

describe("P1-09 batch upload (PLAN.MD §5.7)", { concurrency: false }, () => {
  const manager = SSHConnectionManager.getInstance();
  const transferService = manager.getTransferService();
  const suiteRoot = fs.mkdtempSync(path.join(os.tmpdir(), "handfree-batch-upload-"));
  const localRoot = path.join(suiteRoot, "local");
  const destinationServerRoot = path.join(suiteRoot, "destination-server");
  const destinationServer = new RealSshTestServer(destinationServerRoot);
  const mcpServer = new McpServer({ name: "batch-upload-test", version: "1.0.0" });
  const mcpClient = new Client({ name: "batch-upload-client", version: "1.0.0" });

  before(async () => {
    fs.mkdirSync(localRoot, { recursive: true });
    await destinationServer.start();
    manager.setConfig({
      destination: {
        host: "127.0.0.1",
        port: destinationServer.port,
        username: "test",
        password: "test",
        disableSftpPathPolicy: true,
        keepaliveInterval: 0,
      },
    }, ["destination"]);
    registerUploadTool(mcpServer);
    registerTransferTool(mcpServer);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await mcpServer.connect(serverTransport);
    await mcpClient.connect(clientTransport);
  });

  after(async () => {
    manager.disconnect();
    await Promise.all([mcpClient.close(), mcpServer.close()]);
    await destinationServer.stop();
    fs.rmSync(suiteRoot, { recursive: true, force: true });
    manager.setConfig({}, undefined);
  });

  // ---------------------------------------------------------------------
  // P1-09-A3 (white-box): exhaustive value tests over the pure validation
  // functions. No SSH/SFTP involved -- these take plain string arrays.
  // ---------------------------------------------------------------------
  describe("P1-09-A3 (white-box): pure validation functions", () => {
    test("empty array -> INVALID_CONFIGURATION", () => {
      const result = validateBatchUploadTargets([]);
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.code, "INVALID_CONFIGURATION");
    });

    test("single valid entry -> ok", () => {
      const result = validateBatchUploadTargets(["a/one.txt"]);
      assert.deepEqual(result, { ok: true });
    });

    test("exactly at the 1000-entry cap -> ok", () => {
      const paths = Array.from({ length: MAX_BATCH_UPLOAD_SIZE }, (_, i) => `dir/file-${i}.txt`);
      const result = validateBatchUploadTargets(paths);
      assert.deepEqual(result, { ok: true });
    });

    test("one entry over the cap -> BATCH_TOO_LARGE", () => {
      const paths = Array.from({ length: MAX_BATCH_UPLOAD_SIZE + 1 }, (_, i) => `dir/file-${i}.txt`);
      const result = validateBatchUploadTargets(paths);
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.code, "BATCH_TOO_LARGE");
    });

    test("basename collision across two different source paths -> BATCH_TARGET_COLLISION", () => {
      const result = validateBatchUploadTargets(["a/config.yaml", "b/config.yaml"]);
      assert.equal(result.ok, false);
      if (!result.ok && result.code === "BATCH_TARGET_COLLISION") {
        assert.deepEqual(result.collisions, [
          { basename: "config.yaml", sources: ["a/config.yaml", "b/config.yaml"] },
        ]);
      } else {
        assert.fail(`expected BATCH_TARGET_COLLISION, got ${JSON.stringify(result)}`);
      }
    });

    test("the exact same path repeated in the array -> BATCH_TARGET_COLLISION, not silent dedup", () => {
      const result = validateBatchUploadTargets(["a/config.yaml", "a/config.yaml"]);
      assert.equal(result.ok, false);
      if (!result.ok && result.code === "BATCH_TARGET_COLLISION") {
        assert.deepEqual(result.collisions, [
          { basename: "config.yaml", sources: ["a/config.yaml", "a/config.yaml"] },
        ]);
      } else {
        assert.fail(`expected BATCH_TARGET_COLLISION, got ${JSON.stringify(result)}`);
      }
    });

    test("Windows backslash paths collide on basename exactly like forward-slash paths", () => {
      const collisions = findBatchTargetCollisions(["C:\\a\\config.yaml", "C:\\b\\config.yaml"]);
      assert.deepEqual(collisions, [
        { basename: "config.yaml", sources: ["C:\\a\\config.yaml", "C:\\b\\config.yaml"] },
      ]);
      assert.equal(batchUploadBasename("C:\\a\\config.yaml"), "config.yaml");
    });

    test("distinct basenames across many sources -> no collisions, order-independent count", () => {
      const collisions = findBatchTargetCollisions(["a/one.txt", "b/two.txt", "c/three.txt"]);
      assert.deepEqual(collisions, []);
    });

    test("three-way collision reports every contributing source", () => {
      const collisions = findBatchTargetCollisions(["a/x.txt", "b/x.txt", "c/x.txt", "d/y.txt"]);
      assert.deepEqual(collisions, [
        { basename: "x.txt", sources: ["a/x.txt", "b/x.txt", "c/x.txt"] },
      ]);
    });

    test("validation order is empty -> too-large -> collisions (a too-large array is rejected even if it also collides)", () => {
      const paths = Array.from({ length: MAX_BATCH_UPLOAD_SIZE + 1 }, () => "same/name.txt");
      const result = validateBatchUploadTargets(paths);
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.code, "BATCH_TOO_LARGE");
    });
  });

  // ---------------------------------------------------------------------
  // P1-09-A3 (grey-box half): collision/cap/empty rejection must happen
  // before any real SFTP call. Evidenced by real server-side call counters.
  // ---------------------------------------------------------------------
  describe("P1-09-A3: pre-transfer validation makes zero real SFTP calls", () => {
    test("BATCH_TARGET_COLLISION is thrown with zero real SFTP opens/channels", async () => {
      const openedBefore = destinationServer.stats.openedFiles;
      destinationServer.resetChannelPeak();
      await assert.rejects(
        () => transferService.uploadBatch(
          ["a/config.yaml", "b/config.yaml"],
          "/zero-call-collision",
          "destination",
        ),
        (error: unknown) => error instanceof Error && (error as { code?: string }).code === "BATCH_TARGET_COLLISION",
      );
      assert.equal(destinationServer.stats.openedFiles, openedBefore);
      assert.equal(destinationServer.stats.maxActiveSftpChannels, 0);
      assert.equal(fs.existsSync(destinationServer.toLocalPath("/zero-call-collision")), false);
    });

    test("BATCH_TOO_LARGE is thrown with zero real SFTP opens/channels", async () => {
      const openedBefore = destinationServer.stats.openedFiles;
      destinationServer.resetChannelPeak();
      const paths = Array.from({ length: MAX_BATCH_UPLOAD_SIZE + 1 }, (_, i) => `dir/file-${i}.txt`);
      await assert.rejects(
        () => transferService.uploadBatch(paths, "/zero-call-too-large", "destination"),
        (error: unknown) => error instanceof Error && (error as { code?: string }).code === "BATCH_TOO_LARGE",
      );
      assert.equal(destinationServer.stats.openedFiles, openedBefore);
      assert.equal(destinationServer.stats.maxActiveSftpChannels, 0);
    });

    test("empty array is thrown as INVALID_CONFIGURATION with zero real SFTP opens/channels", async () => {
      const openedBefore = destinationServer.stats.openedFiles;
      destinationServer.resetChannelPeak();
      await assert.rejects(
        () => transferService.uploadBatch([], "/zero-call-empty", "destination"),
        (error: unknown) => error instanceof Error && (error as { code?: string }).code === "INVALID_CONFIGURATION",
      );
      assert.equal(destinationServer.stats.openedFiles, openedBefore);
      assert.equal(destinationServer.stats.maxActiveSftpChannels, 0);
    });
  });

  // ---------------------------------------------------------------------
  // P1-09-A1 (black-box): real stdio-shaped MCP client (InMemoryTransport +
  // real ssh2 SFTP server) uploads 12 real files. 2 pre-existing identical
  // files must be skipped; 1 .sh file must get CRLF->LF fixed. Every
  // returned per-file status is checked against the real remote end state.
  // ---------------------------------------------------------------------
  test("P1-09-A1 (black-box): 12-file batch upload via the upload tool matches real remote end state", async () => {
    const localDir = path.join(localRoot, "a1-input");
    fs.mkdirSync(localDir, { recursive: true });
    const remoteDir = "/batch-a1";
    fs.mkdirSync(destinationServer.toLocalPath(remoteDir), { recursive: true });

    const normal = (name: string) => `content for ${name}\nsecond line\n`;
    const shellCrlf = "#!/bin/sh\r\necho hello\r\n";
    const shellLf = "#!/bin/sh\necho hello\n";

    const names = [
      "f01.txt", "f02.txt", "f03.txt", "f04.txt", "f05.sh", "f06.txt",
      "f07.txt", "f08.txt", "f09.txt", "f10.txt", "f11.txt", "f12.txt",
    ];
    const skipNames = new Set(["f10.txt", "f12.txt"]);
    const crlfName = "f05.sh";

    for (const name of names) {
      const content = name === crlfName ? shellCrlf : normal(name);
      fs.writeFileSync(path.join(localDir, name), content, "utf8");
      if (skipNames.has(name)) {
        // Pre-seed the remote with byte-identical content so this file is
        // skipped rather than (re-)uploaded.
        fs.writeFileSync(destinationServer.toLocalPath(`${remoteDir}/${name}`), content, "utf8");
      }
    }

    const localPaths = names.map((name) => path.join(localDir, name));
    const result = await mcpClient.callTool({
      name: "upload",
      arguments: {
        localPath: localPaths,
        remotePath: remoteDir,
        connectionName: "destination",
        timeout: 5000,
      },
    });
    assert.equal(result.isError, undefined, responseText(result));
    const batch = parseBatchResult(result);

    assert.equal(batch.total, 12);
    assert.equal(batch.skippedCount, 2);
    assert.equal(batch.uploadedCount, 10);
    assert.equal(batch.failedCount, 0);
    assert.equal(batch.crlfFixedCount, 1);
    assert.equal(batch.results.length, 12);

    for (const name of names) {
      const fileResult = batch.results.find((r) => r.localPath === path.join(localDir, name));
      assert.ok(fileResult, `missing result for ${name}`);
      assert.equal(fileResult!.remotePath, `${remoteDir}/${name}`);
      if (skipNames.has(name)) {
        assert.equal(fileResult!.status, "skipped", `${name} should be skipped`);
      } else {
        assert.equal(fileResult!.status, "uploaded", `${name} should be uploaded`);
      }
      assert.equal(fileResult!.crlfFixed === true, name === crlfName, `${name} crlfFixed flag mismatch`);

      // Real remote end-state check: SHA-256 of the actual bytes written to
      // disk by the real SFTP server, against the expected local content
      // (LF-normalized for the shell script, since that is the one file
      // whose bytes are expected to differ from the raw local file).
      const remoteBytes = fs.readFileSync(destinationServer.toLocalPath(`${remoteDir}/${name}`));
      const expectedContent = name === crlfName ? shellLf : normal(name);
      assert.equal(sha256(remoteBytes), sha256(Buffer.from(expectedContent, "utf8")), `${name} remote content mismatch`);
    }
  });

  // ---------------------------------------------------------------------
  // P1-09-A2 (grey-box): a genuine failure injected on file 7 of 12.
  //
  // Windows note: chmod'ing a directory read-only does NOT block file
  // creation under it on this NTFS host (verified empirically: fs.chmod
  // only toggles the DOS read-only attribute, which Node's fs.open does not
  // consult for file creation). So the read-only-directory approach the
  // task description suggested cannot produce a genuine failure here. The
  // genuine, cross-platform, OS-level failure used instead: the batch's
  // 7th target path is pre-occupied by a real directory, so the real SFTP
  // server's real fs.open("w") on that path genuinely fails with EISDIR --
  // not a stubbed/thrown error, a real filesystem rejection surfaced
  // through the real ssh2 SFTP protocol.
  // ---------------------------------------------------------------------
  describe("P1-09-A2 (grey-box): real mid-batch failure, abort vs continue", () => {
    function buildFixture(localDir: string, remoteDir: string): { names: string[]; localPaths: string[] } {
      fs.mkdirSync(localDir, { recursive: true });
      fs.mkdirSync(destinationServer.toLocalPath(remoteDir), { recursive: true });
      const names = Array.from({ length: 12 }, (_, i) => `g${String(i + 1).padStart(2, "0")}.txt`);
      for (const name of names) {
        fs.writeFileSync(path.join(localDir, name), `payload for ${name}\n`, "utf8");
      }
      // File #7 (index 6) is a real directory on the remote side already --
      // genuinely un-openable for write, not a simulated error.
      fs.mkdirSync(destinationServer.toLocalPath(`${remoteDir}/${names[6]}`), { recursive: true });
      return { names, localPaths: names.map((name) => path.join(localDir, name)) };
    }

    test("onError=abort (default): files 1-6 uploaded, file 7 fails, files 8-12 never scheduled", async () => {
      const localDir = path.join(localRoot, "a2-abort-input");
      const remoteDir = "/batch-a2-abort";
      const { names, localPaths } = buildFixture(localDir, remoteDir);

      const openedBefore = destinationServer.stats.openedFiles;
      const result = await mcpClient.callTool({
        name: "upload",
        arguments: {
          localPath: localPaths,
          remotePath: remoteDir,
          connectionName: "destination",
          skipIfIdentical: false,
          fileConcurrency: 1,
          timeout: 5000,
        },
      });
      assert.equal(result.isError, undefined, responseText(result));
      const batch = parseBatchResult(result);

      assert.equal(batch.total, 12);
      assert.equal(batch.uploadedCount, 6, "files 1-6 should have uploaded before the failure");
      assert.equal(batch.failedCount, 6, "file 7 plus the 5 never-scheduled files after it");
      assert.equal(batch.skippedCount, 0);

      for (let i = 0; i < names.length; i++) {
        const fileResult = batch.results[i];
        assert.equal(fileResult.localPath, localPaths[i]);
        if (i < 6) {
          assert.equal(fileResult.status, "uploaded", `${names[i]} (index ${i}) should be uploaded`);
        } else if (i === 6) {
          assert.equal(fileResult.status, "failed", `${names[i]} should genuinely fail (EISDIR)`);
          assert.match(fileResult.reason ?? "", /illegal operation|EISDIR|directory/i);
        } else {
          assert.equal(fileResult.status, "failed", `${names[i]} (index ${i}) should never have been scheduled`);
          assert.match(fileResult.reason ?? "", /not attempted/i);
        }
      }

      // Real internal-counter evidence, not just the summary text: exactly
      // 6 real successful SFTP file opens happened (files 1-6). File 7's
      // real OPEN was attempted and genuinely failed (EISDIR), which this
      // counter does not record as a success. Files 8-12 never even reached
      // an OPEN call.
      assert.equal(destinationServer.stats.openedFiles - openedBefore, 6);

      // No half-written file remains for the file that failed (it was never
      // openable at all -- the failure happened at OPEN, before any WRITE),
      // and the directory occupying its target path is untouched.
      assert.ok(fs.statSync(destinationServer.toLocalPath(`${remoteDir}/${names[6]}`)).isDirectory());

      // Real end-state proof that later files were never scheduled: they do
      // not exist on the real remote filesystem at all.
      for (let i = 7; i < names.length; i++) {
        assert.equal(
          fs.existsSync(destinationServer.toLocalPath(`${remoteDir}/${names[i]}`)),
          false,
          `${names[i]} must not have been written`,
        );
      }
      // And the ones before the failure are genuinely there with real bytes.
      for (let i = 0; i < 6; i++) {
        assert.equal(
          fs.readFileSync(destinationServer.toLocalPath(`${remoteDir}/${names[i]}`), "utf8"),
          `payload for ${names[i]}\n`,
        );
      }
    });

    test("onError=continue: all files attempted, only file 7 fails, the other 11 succeed", async () => {
      const localDir = path.join(localRoot, "a2-continue-input");
      const remoteDir = "/batch-a2-continue";
      const { names, localPaths } = buildFixture(localDir, remoteDir);

      const openedBefore = destinationServer.stats.openedFiles;
      const result = await mcpClient.callTool({
        name: "upload",
        arguments: {
          localPath: localPaths,
          remotePath: remoteDir,
          connectionName: "destination",
          skipIfIdentical: false,
          fileConcurrency: 1,
          onError: "continue",
          timeout: 5000,
        },
      });
      assert.equal(result.isError, undefined, responseText(result));
      const batch = parseBatchResult(result);

      assert.equal(batch.total, 12);
      assert.equal(batch.uploadedCount, 11, "every file except file 7 should succeed");
      assert.equal(batch.failedCount, 1);
      assert.equal(batch.skippedCount, 0);

      for (let i = 0; i < names.length; i++) {
        const fileResult = batch.results[i];
        if (i === 6) {
          assert.equal(fileResult.status, "failed", `${names[i]} should genuinely fail (EISDIR)`);
          assert.match(fileResult.reason ?? "", /illegal operation|EISDIR|directory/i);
        } else {
          assert.equal(fileResult.status, "uploaded", `${names[i]} (index ${i}) should be uploaded`);
        }
      }

      // Real internal-counter evidence: all 11 non-directory files really
      // got a successful OPEN; file 7's real OPEN genuinely failed.
      assert.equal(destinationServer.stats.openedFiles - openedBefore, 11);
      assert.ok(fs.statSync(destinationServer.toLocalPath(`${remoteDir}/${names[6]}`)).isDirectory());
      for (let i = 0; i < names.length; i++) {
        if (i === 6) continue;
        assert.equal(
          fs.readFileSync(destinationServer.toLocalPath(`${remoteDir}/${names[i]}`), "utf8"),
          `payload for ${names[i]}\n`,
        );
      }
    });
  });

  // ---------------------------------------------------------------------
  // §5.7 edge cases reachable only through the MCP tool layer (schema +
  // tool-level guards), rounding out the acceptance beyond the pure
  // validation-function value tests above.
  // ---------------------------------------------------------------------
  describe("§5.7 tool-level contract", () => {
    test("string localPath keeps the original text response, byte-for-byte, via the upload tool", async () => {
      const localFile = path.join(localRoot, "single-string.txt");
      fs.writeFileSync(localFile, "single file content\n", "utf8");
      fs.mkdirSync(destinationServer.toLocalPath("/single-string"), { recursive: true });
      const result = await mcpClient.callTool({
        name: "upload",
        arguments: {
          localPath: localFile,
          remotePath: "/single-string/single-string.txt",
          connectionName: "destination",
          timeout: 5000,
        },
      });
      assert.equal(result.isError, undefined, responseText(result));
      assert.match(responseText(result), /^File uploaded successfully \(\d+ bytes via fast SFTP\)$/);
      assert.equal(
        fs.readFileSync(destinationServer.toLocalPath("/single-string/single-string.txt"), "utf8"),
        "single file content\n",
      );
    });

    test("archive:true with an array localPath is rejected by the transfer tool as INVALID_CONFIGURATION", async () => {
      const localDir = path.join(localRoot, "archive-batch-input");
      fs.mkdirSync(localDir, { recursive: true });
      const fileA = path.join(localDir, "a.txt");
      fs.writeFileSync(fileA, "a\n", "utf8");
      const result = await mcpClient.callTool({
        name: "transfer",
        arguments: {
          mode: "upload",
          localPath: [fileA],
          remotePath: "/archive-batch-rejected",
          connectionName: "destination",
          archive: true,
        },
      });
      assert.equal(result.isError, true);
      assert.match(responseText(result), /INVALID_CONFIGURATION/);
      assert.match(responseText(result), /archive/i);
      assert.equal(fs.existsSync(destinationServer.toLocalPath("/archive-batch-rejected")), false);
    });

    test("basename collision via the transfer tool fails before any remote write", async () => {
      const localDir = path.join(localRoot, "collision-input");
      fs.mkdirSync(path.join(localDir, "a"), { recursive: true });
      fs.mkdirSync(path.join(localDir, "b"), { recursive: true });
      const fileA = path.join(localDir, "a", "config.yaml");
      const fileB = path.join(localDir, "b", "config.yaml");
      fs.writeFileSync(fileA, "from a\n", "utf8");
      fs.writeFileSync(fileB, "from b\n", "utf8");

      const openedBefore = destinationServer.stats.openedFiles;
      const result = await mcpClient.callTool({
        name: "transfer",
        arguments: {
          mode: "upload",
          localPath: [fileA, fileB],
          remotePath: "/collision-rejected",
          connectionName: "destination",
        },
      });
      assert.equal(result.isError, true);
      assert.match(responseText(result), /BATCH_TARGET_COLLISION/);
      assert.match(responseText(result), /config\.yaml/);
      assert.equal(fs.existsSync(destinationServer.toLocalPath("/collision-rejected")), false);
      assert.equal(destinationServer.stats.openedFiles, openedBefore);
    });

    test("download mode with an array localPath is rejected (out of scope this round)", async () => {
      const result = await mcpClient.callTool({
        name: "transfer",
        arguments: {
          mode: "download",
          localPath: [path.join(localRoot, "wont-be-used.txt")],
          remotePath: "/does-not-matter",
          connectionName: "destination",
        },
      });
      assert.equal(result.isError, true);
      assert.match(responseText(result), /INVALID_CONFIGURATION/);
      assert.match(responseText(result), /mode="download"|download/i);
    });
  });
});
