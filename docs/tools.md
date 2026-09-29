[← Back to README](../README.md)

# Tools

| Tool | Description |
|------|-------------|
| `execute-command` | Run SSH command (with optional `stream` for real-time output) |
| `show-whitelist` | Show active command policy + SFTP policy + output-log path for a server |
| `close-connection` | Close a cached SSH connection for a server |
| `upload` | Upload local file(s) to a remote server (CRLF-fix for shell scripts, skip-if-identical, optional `reuseConnection`, `vvv`, `fast`; `localPath` accepts an array for batch upload — see [Upload behaviors](transfer.md#upload-behaviors)) |
| `download` | Download remote file to local disk (optional `reuseConnection`, `vvv`, `fast`, or `connections` for a multi-connection ranged download — see [Multi-connection download](transfer.md#multi-connection-download)) |
| `transfer` | Unified upload / download / server-to-server relay. Supports recursive small-file concurrency (`fileConcurrency`), batch upload (array `localPath`), temporary tar packing (`archive`, `archiveCompression`), fast SFTP by default, a bounded relay read-ahead window, and relay `strategy: "relay" \| "direct" \| "auto"` for a source-to-destination direct copy that bypasses this host — see [Upload behaviors](transfer.md#upload-behaviors). |
| `list-servers` | List configured (enabled) servers. Lean by default; `verbose:true` adds cached system status, `refresh:true` re-collects it (implies verbose). |
| `workspace-run` | Launch an entrypoint on a remote server — **no YAML config needed**: pass `remoteRoot` + `venv`/`executable` inline, or use a saved `runProfiles.<name>` preset. `[push] → preflight → launching → remote-running → [collect]`. Durable: survives SSH disconnect and MCP adapter restart because all state lives on the remote filesystem, not locally — see [workspace-run (remote runner)](workspace-run.md). |
| `run-status` | Query a `workspace-run` run's current status by `runId` (reads the remote state directory over SFTP; no local cache). |
| `run-logs` | Read a byte-offset window of a run's stdout/stderr, UTF-8-boundary-safe across sequential calls. |
| `run-list` | List runs on a server, newest first. |
| `run-cancel` | Cancel a run: TERM to its process group, then KILL after `graceMs`; re-verifies process identity before signalling. |
| `run-retry` | Launch a fresh run from an earlier run's own stored (non-secret) config snapshot, not the live config; records `parentRunId`. |
| `help` | Self-describing help text for the MCP client |

## show-whitelist

**Use this first!** Let the LLM inspect the active command policy:

```json
{
  "tool": "show-whitelist",
  "params": {
    "connectionName": "dev"
  }
}
```

Returns command mode, built-in command guards, configured whitelist/blacklist patterns, and examples when whitelist mode is active.

## execute-command

```json
{
  "tool": "execute-command",
  "params": {
    "cmdString": "docker ps",
    "connectionName": "dev",
    "timeout": 300000,
    "stream": true,
    "reuseConnection": true,
    "vvv": false
  }
}
```

| Param | Required | Default | Description |
|-------|----------|---------|-------------|
| `cmdString` | ✅ | - | Command to execute |
| `connectionName` | ❌ | First in `--enable-servers` | Which server to run on |
| `timeout` | ❌ | 300000ms (stream) / 30000ms (no stream) | Per-attempt phase timeout in ms. SSH setup, exec-channel opening, and remote command execution each use this cap. |
| `stream` | ❌ | `true` | Real-time streaming output |
| `reuseConnection` | ❌ | `true` | Reuse the cached SSH connection. Set `false` after a timeout or suspected stale cached connection to force a fresh TCP/SSH connection for this command. |
| `vvv` | ❌ | `false` | Append bounded SSH/channel debug output. Use with `reuseConnection: false` when you need fresh ssh2 handshake logs. |

**When to use `stream: false`:**
- Simple, fast commands (ls, pwd, cat)
- When you don't need real-time feedback

## close-connection

```json
{
  "tool": "close-connection",
  "params": {
    "connectionName": "dev"
  }
}
```

Closes the cached SSH client for a configured server. This is useful after a timeout or suspected stale reused connection when you want the next default `reuseConnection: true` command to reconnect cleanly. Closing a jump host also closes cached targets whose jump chain uses that host. `reuseConnection: false` commands do not need this because their one-shot SSH clients close after each command.
