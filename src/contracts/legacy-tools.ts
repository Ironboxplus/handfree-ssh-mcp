import { z } from "zod";

// PLAN.MD §P0-04: characterization contract for the EXISTING 1.x foreground
// tool responses (upload/download/transfer/execute-command/command-status/
// list-servers/show-whitelist/close-connection/help), frozen here so
// P0-04's SshConnectionPool/TransferService extraction cannot silently
// change observable output. Every schema in this file was derived by
// reading the actual current tool/service source (src/tools/*.ts,
// src/services/ssh-connection-manager.ts), not guessed — where the exact
// service-generated text wasn't directly traceable from source alone (the
// upload/download success message body, show-whitelist/help markdown), the
// companion real characterization test
// (src/tests/characterization-legacy-tools.test.ts) captures it from a real
// tool invocation instead of this file asserting an unverified format.

// ---------------------------------------------------------------------------
// The one shared envelope: every 1.x tool (and `help`) returns this MCP
// CallToolResult shape. See src/tools/*.ts — all nine handlers construct
// exactly `{ content: [{ type: "text", text }], isError?: true }`.
// ---------------------------------------------------------------------------

export const legacyMcpTextContentSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
});

export const legacyMcpResponseSchema = z.object({
  content: z.array(legacyMcpTextContentSchema).min(1),
  isError: z.boolean().optional(),
});

export type LegacyMcpResponse = z.infer<typeof legacyMcpResponseSchema>;

// ---------------------------------------------------------------------------
// list-servers: src/tools/list-servers.ts returns
// JSON.stringify(sshManager.getAllServerInfos({verbose})) as the text body.
// Shape traced directly from SSHConnectionManager.getAllServerInfos
// (ssh-connection-manager.ts:4312).
// ---------------------------------------------------------------------------

export const legacyServerStatusSchema = z.record(z.string(), z.unknown()).optional();

export const legacyServerInfoSchema = z.object({
  name: z.string(),
  host: z.string(),
  port: z.number(),
  username: z.string(),
  connected: z.boolean(),
  enabled: z.boolean(),
  jumpHost: z.string().optional(),
  status: legacyServerStatusSchema,
});

export const legacyListServersPayloadSchema = z.array(legacyServerInfoSchema);

// ---------------------------------------------------------------------------
// close-connection: src/tools/close-connection.ts returns
// JSON.stringify(sshManager.closeConnection(...)) — shape traced directly
// from SSHConnectionManager.closeConnection (ssh-connection-manager.ts:353).
// ---------------------------------------------------------------------------

export const legacyCloseConnectionPayloadSchema = z.object({
  requested: z.string(),
  closed: z.array(z.string()),
});

// ---------------------------------------------------------------------------
// command-status: src/tools/command-status.ts returns
// JSON.stringify(sshManager.getBackgroundCommandStatus(...), null, 2) —
// shape traced directly from BackgroundCommandState + BackgroundCommandStatus
// (ssh-connection-manager.ts:108, :128).
// ---------------------------------------------------------------------------

export const legacyBackgroundCommandStatusPayloadSchema = z.object({
  runId: z.string(),
  status: z.enum(["running", "completed", "failed"]),
  serverName: z.string(),
  command: z.string(),
  startedAt: z.string(),
  finishedAt: z.string().optional(),
  logPath: z.string(),
  error: z.string().optional(),
  incremental: z.boolean(),
  outputTail: z.string().optional(),
  outputChunk: z.string().optional(),
  outputUnavailable: z.boolean().optional(),
  outputTruncated: z.boolean().optional(),
  outputStartOffset: z.number(),
  nextOffset: z.number(),
  fileSize: z.number(),
  hasMore: z.boolean(),
  cursorReset: z.boolean().optional(),
});

// ---------------------------------------------------------------------------
// execute-command with stream=true (default): src/tools/execute-command.ts
// returns JSON.stringify({...started, next}, null, 2), where `started` is
// SSHConnectionManager.startCommandBackground's BackgroundCommandState.
// ---------------------------------------------------------------------------

export const legacyStartCommandPayloadSchema = z.object({
  runId: z.string(),
  status: z.literal("running"),
  serverName: z.string(),
  command: z.string(),
  startedAt: z.string(),
  logPath: z.string(),
  next: z.string(),
});

// ---------------------------------------------------------------------------
// Legacy error text body: src/utils/tool-error.ts's formatToolErrorResponse.
// Re-exported here (not redefined) so characterization tests reference one
// source of truth — see src/contracts/error.ts's legacyErrorSchema and its
// note on the retriable/retryable field-name difference from the new §5.2
// error object.
// ---------------------------------------------------------------------------

export { legacyErrorSchema } from "./error.js";

// ---------------------------------------------------------------------------
// show-whitelist / help: markdown/plain text, not JSON. Structural
// characterization (required section headers) rather than a full-text
// snapshot, so wording tweaks that keep the same sections don't spuriously
// fail — but a removed section (which would be a real behavior change) does.
// ---------------------------------------------------------------------------

export interface MarkdownSectionCheck {
  present: string[];
  missing: string[];
}

/** Pure. Checks that every heading in `requiredHeadings` appears verbatim in
 * `text` (as a Markdown heading line, i.e. `^#{1,6} <heading>` or `^<heading>`
 * for the plain overview text used by help). */
export function checkMarkdownSections(text: string, requiredHeadings: string[]): MarkdownSectionCheck {
  const present: string[] = [];
  const missing: string[] = [];
  for (const heading of requiredHeadings) {
    if (text.includes(heading)) {
      present.push(heading);
    } else {
      missing.push(heading);
    }
  }
  return { present, missing };
}

// Headings traced directly from src/tools/show-whitelist.ts's formatCommandPolicy
// + registerShowWhitelistTool source.
export const SHOW_WHITELIST_REQUIRED_HEADINGS = [
  "## Command Policy",
  "## Allowed Commands (Whitelist)",
  "## 📂 SFTP Path Policy (upload / download / transfer)",
  "### Allowed remote directories",
  "### Allowed local directories",
  "### Matching rules",
  "## 📝 `execute-command` Output Logs",
];

// Traced directly from src/tools/help.ts's TOOL_OVERVIEW / TOOL_HELP text.
export const HELP_OVERVIEW_REQUIRED_LINES = [
  "Available tools (use help { tool: \"<name>\" } for details):",
  "list-servers",
  "execute-command",
  "show-whitelist",
  "close-connection",
  "command-status",
  "upload",
  "download",
  "transfer",
  "help",
  "Quick start:",
];
