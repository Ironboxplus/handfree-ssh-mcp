import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAllTools } from "../tools/index.js";

/**
 * A real call that reached a user: transfer { mode: "relay",
 * source: { server, path }, destination: { server, path } }. The SDK's
 * default z.object() stripped both keys, so the tool answered "relay mode
 * requires: sourceServer, ..." without ever saying its arguments were not
 * recognized. Every tool must now reject unknown arguments by name, over the
 * same MCP path a client uses.
 */
describe("tools reject unknown arguments instead of silently dropping them", () => {
  const server = new McpServer({ name: "strict-arguments", version: "0.0.0" });
  const client = new Client({ name: "strict-arguments-client", version: "0.0.0" });

  before(async () => {
    registerAllTools(server);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  });

  after(async () => {
    await Promise.all([client.close(), server.close()]);
  });

  test("the reported nested relay call names source and destination as unrecognized", async () => {
    await assert.rejects(
      client.callTool({
        name: "transfer",
        arguments: {
          mode: "relay",
          source: { server: "cfscan", path: "/root/mexp/media.sql.gz" },
          destination: { server: "txcloud", path: "/root/docker/media-from-cfscan.sql.gz" },
        },
      }),
      (error: Error) => {
        assert.match(error.message, /unrecognized_keys/);
        assert.match(error.message, /'source', 'destination'/);
        return true;
      },
    );
  });

  test("every registered tool rejects a misspelled argument by name", async () => {
    const { tools } = await client.listTools();
    assert.ok(tools.length >= 21, `expected all tools, got ${tools.length}`);
    for (const tool of tools) {
      await assert.rejects(
        client.callTool({ name: tool.name, arguments: { handfreeMisspelledArg: 1 } }),
        (error: Error) => {
          assert.match(error.message, /Unrecognized key\(s\) in object: 'handfreeMisspelledArg'/, tool.name);
          return true;
        },
        tool.name,
      );
    }
  });

  test("known arguments are still accepted", async () => {
    const result = await client.callTool({ name: "help", arguments: { tool: "transfer" } });
    assert.notEqual(result.isError, true);
  });
});
