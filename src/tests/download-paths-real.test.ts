import assert from "node:assert/strict";
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
import { ToolError } from "../utils/tool-error.js";
import { RealSshTestServer } from "./helpers/real-ssh-server.js";

/**
 * Built from three real failed calls against an Android phone (OpenSSH 10.3)
 * on 2026-11-26, replayed against a real ssh2 SFTP server:
 *   1. download remotePath: a JSON array of four files -> rejected as "not an
 *      absolute POSIX path" (download took one path only).
 *   2. transfer download of the directory /data/local/tmp without recursive ->
 *      "Fast download failed: Failure" (OPEN on a directory succeeds, the
 *      first READ fails).
 *   3. download into E:/.../power/s_hit.json while power/ did not exist ->
 *      SFTP_ERROR "ENOENT ... open 'E:\...'" although nothing remote failed.
 * Plus the remote path forms of a Windows server (measured against
 * OpenSSH_for_Windows_9.5: C:\x, C:/x, /C:\x and /C:/x are one file, reported
 * as /C:/x) and the local path policy being open by default.
 */

function text(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = result.content as Array<{ type: string; text?: string }>;
  return content.map((item) => item.text ?? "").join("\n");
}

describe("download paths: k50 replay, Windows remote paths, local policy", { concurrency: false }, () => {
  const manager = SSHConnectionManager.getInstance();
  const service = manager.getTransferService();
  const suiteRoot = fs.mkdtempSync(path.join(os.tmpdir(), "handfree-download-paths-"));
  const serverRoot = path.join(suiteRoot, "server");
  const localRoot = path.join(suiteRoot, "local");
  const server = new RealSshTestServer(serverRoot);
  const mcpServer = new McpServer({ name: "download-paths", version: "1.0.0" });
  const mcpClient = new Client({ name: "download-paths-client", version: "1.0.0" });
  const files: Record<string, string> = {
    "s_hit.json": '{"s":"hit"}',
    "t_hit.json": '{"t":"hit"}',
    "s_home.json": '{"s":"home"}',
    "t_home.json": '{"t":"home"}',
  };
  const remote = (name: string) => `/data/local/tmp/${name}`;

  before(async () => {
    fs.mkdirSync(localRoot, { recursive: true });
    fs.mkdirSync(path.join(serverRoot, "data", "local", "tmp"), { recursive: true });
    for (const [name, body] of Object.entries(files)) {
      fs.writeFileSync(server.toLocalPath(remote(name)), body);
    }
    await server.start();
    manager.setConfig({
      k50: {
        host: "127.0.0.1", port: server.port, username: "test", password: "test",
        keepaliveInterval: 0, allowedLocalDirectories: [suiteRoot],
      },
      open: { host: "127.0.0.1", port: server.port, username: "test", password: "test", keepaliveInterval: 0 },
      windowsAllowlist: {
        host: "127.0.0.1", port: server.port, username: "test", password: "test", keepaliveInterval: 0,
        allowedRemoteDirectories: ["/C:/Data"],
      },
    }, ["k50", "open", "windowsAllowlist"]);
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

  test("call 3: a download into a missing local directory creates it", async () => {
    const target = path.join(localRoot, "k50-switch", "power", "s_hit.json");
    const result = await mcpClient.callTool({
      name: "download",
      arguments: { connectionName: "k50", remotePath: remote("s_hit.json"), localPath: target },
    });
    assert.notEqual(result.isError, true, text(result));
    assert.equal(fs.readFileSync(target, "utf8"), files["s_hit.json"]);
  });

  test("call 1: a remotePath array downloads every file into the localPath directory", async () => {
    const dir = path.join(localRoot, "batch", "power");
    const result = await mcpClient.callTool({
      name: "download",
      arguments: { connectionName: "k50", remotePath: Object.keys(files).map(remote), localPath: dir },
    });
    assert.notEqual(result.isError, true, text(result));
    const body = JSON.parse(text(result));
    assert.equal(body.total, 4);
    assert.equal(body.downloadedCount, 4);
    for (const [name, content] of Object.entries(files)) {
      assert.equal(fs.readFileSync(path.join(dir, name), "utf8"), content);
    }
  });

  test("transfer mode=download takes the same remotePath array", async () => {
    const dir = path.join(localRoot, "batch-transfer");
    const result = await mcpClient.callTool({
      name: "transfer",
      arguments: { mode: "download", connectionName: "k50", remotePath: [remote("t_hit.json"), remote("t_home.json")], localPath: dir },
    });
    assert.notEqual(result.isError, true, text(result));
    assert.equal(JSON.parse(text(result)).downloadedCount, 2);
    assert.equal(fs.readFileSync(path.join(dir, "t_home.json"), "utf8"), files["t_home.json"]);
  });

  test("batch download: duplicate basenames are rejected before any transfer; onError=continue reports each file", async () => {
    fs.mkdirSync(path.join(serverRoot, "other"), { recursive: true });
    fs.writeFileSync(server.toLocalPath("/other/s_hit.json"), "other");
    const collision = await mcpClient.callTool({
      name: "download",
      arguments: { connectionName: "k50", remotePath: [remote("s_hit.json"), "/other/s_hit.json"], localPath: path.join(localRoot, "dup") },
    });
    assert.equal(collision.isError, true);
    assert.match(text(collision), /BATCH_TARGET_COLLISION/);
    assert.equal(fs.existsSync(path.join(localRoot, "dup", "s_hit.json")), false);

    const mixed = await mcpClient.callTool({
      name: "download",
      arguments: { connectionName: "k50", remotePath: [remote("missing.json"), remote("s_home.json")], localPath: path.join(localRoot, "mixed"), onError: "continue" },
    });
    const body = JSON.parse(text(mixed));
    assert.equal(body.downloadedCount, 1);
    assert.equal(body.failedCount, 1);
    assert.equal(body.results[0].status, "failed");
    assert.equal(fs.existsSync(path.join(localRoot, "mixed", "missing.json")), false, "a failed file leaves nothing behind");
  });

  test("call 2: downloading a directory says so and leaves no local file", async () => {
    const target = path.join(localRoot, "k50-switch", "power2");
    const result = await mcpClient.callTool({
      name: "transfer",
      arguments: { mode: "download", connectionName: "k50", remotePath: "/data/local/tmp", localPath: target },
    });
    assert.equal(result.isError, true);
    assert.match(text(result), /INVALID_CONFIGURATION/);
    assert.match(text(result), /is a directory/);
    assert.match(text(result), /recursive=true/);
    assert.equal(fs.existsSync(target), false);
  });

  test("a directory is also reported on the multi-connection path", async () => {
    await assert.rejects(
      () => service.download("/data/local/tmp", path.join(localRoot, "multi-dir.bin"), "k50", { connections: 2 }),
      (error: unknown) => error instanceof ToolError && error.code === "INVALID_CONFIGURATION" && /is a directory/.test(error.message),
    );
  });

  test("a localPath that is a directory, or ends with a separator, keeps the remote name", async () => {
    const existing = path.join(localRoot, "existing-dir");
    fs.mkdirSync(existing, { recursive: true });
    const first = await service.download(remote("t_hit.json"), existing, "k50");
    assert.match(first, /saved as/);
    assert.equal(fs.readFileSync(path.join(existing, "t_hit.json"), "utf8"), files["t_hit.json"]);

    const trailing = path.join(localRoot, "new-dir") + path.sep;
    await service.download(remote("s_home.json"), trailing, "k50");
    assert.equal(fs.readFileSync(path.join(localRoot, "new-dir", "s_home.json"), "utf8"), files["s_home.json"]);
  });

  test("a local write failure is reported as LOCAL_FILE_WRITE_FAILED, not as an SFTP error", async () => {
    const blocker = path.join(localRoot, "a-file");
    fs.writeFileSync(blocker, "not a directory");
    await assert.rejects(
      () => service.download(remote("s_hit.json"), path.join(blocker, "child", "s_hit.json"), "k50"),
      (error: unknown) => error instanceof ToolError && error.code === "LOCAL_FILE_WRITE_FAILED",
    );
  });

  test("local paths are open by default; an allowlist still restricts", () => {
    const outside = path.join(os.tmpdir(), "handfree-anywhere", "x.txt");
    assert.equal(service.validateLocalPath(outside, "open"), path.resolve(outside));
    assert.throws(
      () => service.validateLocalPath(path.join(path.parse(suiteRoot).root, "handfree-not-allowed", "x"), "k50"),
      (error: unknown) => error instanceof ToolError && error.code === "LOCAL_PATH_NOT_ALLOWED",
    );
  });

  test("Windows remote paths: every form Win32-OpenSSH accepts normalizes to /C:/...", () => {
    for (const form of ["C:\\Users\\Arc\\f.txt", "C:/Users/Arc/f.txt", "/C:\\Users\\Arc\\f.txt", "/C:/Users/Arc/f.txt", "c:\\Users\\Arc\\f.txt"]) {
      assert.equal(service.validateRemotePath(form, "open"), "/C:/Users/Arc/f.txt", form);
    }
    assert.equal(service.validateRemotePath("C:", "open"), "/C:/");
    assert.equal(service.validateRemotePath("/home/a\\b", "open"), "/home/a\\b", "a backslash is a filename character on POSIX servers");
    assert.throws(() => service.validateRemotePath("C:\\Users\\..\\Windows", "open"), /'\.\.' segments/);
    for (const relative of ["~/x", "data/x", "~"]) {
      assert.throws(
        () => service.validateRemotePath(relative, "open"),
        (error: unknown) => error instanceof ToolError && error.code === "REMOTE_PATH_NOT_ALLOWED" && /C:\\Users/.test(error.message) && /~/.test(error.message),
        relative,
      );
    }
  });

  test("Windows remote allowlist entries compare case-insensitively; POSIX ones do not", () => {
    assert.equal(service.validateRemotePath("c:\\data\\run\\out.log", "windowsAllowlist"), "/C:/data/run/out.log");
    assert.throws(
      () => service.validateRemotePath("C:\\Database\\x", "windowsAllowlist"),
      (error: unknown) => error instanceof ToolError && error.code === "REMOTE_PATH_NOT_ALLOWED",
    );
    manager.setConfig({
      posix: { host: "127.0.0.1", port: server.port, username: "test", password: "test", keepaliveInterval: 0, allowedRemoteDirectories: ["/data"] },
    }, ["posix"]);
    try {
      assert.throws(
        () => service.validateRemotePath("/Data/x", "posix"),
        (error: unknown) => error instanceof ToolError && error.code === "REMOTE_PATH_NOT_ALLOWED",
      );
    } finally {
      manager.setConfig({
        k50: { host: "127.0.0.1", port: server.port, username: "test", password: "test", keepaliveInterval: 0, allowedLocalDirectories: [suiteRoot] },
        open: { host: "127.0.0.1", port: server.port, username: "test", password: "test", keepaliveInterval: 0 },
        windowsAllowlist: { host: "127.0.0.1", port: server.port, username: "test", password: "test", keepaliveInterval: 0, allowedRemoteDirectories: ["/C:/Data"] },
      }, ["k50", "open", "windowsAllowlist"]);
    }
  });
});
