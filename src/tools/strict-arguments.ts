import type { RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * The SDK wraps a tool's parameter shape in a plain z.object(), which silently
 * strips unknown keys: a misspelled or invented argument (source: {...} instead
 * of sourceServer) is dropped and the call fails later with a misleading
 * "missing argument" error, or worse, runs with a default. Make the schema
 * strict so such a call is rejected naming the unrecognized keys. The listed
 * JSON schema already advertises additionalProperties: false.
 */
export function rejectUnknownArguments(tool: RegisteredTool): RegisteredTool {
  tool.inputSchema = tool.inputSchema?.strict();
  return tool;
}
