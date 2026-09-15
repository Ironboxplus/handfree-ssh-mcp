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
import { flattenRemoteDirTree, type RemoteDirNode } from "../services/transfer-service.js";
import { registerTransferTool } from "../tools/transfer.js";
import { RealSshTestServer } from "./helpers/real-ssh-server.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

/**
 * The pre-order file list a fully-serial depth-first walk would have
 * produced, computed independently by re-reading the real filesystem (the
 * same source the real SFTP server's READDIR handler reads from) -- not by
 * calling into flattenRemoteDirTree or any other production ordering code.
 * Used as the black-box test's expected order.
 */
function serialPreOrderRelativeFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (dir: string, relative: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const entryRelative = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        visit(path.join(dir, entry.name), entryRelative);
      } else {
        files.push(entryRelative);
      }
    }
  };
  visit(root, "");
  return files;
}

type TreeSnapshot = Record<string, { kind: "directory" } | { kind: "file"; sha256: string }>;

function snapshotTree(root: string): TreeSnapshot {
  const snapshot: TreeSnapshot = {};
  const visit = (current: string, relative: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const entryRelative = relative ? `${relative}/${entry.name}` : entry.name;
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        snapshot[entryRelative] = { kind: "directory" };
        visit(entryPath, entryRelative);
      } else {
        snapshot[entryRelative] = { kind: "file", sha256: sha256(fs.readFileSync(entryPath)) };
      }
    }
  };
  visit(root, "");
  return snapshot;
}

/**
 * Mixed depth/width fixture, including an empty directory (`b/b2/b2-empty`)
 * and a directory containing only directories (`c/c1`), per the black-box
 * coverage requirement.
 */
function writeWalkerFixture(root: string): void {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "a.txt"), "a-content\n");
  fs.mkdirSync(path.join(root, "b"), { recursive: true });
  fs.writeFileSync(path.join(root, "b", "b1.txt"), "b1-content\n");
  fs.mkdirSync(path.join(root, "b", "b2", "b2-empty"), { recursive: true });
  fs.writeFileSync(path.join(root, "b", "b2", "b2a.txt"), "b2a-content\n");
  fs.mkdirSync(path.join(root, "c", "c1", "c1a"), { recursive: true });
  fs.writeFileSync(path.join(root, "c", "c1", "c1a", "c1a-file.txt"), "c1a-content\n");
  fs.mkdirSync(path.join(root, "c", "c1", "c1b"), { recursive: true });
  fs.writeFileSync(path.join(root, "c", "c1", "c1b", "c1b-file.txt"), "c1b-content\n");
  fs.writeFileSync(path.join(root, "c", "c2.txt"), "c2-content\n");
  fs.writeFileSync(path.join(root, "d.txt"), "d-content\n");
}

describe("P1-03 walker slice (§2.3 F5): bounded-concurrent remote directory discovery", { concurrency: false }, () => {
  const manager = SSHConnectionManager.getInstance();
  const transferService = manager.getTransferService();
  const suiteRoot = fs.mkdtempSync(path.join(os.tmpdir(), "handfree-walker-"));
  const localRoot = path.join(suiteRoot, "local");
  const fastServerRoot = path.join(suiteRoot, "fast-server");
  const slowServerRoot = path.join(suiteRoot, "slow-server");
  // No artificial delay -- used for the correctness/ordering black-box test,
  // which must stay fast.
  const fastServer = new RealSshTestServer(fastServerRoot);
  // A real per-OPENDIR delay (see real-ssh-server.ts) so genuinely
  // concurrent `readdir` calls reliably overlap in wall-clock terms. This is
  // a real server actually waiting before it answers, not a mock.
  const slowServer = new RealSshTestServer(slowServerRoot, 8, 60);
  const mcpServer = new McpServer({ name: "walker-real-test", version: "1.0.0" });
  const mcpClient = new Client({ name: "walker-real-client", version: "1.0.0" });

  before(async () => {
    fs.mkdirSync(localRoot, { recursive: true });
    await Promise.all([fastServer.start(), slowServer.start()]);
    manager.setConfig({
      fast: {
        host: "127.0.0.1",
        port: fastServer.port,
        username: "test",
        password: "test",
        disableSftpPathPolicy: true,
        keepaliveInterval: 0,
      },
      slow: {
        host: "127.0.0.1",
        port: slowServer.port,
        username: "test",
        password: "test",
        disableSftpPathPolicy: true,
        keepaliveInterval: 0,
      },
    }, ["fast", "slow"]);
    registerTransferTool(mcpServer);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await mcpServer.connect(serverTransport);
    await mcpClient.connect(clientTransport);
  });

  after(async () => {
    manager.disconnect();
    await Promise.all([mcpClient.close(), mcpServer.close()]);
    await Promise.all([fastServer.stop(), slowServer.stop()]);
    fs.rmSync(suiteRoot, { recursive: true, force: true });
    manager.setConfig({}, undefined);
  });

  // ---------------------------------------------------------------------
  // White-box: exhaustive tests of flattenRemoteDirTree, the pure ordering
  // helper that makes the walk's output independent of readdir completion
  // timing. No SSH/SFTP involved.
  // ---------------------------------------------------------------------
  describe("white-box: flattenRemoteDirTree ordering", () => {
    test("empty directory -> no files", () => {
      const root: RemoteDirNode = { children: [] };
      assert.deepEqual(flattenRemoteDirTree(root), []);
    });

    test("single file at the root", () => {
      const root: RemoteDirNode = {
        children: [{ kind: "file", remotePath: "/r/a.txt", localPath: "C:/r/a.txt" }],
      };
      assert.deepEqual(flattenRemoteDirTree(root), [{ remotePath: "/r/a.txt", localPath: "C:/r/a.txt" }]);
    });

    test("directory containing only an empty subdirectory -> no files", () => {
      const root: RemoteDirNode = { children: [{ kind: "dir", node: { children: [] } }] };
      assert.deepEqual(flattenRemoteDirTree(root), []);
    });

    test("deep chain: a single file at the bottom of a/b/c/d", () => {
      const leaf: RemoteDirNode = {
        children: [{ kind: "file", remotePath: "/a/b/c/d/leaf.txt", localPath: "leaf" }],
      };
      const c: RemoteDirNode = { children: [{ kind: "dir", node: leaf }] };
      const b: RemoteDirNode = { children: [{ kind: "dir", node: c }] };
      const a: RemoteDirNode = { children: [{ kind: "dir", node: b }] };
      assert.deepEqual(flattenRemoteDirTree(a), [{ remotePath: "/a/b/c/d/leaf.txt", localPath: "leaf" }]);
    });

    test("wide fan-out: many sibling files and many sibling directories, each with their own file", () => {
      const dirNode = (name: string): RemoteDirNode => ({
        children: [{ kind: "file", remotePath: `/root/${name}/only.txt`, localPath: `${name}/only.txt` }],
      });
      const root: RemoteDirNode = {
        children: [
          { kind: "file", remotePath: "/root/f1.txt", localPath: "f1.txt" },
          { kind: "dir", node: dirNode("dir-a") },
          { kind: "file", remotePath: "/root/f2.txt", localPath: "f2.txt" },
          { kind: "dir", node: dirNode("dir-b") },
          { kind: "dir", node: dirNode("dir-c") },
          { kind: "file", remotePath: "/root/f3.txt", localPath: "f3.txt" },
        ],
      };
      assert.deepEqual(
        flattenRemoteDirTree(root).map((f) => f.remotePath),
        [
          "/root/f1.txt",
          "/root/dir-a/only.txt",
          "/root/f2.txt",
          "/root/dir-b/only.txt",
          "/root/dir-c/only.txt",
          "/root/f3.txt",
        ],
      );
    });

    test("a subdirectory's entire contents are inlined at its entry's position before the next sibling entry", () => {
      // Proves real depth-first pre-order interleaving, not "all files then
      // all dirs" or any other order that would also satisfy the simpler
      // fan-out case above.
      const nested: RemoteDirNode = {
        children: [
          { kind: "file", remotePath: "/root/mid/x.txt", localPath: "mid/x.txt" },
          {
            kind: "dir",
            node: { children: [{ kind: "file", remotePath: "/root/mid/y/z.txt", localPath: "mid/y/z.txt" }] },
          },
        ],
      };
      const root: RemoteDirNode = {
        children: [
          { kind: "file", remotePath: "/root/before.txt", localPath: "before.txt" },
          { kind: "dir", node: nested },
          { kind: "file", remotePath: "/root/after.txt", localPath: "after.txt" },
        ],
      };
      assert.deepEqual(
        flattenRemoteDirTree(root).map((f) => f.remotePath),
        ["/root/before.txt", "/root/mid/x.txt", "/root/mid/y/z.txt", "/root/after.txt"],
      );
    });
  });

  // ---------------------------------------------------------------------
  // Black-box: a real nested remote tree (mixed depth/width, an empty
  // directory, a directory containing only directories) downloads
  // completely and correctly through the real "transfer" MCP tool. Every
  // file present with correct bytes, and the returned path list correct and
  // in the documented (unchanged, pre-order depth-first) order.
  // ---------------------------------------------------------------------
  test("black-box: full tree downloads correctly with deterministic pre-order file list", async () => {
    const remoteRoot = fastServer.toLocalPath("/walker-tree");
    writeWalkerFixture(remoteRoot);
    const expectedOrder = serialPreOrderRelativeFiles(remoteRoot);
    assert.ok(expectedOrder.length >= 5, "fixture sanity: expected several files");

    const output = path.join(localRoot, "black-box-output");
    const result = await mcpClient.callTool({
      name: "transfer",
      arguments: {
        mode: "download",
        connectionName: "fast",
        remotePath: "/walker-tree",
        localPath: output,
        recursive: true,
        fileConcurrency: 4,
        timeout: 5000,
      },
    });
    assert.equal(result.isError, undefined, responseText(result));
    const parsed = JSON.parse(responseText(result)) as { summary: string; files: string[] };

    // Byte-for-byte correctness, including the empty directory and the
    // directory-of-only-directories.
    assert.deepEqual(snapshotTree(output), snapshotTree(remoteRoot));

    // Order: convert the tool's absolute local paths back to root-relative,
    // forward-slash form and compare against the independently-computed
    // serial pre-order -- this must hold regardless of which concurrent
    // `readdir` happened to finish first.
    const actualOrder = parsed.files.map((absolute) => path.relative(output, absolute).split(path.sep).join("/"));
    assert.deepEqual(actualOrder, expectedOrder);
    assert.equal(parsed.summary, `Recursive download complete. ${expectedOrder.length} file(s) transferred.`);

    // Every discovered directory got a real local mkdir, including the empty
    // one and the directory that itself contains only directories.
    assert.ok(fs.statSync(path.join(output, "b", "b2", "b2-empty")).isDirectory());
    assert.ok(fs.statSync(path.join(output, "c", "c1")).isDirectory());
    assert.equal(fs.readdirSync(path.join(output, "c", "c1")).sort().join(","), "c1a,c1b");
  });

  // ---------------------------------------------------------------------
  // Grey-box: prove the walk is actually concurrent using real counters on
  // the real test server (activeReaddirs/maxActiveReaddirs -- distinct from
  // the existing activeSftpChannels, so this measures readdir concurrency
  // specifically), not wall-clock. slowServer's real injected per-OPENDIR
  // delay makes the overlap observable and non-flaky.
  // ---------------------------------------------------------------------
  test("grey-box: a wide tree reaches real peak concurrent readdir > 1 and never exceeds the requested cap", async () => {
    const remoteRoot = slowServer.toLocalPath("/wide-tree");
    fs.mkdirSync(remoteRoot, { recursive: true });
    const directoryCount = 12;
    for (let i = 0; i < directoryCount; i++) {
      const dir = path.join(remoteRoot, `dir-${String(i).padStart(2, "0")}`);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "only.txt"), `content-${i}\n`);
    }

    slowServer.resetReaddirPeak();
    const output = path.join(localRoot, "grey-box-output");
    const startedAt = Date.now();
    const files = await transferService.downloadDirectory("/wide-tree", output, "slow", { fileConcurrency: 4 });
    const elapsedMs = Date.now() - startedAt;

    assert.equal(files.length, directoryCount);
    const peak = slowServer.stats.maxActiveReaddirs;
    assert.ok(peak > 1, `expected genuine concurrent readdir, observed peak: ${peak}`);
    assert.ok(peak <= 4, `observed peak concurrent readdir: ${peak}, requested cap is 4`);

    // Secondary, looser corroboration: 12 directories at 60ms/readdir would
    // take roughly 780ms fully serial (1 root + 12 children); bounded
    // concurrency at 4 should finish in well under half that. This is not
    // the primary evidence -- the counter assertions above are -- but a
    // gross timing sanity check catches a walker that silently degraded
    // back to serial.
    assert.ok(elapsedMs < 500, `expected well under serial time, took ${elapsedMs}ms`);
  });

  test("grey-box: the same shape of wide tree with fileConcurrency=1 stays fully serial (peak == 1)", async () => {
    const remoteRoot = slowServer.toLocalPath("/wide-tree-serial");
    fs.mkdirSync(remoteRoot, { recursive: true });
    for (let i = 0; i < 6; i++) {
      const dir = path.join(remoteRoot, `dir-${i}`);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "only.txt"), `content-${i}\n`);
    }

    slowServer.resetReaddirPeak();
    const output = path.join(localRoot, "grey-box-serial-output");
    await transferService.downloadDirectory("/wide-tree-serial", output, "slow", { fileConcurrency: 1 });
    assert.equal(slowServer.stats.maxActiveReaddirs, 1, "fileConcurrency=1 must keep discovery serial");
  });

  // ---------------------------------------------------------------------
  // Failure semantics: a real failure in one subdirectory's real readdir
  // must still fail the whole call, and siblings already in flight must be
  // drained (run to completion) rather than left dangling.
  // ---------------------------------------------------------------------
  test("a real mid-walk readdir failure fails the whole call after draining in-flight siblings", async () => {
    const remoteRoot = slowServer.toLocalPath("/vanish-tree");
    fs.mkdirSync(remoteRoot, { recursive: true });
    const survivorA = path.join(remoteRoot, "survivor-a");
    const survivorB = path.join(remoteRoot, "survivor-b");
    const vanishing = path.join(remoteRoot, "will-vanish");
    fs.mkdirSync(survivorA, { recursive: true });
    fs.mkdirSync(survivorB, { recursive: true });
    fs.mkdirSync(vanishing, { recursive: true });
    fs.writeFileSync(path.join(survivorA, "a.txt"), "a\n");
    fs.writeFileSync(path.join(survivorB, "b.txt"), "b\n");
    fs.writeFileSync(path.join(vanishing, "v.txt"), "v\n");

    const output = path.join(localRoot, "vanish-output");
    const openDirRequestsBefore = slowServer.stats.openDirRequests;
    const downloadPromise = transferService.downloadDirectory("/vanish-tree", output, "slow", { fileConcurrency: 4 });
    // slowServer holds every OPENDIR request for 60ms (see
    // real-ssh-server.ts) before its real fs.readdir call actually runs, so
    // the request-received moment and the real-disk-read moment are
    // distinct and real time apart. Rather than guess a wall-clock sleep
    // long enough to land in that window (flaky under system load -- root's
    // own round trip time is not guaranteed), poll the server's real
    // cumulative OPENDIR-request counter until all 4 requests (root +
    // survivor-a + survivor-b + will-vanish) have actually arrived. Only
    // then do we know "will-vanish"'s OPENDIR was received but its fs.readdir
    // has not fired yet, so deleting it now makes that later real
    // fs.readdir genuinely fail with ENOENT -- not a stubbed error.
    const expectedOpenDirRequests = openDirRequestsBefore + 4;
    const deadline = Date.now() + 5000;
    while (slowServer.stats.openDirRequests < expectedOpenDirRequests) {
      if (Date.now() > deadline) {
        assert.fail(
          `timed out waiting for ${expectedOpenDirRequests} OPENDIR requests, ` +
            `observed ${slowServer.stats.openDirRequests}`,
        );
      }
      await sleep(2);
    }
    fs.rmSync(vanishing, { recursive: true, force: true });

    await assert.rejects(downloadPromise, (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Failed to list remote directory/);
      return true;
    });

    // Drained, not dangling: the two siblings that were already in flight
    // when the failure occurred ran to completion -- their local
    // directories were really created.
    assert.ok(fs.statSync(path.join(output, "survivor-a")).isDirectory());
    assert.ok(fs.statSync(path.join(output, "survivor-b")).isDirectory());
  });

  // Reviewer-added. The test above uses fileConcurrency=4 on a 4-directory
  // tree, so every directory is in flight and nothing is ever queued behind
  // the semaphore -- it cannot observe what happens to *queued* directories
  // when a sibling fails. On a wide tree the queue is the common case, and
  // the original implementation re-checked the error flag only before
  // acquiring a slot, never after. Every directory already queued therefore
  // still issued its own doomed listing, so the caller waited out the whole
  // remaining queue before seeing the error.
  test("a mid-walk failure on a wide tree stops scheduling queued directories instead of draining the whole queue", async () => {
    const remoteRoot = slowServer.toLocalPath("/wide-abort-tree");
    fs.mkdirSync(remoteRoot, { recursive: true });
    const WIDTH = 40;
    const names = Array.from({ length: WIDTH }, (_, i) => `d${String(i).padStart(3, "0")}`);
    for (const name of names) {
      const dir = path.join(remoteRoot, name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "f.txt"), `${name}\n`);
    }

    const output = path.join(localRoot, "wide-abort-output");
    const openDirRequestsBefore = slowServer.stats.openDirRequests;
    const CONCURRENCY = 4;
    const downloadPromise = transferService.downloadDirectory("/wide-abort-tree", output, "slow", {
      fileConcurrency: CONCURRENCY,
    });

    // Same real synchronization technique as the test above: wait until the
    // root listing plus the first full concurrent wave of OPENDIR requests
    // have genuinely arrived, then delete one of those in-flight directories
    // so its pending real fs.readdir genuinely fails with ENOENT.
    const expected = openDirRequestsBefore + 1 + CONCURRENCY;
    const deadline = Date.now() + 5000;
    while (slowServer.stats.openDirRequests < expected) {
      if (Date.now() > deadline) {
        assert.fail(
          `timed out waiting for ${expected} OPENDIR requests, observed ${slowServer.stats.openDirRequests}`,
        );
      }
      await sleep(2);
    }
    fs.rmSync(path.join(remoteRoot, names[0]), { recursive: true, force: true });

    await assert.rejects(downloadPromise, (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Failed to list remote directory/);
      return true;
    });

    // The bound that matters: the walk must not have listed all 40
    // directories. Root + the first wave are unavoidable (already issued
    // before the failure existed), and directories that had already acquired
    // a slot may legitimately complete -- but the ~35 still queued must not
    // each fire their own listing. Without the fix this reaches 41.
    const issued = slowServer.stats.openDirRequests - openDirRequestsBefore;
    assert.ok(
      issued < WIDTH,
      `expected the walk to abandon queued directories, but it issued ${issued} OPENDIR requests for a ${WIDTH}-directory tree`,
    );
  });
});
