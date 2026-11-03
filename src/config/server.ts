export const SERVER_CONFIG = {
  name: "ssh-mcp-server",
  version: "2.5.0",
};

export const SERVER_INSTRUCTIONS = `SSH access using ~/.ssh/config and optional YAML settings.

Targets: use list-servers to discover server names. connectionName selects a server; workspace-run calls the same field server and may obtain it from a saved profile. With multiple enabled servers, pass the target explicitly unless a profile selects it. command-status identifies its command by runId alone.

Commands: execute-command sends cmdString unchanged to the remote SSH service's default shell. Write ordinary commands directly; add cmd, pwsh, bash or sh only to select a different interpreter. Each call opens a separate exec session: connection reuse does not preserve cd, exported variables or shell state. Prefer stream=false for short commands to wait for their output. stream=true (default) means background execution and immediate return of runId/logPath, not streaming within the tool call; poll command-status for incremental output. This command's status is local to the MCP process and is lost on restart. Use workspace-run when the task must survive disconnects and MCP restarts.

Policy: show-whitelist displays the full command and SFTP path policy despite its legacy name. Commands use blacklist mode by default; YAML can opt into whitelist mode. Inspect the policy after a rejection. SFTP path restrictions do not restrict shell commands.

Files: upload/download use SFTP; transfer also handles directories and remote-to-remote copies. mode=relay means remote-to-remote and takes sourceServer, sourceRemotePath, destServer and destRemotePath; unknown arguments are rejected. strategy=relay (default) transfers via this MCP host using bounded parallel SFTP read-ahead, direct copies on the source using its existing SSH trust, and auto falls back to relay if direct is unavailable. fast defaults to true for upload/download (false is a slow serial mode). Uploads are skipped only when the remote MD5 matches the bytes to be written; with no remote md5sum they are uploaded. A same-server relay is copied by the server itself when its SFTP advertises copy-data. fileConcurrency controls parallel files; connections controls independent SSH/TCP connections for a single file (1-8), excluding batch, recursive, archive and direct/auto transfers. archive packs a temporary tar for transfer. See help for constraints and tuning.

Durable tasks: workspace-run supports Linux remotes with bash, setsid and /proc. No YAML run profile is required: pass remoteRoot, entrypoint and venv or executable inline; a profile is an optional preset. pushPaths uploads local code; collect plus collectLocalDir retrieves artifacts. Without collect, return after startup; with collect, wait for completion up to timeout. Remote state survives MCP restarts. Use run-status/run-logs/run-cancel/run-retry with the original server and runId; jobId in task-specific responses is an alias of runId. Use run-list to discover runs on a server. Only sync=none is supported.

Connections are reused by default. For a suspected stale connection, use reuseConnection=false or close-connection. For SSH diagnostics use vvv=true; fresh handshake logs also need reuseConnection=false. OpenSSH/YAML settings are hot-reloaded. Use help { tool: "<name>" } for full parameter docs and examples.`;
