import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerDownloadTool } from "../tools/download.js";
import { registerTransferTool } from "../tools/transfer.js";
import { registerUploadTool } from "../tools/upload.js";
import { registerHelpTool, TOOL_HELP_FOR_TEST } from "../tools/help.js";
import { registerWorkspaceRunTool } from "../tools/workspace-run.js";
import { SERVER_INSTRUCTIONS } from "../config/server.js";

/**
 * A guard for a real gap that reached a published release.
 *
 * `connections` shipped in 2.0.0 with a correct zod `.describe()` on the
 * download/transfer schemas -- and nothing else. It appeared in neither
 * `help { tool: "download" }` nor SERVER_INSTRUCTIONS, so `help` silently
 * became an incomplete list of a tool's own parameters. Every test in the
 * suite passed, because nothing tied the schema to the prose.
 *
 * These tests read the REAL registered MCP tool schemas over a real
 * InMemoryTransport (the same path a client uses) and require every
 * parameter name to be documented in that tool's help text. It is mechanical
 * on purpose: the failure mode is someone adding a parameter and forgetting
 * the prose, which no amount of behavioral testing catches.
 */

const PARAMETERS_EXEMPT_FROM_HELP: Record<string, ReadonlySet<string>> = {
  // `mode` is not a row in transfer's parameter list because the help text
  // documents the three modes as its own top-level section instead.
  transfer: new Set(["mode"]),
};

async function listRegisteredTools(): Promise<Map<string, string[]>> {
  const server = new McpServer({ name: "doc-coverage", version: "0.0.0" });
  registerDownloadTool(server);
  registerTransferTool(server);
  registerUploadTool(server);
  registerWorkspaceRunTool(server);
  registerHelpTool(server);
  const client = new Client({ name: "doc-coverage-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const { tools } = await client.listTools();
    const result = new Map<string, string[]>();
    for (const tool of tools) {
      const schema = tool.inputSchema as { properties?: Record<string, unknown> };
      result.set(tool.name, Object.keys(schema.properties ?? {}));
    }
    return result;
  } finally {
    await Promise.all([client.close(), server.close()]);
  }
}

describe("documentation coverage: every tool parameter appears in that tool's help text", () => {
  test("download / transfer / upload parameters are all documented in help", async () => {
    const tools = await listRegisteredTools();
    const missing: string[] = [];

    for (const toolName of ["download", "transfer", "upload", "workspace-run"]) {
      const parameters = tools.get(toolName);
      assert.ok(parameters && parameters.length > 0, `expected ${toolName} to expose parameters`);
      const helpText = TOOL_HELP_FOR_TEST[toolName];
      assert.ok(helpText, `expected a help entry for ${toolName}`);
      const exempt = PARAMETERS_EXEMPT_FROM_HELP[toolName] ?? new Set<string>();
      for (const parameter of parameters) {
        if (exempt.has(parameter)) continue;
        if (!helpText.includes(parameter)) {
          missing.push(`${toolName}.${parameter}`);
        }
      }
    }

    assert.deepEqual(
      missing,
      [],
      `these tool parameters exist in the real MCP schema but are absent from their help text: ${missing.join(", ")}. ` +
        `Adding a parameter without documenting it makes \`help\` an incomplete list of that tool's own options -- ` +
        `exactly how \`connections\` shipped undocumented in 2.0.0.`,
    );
  });

  test("workspace-run is documented as usable without any YAML config", () => {
    // It shipped profile-only, which made the feature unreachable for anyone
    // whose servers come from ~/.ssh/config: `profile` was required, and no
    // config file had a runProfiles: section. The inline path is the fix, so
    // both the per-tool help and the server prompt must actually say so --
    // an inline capability nobody is told about is the same dead end.
    const helpText = TOOL_HELP_FOR_TEST["workspace-run"];
    assert.match(helpText, /No YAML config required/i);
    assert.match(helpText, /remoteRoot/);
    assert.match(helpText, /venv/);
    assert.match(SERVER_INSTRUCTIONS, /workspace-run[\s\S]*NO YAML configuration/);
    for (const parameter of ["remoteRoot", "venv", "pushPaths", "collectLocalDir"]) {
      assert.ok(
        SERVER_INSTRUCTIONS.includes(parameter),
        `SERVER_INSTRUCTIONS never mentions "${parameter}", so a client relying only on the server prompt cannot ` +
          `discover that workspace-run runs without a configured profile`,
      );
    }
  });

  test("the parameters that change how bytes move are also surfaced in SERVER_INSTRUCTIONS", () => {
    // Not every parameter belongs in the server-level prompt -- it would
    // become unreadable. These specific ones do, because a client that never
    // calls `help` still has to know they exist to choose them at all: they
    // change the transport strategy rather than tweaking one call.
    for (const parameter of ["connections", "strategy", "fast", "archive"]) {
      assert.ok(
        SERVER_INSTRUCTIONS.includes(parameter),
        `SERVER_INSTRUCTIONS never mentions "${parameter}", so a client relying only on the server prompt ` +
          `cannot discover it`,
      );
    }
  });

  test("the connections guidance states the measured caveat, not just that the option exists", () => {
    // connections=8 measured SLOWER than a single connection on the lab link.
    // Documenting the knob without that caveat invites users straight into
    // the regression, so the caveat is asserted, not merely the mention.
    const helpText = TOOL_HELP_FOR_TEST["download"];
    assert.match(helpText, /MaxStartups/, "help must name the remote limit that actually applies to N connections");
    assert.match(helpText, /SLOWER/, "help must warn that raising connections too far measured slower");
    assert.match(SERVER_INSTRUCTIONS, /MaxStartups/);
    assert.match(SERVER_INSTRUCTIONS, /SLOWER/);
  });
});
