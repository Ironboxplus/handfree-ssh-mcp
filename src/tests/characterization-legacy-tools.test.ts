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
import {
  legacyMcpResponseSchema,
  legacyListServersPayloadSchema,
  legacyCloseConnectionPayloadSchema,
  legacyBackgroundCommandStatusPayloadSchema,
  legacyStartCommandPayloadSchema,
  legacyErrorSchema,
  checkMarkdownSections,
  SHOW_WHITELIST_REQUIRED_HEADINGS,
  HELP_OVERVIEW_REQUIRED_LINES,
} from "../contracts/legacy-tools.js";

// PLAN.MD §P0-04 / P0-03: characterization contract for 1.x foreground tool
// responses, run for REAL against a real in-process SSH server (no mocks —
// §7.2). This freezes what P0-04's SshConnectionPool/TransferService
// extraction must not silently change. New tests only (this round adds
// nothing to the pre-existing fake-client test debt in tools.test.ts).

function responseText(result: any): string {
  const content = result.content as Array<{ type: string; text?: string }>;
  return content
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .filter((text): text is string => typeof text === "string")
    .join("\n");
}

describe("characterization: 1.x foreground tool responses (real SSH, no mocks)", { concurrency: false }, () => {
  const manager = SSHConnectionManager.getInstance();
  const suiteRoot = fs.mkdtempSync(path.join(os.tmpdir(), "handfree-characterization-"));
  const remoteServerRoot = path.join(suiteRoot, "remote-server");
  const localRoot = path.join(suiteRoot, "local");
  const server = new RealSshTestServer(remoteServerRoot);
  const mcpServer = new McpServer({ name: "characterization-test", version: "1.0.0" });
  const mcpClient = new Client({ name: "characterization-client", version: "1.0.0" });

  before(async () => {
    fs.mkdirSync(localRoot, { recursive: true });
    fs.writeFileSync(path.join(localRoot, "upload-me.txt"), "characterization payload\n", "utf8");
    await server.start();
    manager.setConfig(
      {
        remote: {
          host: "127.0.0.1",
          port: server.port,
          username: "test",
          password: "test",
          disableSftpPathPolicy: true,
          keepaliveInterval: 0,
        },
      },
      ["remote"],
    );
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

  test("black-box: every tool response is the shared MCP text-content envelope", async () => {
    const result = await mcpClient.callTool({ name: "list-servers", arguments: {} });
    assert.doesNotThrow(() => legacyMcpResponseSchema.parse(result));
  });

  test("black-box: list-servers returns the real getAllServerInfos() JSON shape", async () => {
    const result = await mcpClient.callTool({ name: "list-servers", arguments: {} });
    const parsed = legacyListServersPayloadSchema.parse(JSON.parse(responseText(result)));
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].name, "remote");
    assert.equal(parsed[0].port, server.port);
    assert.equal(parsed[0].connected, false, "no connection has been opened yet by this test");
    assert.equal(parsed[0].enabled, true);
  });

  test("black-box: execute-command stream=false returns raw remote stdout as plain text", async () => {
    const result = await mcpClient.callTool({
      name: "execute-command",
      arguments: { cmdString: "pwd", connectionName: "remote", stream: false },
    });
    const text = responseText(result);
    assert.doesNotThrow(() => legacyMcpResponseSchema.parse(result));
    assert.equal(result.isError, undefined);
    assert.ok(text.length > 0, "real remote pwd output must be non-empty");
  });

  test("black-box: execute-command stream=true returns the real background-start JSON shape", async () => {
    const result = await mcpClient.callTool({
      name: "execute-command",
      arguments: { cmdString: "echo characterization", connectionName: "remote", stream: true },
    });
    const parsed = legacyStartCommandPayloadSchema.parse(JSON.parse(responseText(result)));
    assert.equal(parsed.status, "running");
    assert.equal(parsed.serverName, "remote");
    assert.match(parsed.next, /command-status/);

    // Chain into command-status with the real runId this just produced.
    const statusResult = await mcpClient.callTool({
      name: "command-status",
      arguments: { runId: parsed.runId },
    });
    const status = legacyBackgroundCommandStatusPayloadSchema.parse(JSON.parse(responseText(statusResult)));
    assert.equal(status.runId, parsed.runId);
    assert.ok(["running", "completed"].includes(status.status));
  });

  test("black-box: command-status on an unknown runId returns the legacy error shape", async () => {
    const result = await mcpClient.callTool({ name: "command-status", arguments: { runId: "cmd_does_not_exist" } });
    assert.equal(result.isError, true);
    const error = legacyErrorSchema.parse(JSON.parse(responseText(result)));
    // toToolError() preserves the original ToolError's own code when the
    // thrown error already is one (src/utils/tool-error.ts) — the handler's
    // fallback code "BACKGROUND_COMMAND_STATUS_FAILED" is only used for a
    // generic (non-ToolError) failure, which this path never produces.
    assert.equal(error.code, "BACKGROUND_COMMAND_NOT_FOUND");
  });

  test("black-box: upload/download round-trip returns non-empty plain-text success messages", async () => {
    const uploadResult = await mcpClient.callTool({
      name: "upload",
      arguments: {
        localPath: path.join(localRoot, "upload-me.txt"),
        remotePath: "/upload-me.txt",
        connectionName: "remote",
      },
    });
    assert.equal(uploadResult.isError, undefined);
    const uploadText = responseText(uploadResult);
    assert.ok(uploadText.length > 0);
    // Characterization: upload's success text is plain prose, not JSON —
    // real observed text starts with "File uploaded...".
    assert.throws(() => JSON.parse(uploadText), "upload success text is plain text, not JSON");

    const downloadResult = await mcpClient.callTool({
      name: "download",
      arguments: {
        remotePath: "/upload-me.txt",
        localPath: path.join(localRoot, "downloaded.txt"),
        connectionName: "remote",
      },
    });
    assert.equal(downloadResult.isError, undefined);
    assert.ok(responseText(downloadResult).length > 0);
    assert.equal(fs.readFileSync(path.join(localRoot, "downloaded.txt"), "utf8"), "characterization payload\n");
  });

  test("black-box: upload against a rejected local path returns the legacy error shape", async () => {
    const result = await mcpClient.callTool({
      name: "upload",
      arguments: { localPath: "/definitely/not/allowed.txt", remotePath: "/x.txt", connectionName: "remote" },
    });
    assert.equal(result.isError, true);
    const error = legacyErrorSchema.parse(JSON.parse(responseText(result)));
    assert.equal(typeof error.code, "string");
    assert.equal(error.retriable, false);
  });

  test("black-box: transfer mode=upload (single file) behaves like upload and returns plain text", async () => {
    const result = await mcpClient.callTool({
      name: "transfer",
      arguments: {
        mode: "upload",
        localPath: path.join(localRoot, "upload-me.txt"),
        remotePath: "/via-transfer.txt",
        connectionName: "remote",
      },
    });
    assert.equal(result.isError, undefined);
    assert.ok(responseText(result).length > 0);
  });

  test("black-box + white-box: show-whitelist real markdown contains every required section header", async () => {
    const result = await mcpClient.callTool({ name: "show-whitelist", arguments: { connectionName: "remote" } });
    const text = responseText(result);
    const { missing } = checkMarkdownSections(text, SHOW_WHITELIST_REQUIRED_HEADINGS);
    assert.deepEqual(missing, [], `show-whitelist output is missing required sections: ${JSON.stringify(missing)}`);
  });

  test("black-box + white-box: close-connection returns the real closeConnection() JSON shape", async () => {
    // Open a real connection first so there is something real to close.
    await mcpClient.callTool({ name: "execute-command", arguments: { cmdString: "pwd", connectionName: "remote", stream: false } });
    const result = await mcpClient.callTool({ name: "close-connection", arguments: { connectionName: "remote" } });
    const parsed = legacyCloseConnectionPayloadSchema.parse(JSON.parse(responseText(result)));
    assert.equal(parsed.requested, "remote");
    assert.ok(parsed.closed.includes("remote"));
  });

  test("black-box + white-box: help overview and per-tool help contain the required content", async () => {
    const overview = await mcpClient.callTool({ name: "help", arguments: {} });
    const overviewCheck = checkMarkdownSections(responseText(overview), HELP_OVERVIEW_REQUIRED_LINES);
    assert.deepEqual(overviewCheck.missing, []);

    const toolHelp = await mcpClient.callTool({ name: "help", arguments: { tool: "execute-command" } });
    assert.match(responseText(toolHelp), /execute-command/);

    const unknown = await mcpClient.callTool({ name: "help", arguments: { tool: "not-a-real-tool" } });
    assert.equal(unknown.isError, true);
    assert.match(responseText(unknown), /Unknown tool/);
  });
});
