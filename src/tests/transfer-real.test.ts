import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSHConnectionManager, buildLocalTarArgv, type ArchiveCompression } from "../services/ssh-connection-manager.js";
import { registerTransferTool } from "../tools/transfer.js";
import { RealSshTestServer } from "./helpers/real-ssh-server.js";

type TreeSnapshot = Record<string, { kind: "directory" } | { kind: "file"; size: number; sha256: string }>;

function writeFixtureTree(root: string, fileCount = 4): void {
  fs.mkdirSync(path.join(root, "nested", "empty"), { recursive: true });
  fs.writeFileSync(path.join(root, "hello.txt"), "真实传输数据\nline two\n", "utf8");
  fs.writeFileSync(path.join(root, "nested", "binary.bin"), Buffer.from(Array.from({ length: 4096 }, (_, i) => i % 251)));
  fs.writeFileSync(path.join(root, "nested", "empty-file"), Buffer.alloc(0));
  fs.writeFileSync(path.join(root, "nested", "odd ' name.txt"), "quoted basename", "utf8");
  for (let index = 0; index < fileCount; index++) {
    const directory = path.join(root, "small", `group-${index % 4}`);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, `file-${index}.dat`), Buffer.alloc(2048 + index, index % 256));
  }
}

function snapshotTree(root: string): TreeSnapshot {
  const snapshot: TreeSnapshot = {};
  const visit = (current: string, relative: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const entryRelative = relative ? `${relative}/${entry.name}` : entry.name;
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        snapshot[entryRelative] = { kind: "directory" };
        visit(entryPath, entryRelative);
      } else {
        const data = fs.readFileSync(entryPath);
        snapshot[entryRelative] = {
          kind: "file",
          size: data.length,
          sha256: createHash("sha256").update(data).digest("hex"),
        };
      }
    }
  };
  visit(root, "");
  return snapshot;
}

function assertTreeEqual(actualRoot: string, expectedRoot: string): void {
  assert.deepEqual(snapshotTree(actualRoot), snapshotTree(expectedRoot));
}

function temporaryArchiveNames(root: string): string[] {
  const matches: string[] = [];
  const visit = (current: string): void => {
    if (!fs.existsSync(current)) return;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.name.startsWith(".handfree-transfer-")) matches.push(entryPath);
      if (entry.isDirectory()) visit(entryPath);
    }
  };
  visit(root);
  return matches.sort();
}

function responseText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = result.content as Array<{ type: string; text?: string }>;
  return content
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .filter((text): text is string => typeof text === "string")
    .join("\n");
}

describe("transfer real execution acceptance", { concurrency: false }, () => {
  const manager = SSHConnectionManager.getInstance();
  const suiteRoot = fs.mkdtempSync(path.join(os.tmpdir(), "handfree-transfer-real-"));
  const sourceServerRoot = path.join(suiteRoot, "source-server");
  const destinationServerRoot = path.join(suiteRoot, "destination-server");
  const localRoot = path.join(suiteRoot, "local");
  const sourceServer = new RealSshTestServer(sourceServerRoot);
  const destinationServer = new RealSshTestServer(destinationServerRoot);
  const mcpServer = new McpServer({ name: "transfer-real-test", version: "1.0.0" });
  const mcpClient = new Client({ name: "transfer-real-client", version: "1.0.0" });
  const initialHostWorkspaces = new Set(
    fs.readdirSync(process.cwd()).filter((name) => name.startsWith(".handfree-transfer-")),
  );
  const initialTmpWorkspaces = new Set(
    fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith(".handfree-transfer-")),
  );
  const newTmpWorkspaces = (): string[] =>
    fs.readdirSync(os.tmpdir())
      .filter((name) => name.startsWith(".handfree-transfer-"))
      .filter((name) => !initialTmpWorkspaces.has(name));

  before(async () => {
    fs.mkdirSync(localRoot, { recursive: true });
    await Promise.all([sourceServer.start(), destinationServer.start()]);
    manager.setConfig({
      source: {
        host: "127.0.0.1",
        port: sourceServer.port,
        username: "test",
        password: "test",
        disableSftpPathPolicy: true,
        keepaliveInterval: 0,
      },
      destination: {
        host: "127.0.0.1",
        port: destinationServer.port,
        username: "test",
        password: "test",
        disableSftpPathPolicy: true,
        keepaliveInterval: 0,
      },
    }, ["source", "destination"]);
    registerTransferTool(mcpServer);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await mcpServer.connect(serverTransport);
    await mcpClient.connect(clientTransport);
  });

  after(async () => {
    manager.disconnect();
    await Promise.all([mcpClient.close(), mcpServer.close()]);
    await Promise.all([sourceServer.stop(), destinationServer.stop()]);
    fs.rmSync(suiteRoot, { recursive: true, force: true });
    manager.setConfig({}, undefined);
  });

  test("white-box: buildLocalTarArgv is exhaustively pinned for both platform branches", () => {
    // This is a pure function that takes platform as a parameter specifically
    // so both branches can be verified from a single test run regardless of
    // which OS actually executes the suite (a Windows CI run alone can never
    // exercise the non-win32 branch, and vice versa; see G1).
    const cases: Array<{ description: string; args: string[]; platform: NodeJS.Platform; expected: string[] }> = [
      {
        description: "win32 + drive-letter archive path and -C directory",
        args: ["-cf", "E:\\a\\b.tar", "-C", "C:\\Users\\x"],
        platform: "win32",
        expected: ["--force-local", "-cf", "E:/a/b.tar", "-C", "C:/Users/x"],
      },
      {
        description: "win32 + flags-only argv is untouched apart from the --force-local prefix",
        args: ["-czf", "--zstd"],
        platform: "win32",
        expected: ["--force-local", "-czf", "--zstd"],
      },
      {
        description: "win32 + basename with a space and a quote (no backslash) is untouched content-wise",
        args: ["-cf", "E:\\work\\out.tar", "-C", "E:\\work", "--", "payload ' source"],
        platform: "win32",
        expected: ["--force-local", "-cf", "E:/work/out.tar", "-C", "E:/work", "--", "payload ' source"],
      },
      {
        // Pinned intended behaviour: a UNC path is treated like any other
        // argument. `\\server\share\x` becomes `//server/share/x`, which is
        // the standard MSYS/Cygwin spelling of a UNC path (a leading `//` is
        // specifically recognized as a UNC prefix), so this is not just safe
        // but the idiomatic form for this tar build. UNC paths never contain
        // a drive-letter colon, so --force-local is not required for them
        // specifically, but it is still added because the rewrite is a single
        // platform-wide transform, not a per-argument path-shape decision.
        description: "win32 + UNC path is forward-slash-converted (pinned, not left undefined)",
        args: ["-xf", "\\\\server\\share\\x\\archive.tar", "-C", "\\\\server\\share\\x"],
        platform: "win32",
        expected: ["--force-local", "-xf", "//server/share/x/archive.tar", "-C", "//server/share/x"],
      },
      {
        description: "linux: argv passes through byte-identical, no --force-local",
        args: ["-cf", "/tmp/a/b.tar", "-C", "/tmp/a", "--", "basename"],
        platform: "linux",
        expected: ["-cf", "/tmp/a/b.tar", "-C", "/tmp/a", "--", "basename"],
      },
      {
        description: "darwin: argv passes through byte-identical, no --force-local",
        args: ["-cf", "/Users/x/b.tar", "-C", "/Users/x"],
        platform: "darwin",
        expected: ["-cf", "/Users/x/b.tar", "-C", "/Users/x"],
      },
      {
        // Backslash is a legal POSIX filename character. This is exactly why
        // the forward-slash rewrite must stay win32-only: applying it on
        // linux/darwin would corrupt a real, legitimately-named file.
        description: "linux: a filename that legitimately contains a backslash is not mangled",
        args: ["-cf", "/tmp/out.tar", "-C", "/tmp", "--", "weird\\name.txt"],
        platform: "linux",
        expected: ["-cf", "/tmp/out.tar", "-C", "/tmp", "--", "weird\\name.txt"],
      },
    ];

    for (const { description, args, platform, expected } of cases) {
      const actual = buildLocalTarArgv(args, platform);
      assert.deepEqual(actual, expected, `${description}: got ${JSON.stringify(actual)}`);
    }
  });

  test("white-box: local archive workspace is created under os.tmpdir(), not process.cwd()", () => {
    const privateManager = manager as any;
    const tmpRoot = fs.realpathSync(os.tmpdir());
    const cwdRoot = fs.realpathSync(process.cwd());
    const work = privateManager.transferService.createLocalArchiveWorkspace("none") as { directory: string; archivePath: string };
    try {
      const resolvedDirectory = fs.realpathSync(work.directory);
      assert.ok(
        resolvedDirectory === tmpRoot || resolvedDirectory.startsWith(tmpRoot + path.sep),
        `expected workspace '${resolvedDirectory}' to be under os.tmpdir() '${tmpRoot}'`,
      );
      assert.ok(
        resolvedDirectory !== cwdRoot && !resolvedDirectory.startsWith(cwdRoot + path.sep),
        `workspace '${resolvedDirectory}' must not be created under process.cwd() '${cwdRoot}'`,
      );
      // The upload of the temp archive itself is an internal call the service
      // makes to its own generated path, not user input; validateLocalPath
      // must exempt it rather than reject it as outside the local path policy.
      // Call with no server name so the default policy (only cwd implicitly
      // allowed) actually runs instead of being short-circuited by this
      // suite's disableSftpPathPolicy server config.
      assert.doesNotThrow(() => privateManager.validateLocalPath(work.archivePath));
    } finally {
      privateManager.transferService.cleanupLocalArchiveWorkspace(work.directory);
    }
  });

  test("white-box: every compression mode creates and extracts real tar data", async () => {
    const privateManager = manager as any;
    const inputParent = path.join(localRoot, "white-box-input");
    const input = path.join(inputParent, "payload ' source");
    fs.mkdirSync(input, { recursive: true });
    writeFixtureTree(input, 6);

    for (const compression of ["none", "gzip", "bzip2", "xz", "zstd"] satisfies ArchiveCompression[]) {
      const work = privateManager.transferService.createLocalArchiveWorkspace(compression) as { directory: string; archivePath: string };
      const output = path.join(localRoot, `white-box-output-${compression}`);
      fs.mkdirSync(output, { recursive: true });
      try {
        await privateManager.transferService.runLocalTar(
          privateManager.transferService.archiveCreateArgs(work.archivePath, input, compression, path),
          `white-box create ${compression}`,
          "LOCAL_FILE_READ_FAILED",
        );
        assert.ok(fs.statSync(work.archivePath).size > 0, `${compression} archive should contain real bytes`);
        await privateManager.transferService.runLocalTar(
          privateManager.transferService.archiveExtractArgs(work.archivePath, output, compression),
          `white-box extract ${compression}`,
          "LOCAL_FILE_WRITE_FAILED",
        );
        assertTreeEqual(path.join(output, path.basename(input)), input);
      } finally {
        privateManager.transferService.cleanupLocalArchiveWorkspace(work.directory);
      }
    }
  });

  test("white-box: relay worker count is pinned for representative (sourceSize, chunkSize, concurrency) triples", () => {
    const privateManager = manager as any;
    const cases: Array<{ sourceSize: number; chunkSize: number; concurrency: number; expected: number }> = [
      // Exact division: chunks == concurrency, no remainder.
      { sourceSize: 640, chunkSize: 10, concurrency: 64, expected: 64 },
      // Remainder forces one extra partial-chunk worker, still under the cap.
      { sourceSize: 105, chunkSize: 10, concurrency: 64, expected: 11 },
      // Smaller than one chunk: exactly one worker regardless of concurrency.
      { sourceSize: 1, chunkSize: 32768, concurrency: 64, expected: 1 },
      // Chunk count exactly equals the concurrency cap.
      { sourceSize: 64 * 32768, chunkSize: 32768, concurrency: 64, expected: 64 },
      // One byte over an exact multiple: chunk count would be 65, capped to 64.
      { sourceSize: 64 * 32768 + 1, chunkSize: 32768, concurrency: 64, expected: 64 },
      // Concurrency is the binding constraint, far below chunk count.
      { sourceSize: 1_000_000, chunkSize: 8192, concurrency: 8, expected: 8 },
      // Chunk count is the binding constraint, far below concurrency.
      { sourceSize: 5, chunkSize: 1, concurrency: 2, expected: 2 },
      // concurrency=1 always serializes to exactly one worker.
      { sourceSize: 999_999, chunkSize: 1, concurrency: 1, expected: 1 },
    ];
    for (const { sourceSize, chunkSize, concurrency, expected } of cases) {
      const actual = privateManager.transferService.resolveRelayWorkerCount(sourceSize, chunkSize, concurrency);
      assert.equal(
        actual,
        expected,
        `resolveRelayWorkerCount(${sourceSize}, ${chunkSize}, ${concurrency}) should be ${expected}, got ${actual}`,
      );
    }
  });

  test("black-box MCP: archive upload defaults to fast SFTP and cleans temporary archives", async () => {
    const input = path.join(localRoot, "upload ' source");
    writeFixtureTree(input, 8);
    const result = await mcpClient.callTool({
      name: "transfer",
      arguments: {
        mode: "upload",
        connectionName: "destination",
        localPath: input,
        remotePath: "/archive-upload",
        archive: true,
        archiveCompression: "gzip",
        timeout: 5000,
      },
    });
    assert.equal(result.isError, undefined, responseText(result));
    assert.match(responseText(result), /Archive upload complete \(gzip\)/);
    assertTreeEqual(destinationServer.toLocalPath("/archive-upload/upload ' source"), input);
    assert.deepEqual(temporaryArchiveNames(destinationServerRoot), []);
  });

  test("black-box MCP: archive download packs remotely, extracts locally, and cleans both sides", async () => {
    const remoteInput = sourceServer.toLocalPath("/archive-download/source-tree");
    writeFixtureTree(remoteInput, 7);
    const output = path.join(localRoot, "archive-download-output");
    const result = await mcpClient.callTool({
      name: "transfer",
      arguments: {
        mode: "download",
        connectionName: "source",
        remotePath: "/archive-download/source-tree",
        localPath: output,
        archive: true,
        archiveCompression: "xz",
        timeout: 5000,
      },
    });
    assert.equal(result.isError, undefined, responseText(result));
    assert.match(responseText(result), /Archive download complete \(xz\)/);
    assertTreeEqual(path.join(output, "source-tree"), remoteInput);
    assert.deepEqual(temporaryArchiveNames(sourceServerRoot), []);
  });

  test("black-box MCP: archive relay uses real SSH endpoints and bounded relay transfer", async () => {
    const remoteInput = sourceServer.toLocalPath("/relay-input/relay-tree");
    writeFixtureTree(remoteInput, 9);
    const result = await mcpClient.callTool({
      name: "transfer",
      arguments: {
        mode: "relay",
        sourceServer: "source",
        sourceRemotePath: "/relay-input/relay-tree",
        destServer: "destination",
        destRemotePath: "/relay-output",
        archive: true,
        archiveCompression: "none",
        sftpConcurrency: 8,
        chunkSize: 8192,
        timeout: 5000,
      },
    });
    assert.equal(result.isError, undefined, responseText(result));
    assert.match(responseText(result), /Archive relay complete \(none\)/);
    assertTreeEqual(destinationServer.toLocalPath("/relay-output/relay-tree"), remoteInput);
    assert.deepEqual(temporaryArchiveNames(sourceServerRoot), []);
    assert.deepEqual(temporaryArchiveNames(destinationServerRoot), []);
  });

  test("black-box MCP: non-archive recursive transfer runs multiple small files concurrently", async () => {
    const input = path.join(localRoot, "many-small-input");
    writeFixtureTree(input, 32);
    fs.mkdirSync(destinationServer.toLocalPath("/many-small"), { recursive: true });
    const uploadResult = await mcpClient.callTool({
      name: "transfer",
      arguments: {
        mode: "upload",
        connectionName: "destination",
        localPath: input,
        remotePath: "/many-small/uploaded",
        recursive: true,
        fileConcurrency: 6,
        skipIfIdentical: false,
        timeout: 5000,
      },
    });
    assert.equal(uploadResult.isError, undefined, responseText(uploadResult));
    assert.match(responseText(uploadResult), /Recursive upload complete/);
    assert.ok(destinationServer.stats.maxActiveWrites >= 2, `observed max active writes: ${destinationServer.stats.maxActiveWrites}`);
    assertTreeEqual(destinationServer.toLocalPath("/many-small/uploaded"), input);

    const output = path.join(localRoot, "many-small-downloaded");
    const downloadResult = await mcpClient.callTool({
      name: "transfer",
      arguments: {
        mode: "download",
        connectionName: "destination",
        remotePath: "/many-small/uploaded",
        localPath: output,
        recursive: true,
        fileConcurrency: 5,
        timeout: 5000,
      },
    });
    assert.equal(downloadResult.isError, undefined, responseText(downloadResult));
    assertTreeEqual(output, input);
  });

  test("black-box MCP: omitted fast option uses fast SFTP by default", async () => {
    const input = path.join(localRoot, "fast-default.bin");
    fs.writeFileSync(input, Buffer.alloc(512 * 1024, 0x5a));
    fs.mkdirSync(destinationServer.toLocalPath("/single"), { recursive: true });
    const result = await mcpClient.callTool({
      name: "transfer",
      arguments: {
        mode: "upload",
        connectionName: "destination",
        localPath: input,
        remotePath: "/single/fast-default.bin",
        skipIfIdentical: false,
        timeout: 5000,
      },
    });
    assert.equal(result.isError, undefined, responseText(result));
    assert.match(responseText(result), /via fast SFTP/);
    assert.deepEqual(
      fs.readFileSync(destinationServer.toLocalPath("/single/fast-default.bin")),
      fs.readFileSync(input),
    );
  });

  test("black-box MCP: fileConcurrency above the hard bound fails before remote mutation", async () => {
    const input = path.join(localRoot, "invalid-concurrency-input");
    writeFixtureTree(input, 2);
    const result = await mcpClient.callTool({
      name: "transfer",
      arguments: {
        mode: "upload",
        connectionName: "destination",
        localPath: input,
        remotePath: "/must-not-be-created",
        recursive: true,
        fileConcurrency: 9,
      },
    });
    assert.equal(result.isError, true);
    assert.match(responseText(result), /fileConcurrency.*(?:maximum|exceed).*8/i);
    assert.equal(fs.existsSync(destinationServer.toLocalPath("/must-not-be-created")), false);
  });

  test("grey-box: recursive upload at the fileConcurrency cap never opens more real SFTP channels than the cap", async () => {
    const input = path.join(localRoot, "cap-concurrency-input");
    writeFixtureTree(input, 24);
    // maxActiveSftpChannels is a high-water mark accumulated across the whole
    // server's lifetime (every earlier test that shared this server). Reset
    // it to the current live count immediately before the transfer under
    // test so the assertions below can only be satisfied by concurrency this
    // transfer itself produced — comparing against accumulated state would be
    // order- and timing-dependent (an earlier test could have already pushed
    // the peak to 8, or this run's genuine peak could be masked by a higher
    // one left over from before). See G2.
    destinationServer.resetChannelPeak();
    const result = await mcpClient.callTool({
      name: "transfer",
      arguments: {
        mode: "upload",
        connectionName: "destination",
        localPath: input,
        remotePath: "/cap-concurrency",
        recursive: true,
        fileConcurrency: 8,
        skipIfIdentical: false,
        timeout: 5000,
      },
    });
    assert.equal(result.isError, undefined, responseText(result));
    assertTreeEqual(destinationServer.toLocalPath("/cap-concurrency"), input);
    const peak = destinationServer.stats.maxActiveSftpChannels;
    // This is the real invariant the fileConcurrency cap of 8 exists to protect:
    // OpenSSH's default MaxSessions=10 bounds concurrently open channels on one
    // connection, and every upload() call opens its own SFTP channel. The
    // observed peak (a real server-side channel count, not client bookkeeping)
    // must never exceed the cap.
    assert.ok(peak <= 8, `observed peak concurrent SFTP channels: ${peak}, cap is 8`);
    // And prove genuine concurrency actually happened during this transfer,
    // so the <= 8 assertion above is evidence of a respected cap rather than
    // an accidentally serial run.
    assert.ok(peak > 1, `expected genuine concurrency, observed peak: ${peak}`);
  });

  test("black-box MCP: archiveCompression without archive is rejected before transfer", async () => {
    const result = await mcpClient.callTool({
      name: "transfer",
      arguments: {
        mode: "upload",
        connectionName: "destination",
        localPath: path.join(localRoot, "does-not-matter"),
        remotePath: "/does-not-matter",
        archiveCompression: "gzip",
      },
    });
    assert.equal(result.isError, true);
    assert.match(responseText(result), /archiveCompression requires archive=true/);
  });

  test("black-box + grey-box: a real failure after workspace creation still cleans up the local archive workspace", async () => {
    // Force a genuine remote-side failure that only surfaces after the local
    // archive workspace has already been created and the tar has already
    // been packed: pre-create a plain FILE at the path uploadArchive will try
    // to mkdir -p into and then upload the archive under. Real SFTP against a
    // real conflicting path fails (mkdir or the subsequent open, depending on
    // the server's own mkdir-on-existing-path tolerance) — no stubbing involved.
    const conflictingFilePath = destinationServer.toLocalPath("/archive-upload-fail-target");
    fs.mkdirSync(path.dirname(conflictingFilePath), { recursive: true });
    fs.writeFileSync(conflictingFilePath, "not a directory");

    const input = path.join(localRoot, "upload-failure-source");
    writeFixtureTree(input, 3);
    const before = newTmpWorkspaces();
    const result = await mcpClient.callTool({
      name: "transfer",
      arguments: {
        mode: "upload",
        connectionName: "destination",
        localPath: input,
        remotePath: "/archive-upload-fail-target",
        archive: true,
        archiveCompression: "none",
        timeout: 5000,
      },
    });
    assert.equal(result.isError, true, "expected the conflicting remote path to fail mkdir");
    const after = newTmpWorkspaces();
    assert.deepEqual(after, before, "a failed archive upload must not leave a workspace behind in os.tmpdir()");
  });

  test("all host-side temporary archive workspaces are cleaned", () => {
    const currentCwd = fs.readdirSync(process.cwd())
      .filter((name) => name.startsWith(".handfree-transfer-"))
      .filter((name) => !initialHostWorkspaces.has(name));
    assert.deepEqual(currentCwd, [], "no archive workspace should ever be created under process.cwd()");
    assert.deepEqual(newTmpWorkspaces(), [], "no archive workspace should be left behind under os.tmpdir()");
    assert.ok(sourceServer.stats.tarCommands >= 2);
    assert.ok(destinationServer.stats.tarCommands >= 2);
  });
});
