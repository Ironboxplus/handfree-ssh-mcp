export const SERVER_CONFIG = {
  name: "ssh-mcp-server",
  version: "1.0.17",
};

export const SERVER_INSTRUCTIONS = `This server provides SSH access to servers loaded from OpenSSH config (~/.ssh/config by default) and optional YAML config/policy overlays.

Recommended workflow:
1. Call list-servers first to discover which server names are available, enabled, and currently connected.
2. Use show-whitelist before execute-command when you are unsure which command policy is active.
3. Use execute-command for remote shell commands. Prefer a single command per call. Compound commands may be rejected by command policy even if each subcommand is individually safe.
4. Use stream=false for short commands that should finish quickly, such as pwd, ls, cat, head, tail, git status, or docker ps.
5. Use stream=true (the default) for long-running commands. It starts the command in the background and returns runId/logPath immediately; poll with command-status instead of holding one tools/call open. command-status uses incremental output by default and advances its per-run cursor automatically.
6. execute-command reuses SSH connections by default. If an execute-command call times out, retry the next command with reuseConnection=false to bypass a potentially stale cached SSH connection.
7. SFTP tools also reuse SSH connections by default. If upload/download/transfer times out or reports a connection-shaped SFTP/channel error, retry with reuseConnection=false; the fresh SSH connection closes after that transfer.
8. Use close-connection to close a cached SSH connection for a server before retrying with a clean reused connection. Closing a jump host also closes cached targets that jump through it.
9. For SSH/channel diagnostics, add vvv=true. Use it with reuseConnection=false when you need fresh handshake/debug output.
10. Use upload and download for single-file SFTP transfers. Use transfer for recursive directory transfers or cross-server relay.
11. For large host-to-remote or remote-to-host single-file SFTP transfers, fast=true enables ssh2 fastPut/fastGet with optional sftpConcurrency and chunkSize. It is off by default and does not add multi-file concurrency; relay keeps the streaming pipe path.
12. Call help or help { tool: "<name>" } for detailed per-tool parameter docs and examples.

Server targeting:
- When only one server is enabled, connectionName can be omitted and the server is auto-selected.
- When multiple servers are enabled, connectionName is REQUIRED on execute-command, close-connection, upload, download, show-whitelist, and transfer (upload/download mode). command-status uses the runId returned by execute-command.

Behavior notes:
- A tool may automatically establish the SSH connection on first use.
- Command execution uses blacklist mode by default, with a built-in dangerous-command blacklist. Servers can opt into whitelist mode through YAML. If a command is rejected, inspect the command policy rather than retrying the same command repeatedly.
- Some commands return no output on success; this is normal.
- File transfer tools use SFTP and can fail if the remote path is missing or permissions are insufficient. They open a new SFTP channel per operation; they reuse the underlying SSH client unless reuseConnection=false is set.
- OpenSSH/YAML config changes are hot-reloaded without restarting the server. Connection-field changes close the old client so the next tool call reconnects with fresh settings.`;
