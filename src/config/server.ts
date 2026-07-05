export const SERVER_CONFIG = {
  name: "ssh-mcp-server",
  version: "1.0.3",
};

export const SERVER_INSTRUCTIONS = `This server provides SSH access to servers loaded from OpenSSH config (~/.ssh/config by default) and optional YAML config/policy overlays.

Recommended workflow:
1. Call list-servers first to discover which server names are available, enabled, and currently connected.
2. Use show-whitelist before execute-command when you are unsure which command policy is active.
3. Use execute-command for remote shell commands. Prefer a single command per call. Compound commands may be rejected by command policy even if each subcommand is individually safe.
4. Use stream=false for short commands that should finish quickly, such as pwd, ls, cat, head, tail, git status, or docker ps.
5. Use stream=true for commands that may take longer or where incremental output is useful.
6. Use upload and download for single-file SFTP transfers. Use transfer for recursive directory transfers or cross-server relay.
7. Call help or help { tool: "<name>" } for detailed per-tool parameter docs and examples.

Server targeting:
- When only one server is enabled, connectionName can be omitted and the server is auto-selected.
- When multiple servers are enabled, connectionName is REQUIRED on execute-command, upload, download, show-whitelist, and transfer (upload/download mode). Omitting it returns an error listing the available names.

Behavior notes:
- A tool may automatically establish the SSH connection on first use.
- Command execution uses blacklist mode by default, with a built-in dangerous-command blacklist. Servers can opt into whitelist mode through YAML. If a command is rejected, inspect the command policy rather than retrying the same command repeatedly.
- Some commands return no output on success; this is normal.
- File transfer tools use SFTP and can fail if the remote path is missing or permissions are insufficient.
- OpenSSH/YAML config changes are hot-reloaded without restarting the server. Connection-field changes close the old client so the next tool call reconnects with fresh settings.`;
