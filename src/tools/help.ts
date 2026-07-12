import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const TOOL_HELP: Record<string, string> = {
  "list-servers": `list-servers — Discover available SSH servers.

Parameters:
  refresh  (boolean, optional)  When true, re-collects live system status
           (hostname, CPU, memory, disk, GPUs) from all enabled servers.
           Without this, cached status from connection time is returned.

Returns: JSON array of server objects with name, host, port, username,
         connected, enabled, and optional status.

Example:
  list-servers                   → cached info
  list-servers { refresh: true } → fresh system status`,

  "execute-command": `execute-command — Run a shell command on a remote server.

Parameters:
  cmdString       (string, required)   The shell command to execute.
  connectionName  (string, see below)  Target server name from list-servers.
  stream          (boolean, optional)  Default true. Starts the command in
                  the background and returns runId/logPath immediately.
                  Poll with command-status. Set false for short commands
                  when you need the final output in the same tool call.
  reuseConnection (boolean, optional)  Default true. Set false after a timeout
                  or suspected stale cached SSH connection to force a fresh
                  TCP/SSH connection for this command.
  vvv             (boolean, optional)  Default false. Append bounded
                  SSH/channel debug output. Use with reuseConnection=false
                  when you need fresh handshake logs.
  timeout         (number, optional)   Per-attempt phase timeout in ms:
                                      SSH setup, exec-channel open, and
                                      remote command execution each use this
                                      cap.
                  Defaults: 300000 (stream) / 30000 (non-stream).

connectionName rule:
  • If only one server is enabled → optional (auto-selected).
  • If multiple servers are enabled → REQUIRED.

Examples:
  execute-command { cmdString: "pwd" }
  execute-command { cmdString: "docker ps -a", connectionName: "prod", stream: false }
  execute-command { cmdString: "tail -f /var/log/syslog", stream: true, timeout: 600000 }
  command-status { runId: "cmd_20260712T120000Z_ab12cd34" }
  execute-command { cmdString: "hostname", connectionName: "scnet", stream: false, reuseConnection: false }
  execute-command { cmdString: "hostname", connectionName: "scnet", stream: false, reuseConnection: false, vvv: true }`,

  "command-status": `command-status — Poll a background command.

Parameters:
  runId           (string, required)   runId returned by execute-command
                                      when stream=true.
  maxOutputBytes  (number, optional)   Live log tail bytes to return.
                                      Defaults to 65536.

Returns: JSON with runId, status (running/completed/failed), logPath,
         timestamps, error when failed, and outputTail. Status is process-local;
         after MCP server restart, read the returned logPath directly.

Example:
  command-status { runId: "cmd_20260712T120000Z_ab12cd34", maxOutputBytes: 50000 }`,

  "show-whitelist": `show-whitelist — Show the active command policy for a server.

Parameters:
  connectionName  (string, see below)  Target server name from list-servers.

connectionName rule:
  • If only one server is enabled → optional (auto-selected).
  • If multiple servers are enabled → REQUIRED.

Returns: Command mode, built-in blacklist, configured whitelist/blacklist patterns, and example commands when whitelist mode is active.`,

  "close-connection": `close-connection — Close a cached SSH connection.

Parameters:
  connectionName  (string, see below)  Target server name from list-servers.

connectionName rule:
  • If only one server is enabled → optional (auto-selected).
  • If multiple servers are enabled → REQUIRED.

Behavior:
  • Closes the cached/reused SSH client for the target server.
  • Closing a jump host also closes cached targets whose jump chain uses it.
  • Does not affect reuseConnection=false commands, because those one-shot
    connections already close after each command.

Examples:
  close-connection { connectionName: "scnet" }
  close-connection { connectionName: "dcu" }`,

  "upload": `upload — Upload a single local file to a remote server over SFTP.

Parameters:
  localPath       (string, required)   File path on the MCP host.
                  Must be inside the MCP working directory.
  remotePath      (string, required)   Destination path on the remote server.
  connectionName  (string, see below)  Target server name from list-servers.
  skipIfIdentical (boolean, optional)  Default true. Skip when remote matches.
  reuseConnection (boolean, optional)  Default true. Set false after timeout
                  or suspected stale cached SSH connection.
  timeout         (number, optional)   SSH setup and SFTP channel-open timeout.
  vvv             (boolean, optional)  Default false. Append bounded SSH/SFTP debug.
                  Recursive success returns structured JSON; debug is surfaced
                  for single-file results, relay results, and recursive errors.
  fast            (boolean, optional)  Default false. Use ssh2 fastPut for
                  single-file upload throughput. Not multi-file concurrency.
  sftpConcurrency (number, optional)   Only with fast=true. Concurrent SFTP chunks.
  chunkSize       (number, optional)   Only with fast=true. SFTP chunk bytes.

connectionName rule:
  • If only one server is enabled → optional (auto-selected).
  • If multiple servers are enabled → REQUIRED.

Example:
  upload { localPath: "data.csv", remotePath: "/tmp/data.csv" }
  upload { localPath: "big.bin", remotePath: "/tmp/big.bin", fast: true,
           sftpConcurrency: 32, chunkSize: 131072 }`,

  "download": `download — Download a single file from a remote server over SFTP.

Parameters:
  remotePath      (string, required)   File path on the remote server.
  localPath       (string, required)   Destination on the MCP host.
                  Must be inside the MCP working directory.
  connectionName  (string, see below)  Target server name from list-servers.
  reuseConnection (boolean, optional)  Default true. Set false after timeout
                  or suspected stale cached SSH connection.
  timeout         (number, optional)   SSH setup and SFTP channel-open timeout.
  vvv             (boolean, optional)  Default false. Append bounded SSH/SFTP debug.
  fast            (boolean, optional)  Default false. Use ssh2 fastGet for
                  single-file download throughput. Not multi-file concurrency.
  sftpConcurrency (number, optional)   Only with fast=true. Concurrent SFTP chunks.
  chunkSize       (number, optional)   Only with fast=true. SFTP chunk bytes.

connectionName rule:
  • If only one server is enabled → optional (auto-selected).
  • If multiple servers are enabled → REQUIRED.

Example:
  download { remotePath: "/var/log/app.log", localPath: "app.log" }
  download { remotePath: "/tmp/big.bin", localPath: "big.bin", fast: true,
             sftpConcurrency: 32, chunkSize: 131072 }`,

  "transfer": `transfer — Move files between hosts (single/recursive/cross-server).

Modes:
  upload    Push local → remote (single file or recursive directory).
  download  Pull remote → local (single file or recursive directory).
  relay     Stream a file from remote-A → remote-B via SFTP piping.
            No temp file on the MCP host, no SCP, no authorized-key
            exchange between the two servers. Each side uses its own
            existing SSH session.

Parameters for upload / download:
  mode            (string, required)   "upload" or "download"
  localPath       (string, required)   Path on the MCP host.
  remotePath      (string, required)   Path on the remote server.
  connectionName  (string, see below)  Target server name.
  recursive       (boolean, optional)  True to transfer a whole directory tree.
  reuseConnection (boolean, optional)  Default true. Set false after timeout.
  timeout         (number, optional)   SSH setup and SFTP channel-open timeout.
  vvv             (boolean, optional)  Default false. Append bounded SSH/SFTP debug.
  fast            (boolean, optional)  Default false. upload/download only:
                  use ssh2 fastPut/fastGet for each single file. Directory
                  recursion stays sequential; no multi-file concurrency.
  sftpConcurrency (number, optional)   Only with fast=true. Concurrent SFTP chunks.
  chunkSize       (number, optional)   Only with fast=true. SFTP chunk bytes.

Parameters for relay:
  mode              (string, required)   "relay"
  sourceServer      (string, required)   Server name to read from.
  sourceRemotePath  (string, required)   File path on source server.
  destServer        (string, required)   Server name to write to.
  destRemotePath    (string, required)   File path on dest server.
  reuseConnection   (boolean, optional)  Default true. Set false after timeout.
  timeout           (number, optional)   SSH setup and SFTP channel-open timeout.
  vvv               (boolean, optional)  Default false. Append bounded SSH/SFTP debug.
  fast              (boolean, optional)  Accepted but relay keeps the streaming
                    SFTP pipe path; fastGet/fastPut apply to host<->remote only.

connectionName rule (upload/download):
  • If only one server is enabled → optional.
  • If multiple servers are enabled → REQUIRED.

Examples:
  transfer { mode: "upload", localPath: "dist/", remotePath: "/opt/app/dist", recursive: true }
  transfer { mode: "relay", sourceServer: "prod", sourceRemotePath: "/var/log/app.log",
             destServer: "backup", destRemotePath: "/backup/app.log" }`,

  "help": `help — Show detailed usage for one or all tools.

Parameters:
  tool  (string, optional)  Tool name to get help for.
        If omitted, shows a summary of all available tools.

Example:
  help                           → overview of all tools
  help { tool: "execute-command" } → detailed usage for execute-command`,
};

const TOOL_OVERVIEW = `Available tools (use help { tool: "<name>" } for details):

  list-servers      Discover available SSH servers and their status.
  execute-command   Run a shell command on a remote server.
  show-whitelist    Show the active command policy.
  close-connection  Close a cached SSH connection for a server.
  command-status    Poll background command status and live log tail.
  upload            Upload a single file to a remote server.
  download          Download a single file from a remote server.
  transfer          Move files: single, recursive, or cross-server relay.
  help              Show this help or detailed per-tool usage.

Quick start:
  1. list-servers → discover server names
  2. show-whitelist { connectionName: "<name>" } → inspect command policy
  3. execute-command { cmdString: "pwd", connectionName: "<name>" }
  4. command-status { runId: "<runId>" } → poll stream=true background commands
  5. close-connection { connectionName: "<name>" } → drop a stale cached SSH client`;

/**
 * Register help tool
 */
export function registerHelpTool(server: McpServer): void {
  server.tool(
    "help",
    "Show detailed usage instructions for one or all tools. Call with no arguments for an overview, or specify a tool name for full parameter docs and examples.",
    {
      tool: z.string().optional().describe("Tool name to get detailed help for. Omit to see an overview of all tools."),
    },
    async ({ tool }) => {
      if (tool) {
        const text = TOOL_HELP[tool];
        if (!text) {
          return {
            content: [{ type: "text", text: `Unknown tool: "${tool}". ${TOOL_OVERVIEW}` }],
            isError: true,
          };
        }
        return { content: [{ type: "text", text }] };
      }

      return { content: [{ type: "text", text: TOOL_OVERVIEW }] };
    },
  );
}
