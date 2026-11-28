import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSHConnectionManager } from "../services/ssh-connection-manager.js";
import { registerAllTools } from "../tools/index.js";
import { RealSshTestServer } from "./helpers/real-ssh-server.js";

/**
 * push / pull / copy, the adb-style replacements for upload / download /
 * transfer (user, 2026-11-28: "我感觉是不是可学习adb那种push，pull的语法").
 * The direction is the verb and a directory is detected, so there is no mode
 * and no recursive flag. Runs through a real MCP client against a real ssh2
 * SFTP server; "a" and "b" are two server names on it, so copy takes the
 * remote-to-remote relay path.
 */

function text(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = result.content as Array<{ type: string; text?: string }>;
  return content.map((item) => item.text ?? "").join("\n");
}

describe("push / pull / copy", { concurrency: false }, () => {
  const manager = SSHConnectionManager.getInstance();
  const suiteRoot = fs.mkdtempSync(path.join(os.tmpdir(), "handfree-push-pull-"));
  const serverRoot = path.join(suiteRoot, "server");
  const localRoot = path.join(suiteRoot, "local");
  const server = new RealSshTestServer(serverRoot);
  const mcpServer = new McpServer({ name: "push-pull-copy", version: "1.0.0" });
  const mcpClient = new Client({ name: "push-pull-copy-client", version: "1.0.0" });

  const call = (name: string, args: Record<string, unknown>) => mcpClient.callTool({ name, arguments: args });
  const ok = (result: Awaited<ReturnType<Client["callTool"]>>) => assert.notEqual(result.isError, true, text(result));
  const writeLocal = (relative: string, body: string): string => {
    const file = path.join(localRoot, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
    return file;
  };
  const writeRemote = (remotePath: string, body: string): void => {
    const file = server.toLocalPath(remotePath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
  };
  const readRemote = (remotePath: string): string => fs.readFileSync(server.toLocalPath(remotePath), "utf8");

  before(async () => {
    fs.mkdirSync(localRoot, { recursive: true });
    fs.mkdirSync(serverRoot, { recursive: true });
    await server.start();
    const endpoint = { host: "127.0.0.1", port: server.port, username: "test", password: "test", keepaliveInterval: 0 };
    manager.setConfig({ a: endpoint, b: endpoint }, ["a", "b"]);
    registerAllTools(mcpServer);
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

  test("the tool list has push, pull and copy and none of upload, download, transfer", async () => {
    const names = new Set((await mcpClient.listTools()).tools.map((tool) => tool.name));
    for (const name of ["push", "pull", "copy"]) assert.ok(names.has(name), `missing ${name}`);
    for (const name of ["upload", "download", "transfer"]) assert.ok(!names.has(name), `${name} should be gone`);
  });

  test("push: a file to a file path", async () => {
    const local = writeLocal("one.txt", "one");
    ok(await call("push", { connectionName: "a", localPath: local, remotePath: "/p/one.txt" }));
    assert.equal(readRemote("/p/one.txt"), "one");
  });

  test("push: a directory is detected, no recursive flag; its contents land in remotePath", async () => {
    writeLocal("tree/top.txt", "top");
    writeLocal("tree/sub/deep.txt", "deep");
    const result = await call("push", { connectionName: "a", localPath: path.join(localRoot, "tree"), remotePath: "/p/tree" });
    ok(result);
    assert.equal(readRemote("/p/tree/top.txt"), "top");
    assert.equal(readRemote("/p/tree/sub/deep.txt"), "deep");
  });

  test("push: a file into an existing remote directory, or a path ending with /, keeps its name (adb push)", async () => {
    fs.mkdirSync(server.toLocalPath("/p/existing"), { recursive: true });
    const local = writeLocal("named.txt", "named");
    ok(await call("push", { connectionName: "a", localPath: local, remotePath: "/p/existing" }));
    assert.equal(readRemote("/p/existing/named.txt"), "named");
    ok(await call("push", { connectionName: "a", localPath: local, remotePath: "/p/slash/" }));
    assert.equal(readRemote("/p/slash/named.txt"), "named");
  });

  test("push: a localPath array lands in remotePath/<basename>", async () => {
    const files = [writeLocal("batch/x.txt", "x"), writeLocal("batch/y.txt", "y")];
    const result = await call("push", { connectionName: "a", localPath: files, remotePath: "/p/batch" });
    ok(result);
    assert.equal(readRemote("/p/batch/x.txt"), "x");
    assert.equal(readRemote("/p/batch/y.txt"), "y");
  });

  test("pull: a file, and a file into an existing local directory under its remote name", async () => {
    writeRemote("/q/file.txt", "file");
    const target = path.join(localRoot, "pulled", "file-copy.txt");
    ok(await call("pull", { connectionName: "a", remotePath: "/q/file.txt", localPath: target }));
    assert.equal(fs.readFileSync(target, "utf8"), "file");
    ok(await call("pull", { connectionName: "a", remotePath: "/q/file.txt", localPath: path.join(localRoot, "pulled") }));
    assert.equal(fs.readFileSync(path.join(localRoot, "pulled", "file.txt"), "utf8"), "file");
  });

  test("pull: a remote directory is detected, no recursive flag; its contents land in localPath", async () => {
    writeRemote("/q/dir/a.txt", "a");
    writeRemote("/q/dir/nested/b.txt", "b");
    const target = path.join(localRoot, "pulled-dir");
    ok(await call("pull", { connectionName: "a", remotePath: "/q/dir", localPath: target }));
    assert.equal(fs.readFileSync(path.join(target, "a.txt"), "utf8"), "a");
    assert.equal(fs.readFileSync(path.join(target, "nested", "b.txt"), "utf8"), "b");
  });

  test("pull: a remotePath array lands in the localPath directory", async () => {
    writeRemote("/q/m1.txt", "m1");
    writeRemote("/q/m2.txt", "m2");
    const target = path.join(localRoot, "pulled-batch");
    const result = await call("pull", { connectionName: "a", remotePath: ["/q/m1.txt", "/q/m2.txt"], localPath: target });
    ok(result);
    assert.equal(JSON.parse(text(result)).downloadedCount, 2);
    assert.equal(fs.readFileSync(path.join(target, "m2.txt"), "utf8"), "m2");
  });

  test("copy: the nested from/to shape a model wrote on 2026-11-26 copies between two servers", async () => {
    writeRemote("/r/src.txt", "relayed");
    const result = await call("copy", { from: { server: "a", path: "/r/src.txt" }, to: { server: "b", path: "/r/dst.txt" } });
    ok(result);
    assert.equal(readRemote("/r/dst.txt"), "relayed");
  });

  test("old argument shapes are rejected as unknown, not silently ignored", async () => {
    const local = writeLocal("strict.txt", "strict");
    const withMode = await call("push", { connectionName: "a", localPath: local, remotePath: "/p/strict.txt", mode: "upload" });
    assert.equal(withMode.isError, true);
    assert.match(text(withMode), /mode/);
    const withRecursive = await call("pull", { connectionName: "a", remotePath: "/q/dir", localPath: localRoot, recursive: true });
    assert.equal(withRecursive.isError, true);
    assert.match(text(withRecursive), /recursive/);
    const flatCopy = await call("copy", { sourceServer: "a", sourceRemotePath: "/r/src.txt", destServer: "b", destRemotePath: "/r/x.txt" });
    assert.equal(flatCopy.isError, true);
  });
});
