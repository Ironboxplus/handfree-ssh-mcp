# 🤖 handfree-ssh-mcp

**Configure once. Let the LLM handle the rest.**

> 🧪 99.9% AI-coded [Include this Readme]. No artisanal hand-crafted code here.

A hands-free SSH automation tool via MCP. Fork of [ssh-mcp-server](https://github.com/classfang/ssh-mcp-server) designed for autonomous AI agent operations.

## 🎯 Philosophy

The original ssh-mcp-server requires passing credentials and options via CLI arguments every time. That's tedious.

**handfree-ssh-mcp** takes a different approach:

1. **Reuse your existing `~/.ssh/config`** automatically, or configure servers once in YAML
2. **Set command policies** per server through a YAML overlay
3. **Let the LLM call whatever it needs** - hands-free

Less manual interventions. Just autonomous SSH execution with safeguards.

## ✨ What's New

| Feature | Original | handfree-ssh-mcp |
|---------|----------|------------------|
| Configuration | CLI args | **OpenSSH `~/.ssh/config` + optional YAML overlay** |
| Multi-server | Messy `--ssh` flags | **Clean YAML structure** |
| Command policy | Single comma-separated whitelist | **Blacklist mode by default, optional whitelist mode** |
| Streaming | Not supported | **Real-time output with `stream` param** |
| Discoverability | None | **`show-whitelist` tool for LLM** |

## 🚀 Quick Start

### 1. Use your existing `~/.ssh/config`

If you already have:

```sshconfig
Host dev
  HostName 192.168.1.100
  User root
  IdentityFile ~/.ssh/id_ed25519
```

you can start the MCP without a YAML file:

```json
{
  "mcpServers": {
    "ssh": {
      "command": "npx",
      "args": ["-y", "@aaarc/handfree-ssh-mcp", "--enable-servers", "dev"]
    }
  }
}
```

`--enable-servers` is optional. If you omit it, every concrete `Host` entry loaded from `~/.ssh/config` (plus YAML entries, if any) is enabled.

### 2. Optional: create `servers.yaml` for policies or overrides

```yaml
sshConfig: true  # default; loads ~/.ssh/config before applying this YAML

servers:
  dev:  # Server name - use this in --enable-servers
    # host / port / username / privateKey can be omitted when dev exists in ~/.ssh/config.
    # Values here override the OpenSSH config entry when present.
    # commandMode defaults to blacklist: commands are allowed unless they
    # match the built-in dangerous blacklist or a pattern below.
    blacklist:
      - "^docker system prune.*$"

  prod:
    host: XXXXX
    port: 22
    username: deploy
    privateKey: ~/.ssh/id_rsa
    commandMode: whitelist
    whitelist:
      - "^ls.*$"        # Read only
      - "^cat.*$"
      - "^tail.*$"
    blacklist:
      - "^rm.*$"        # Never allow delete
      - "^shutdown.*$"
      - "^reboot.*$"
```

### 3. Add to MCP Config

```json
{
  "mcpServers": {
    "ssh": {
      "command": "node",
      "args": [
        "/path/to/handfree-ssh-mcp/build/index.js",
        "--config", "/path/to/servers.yaml",
        "--enable-servers", "dev,prod"
      ]
    }
  }
}
```

### 4. Done. Let the LLM Work.

The AI can now execute commands on your servers. All within your defined security boundaries.

---

## 🛠️ Available Tools

| Tool | Description |
|------|-------------|
| `execute-command` | Run SSH command (with optional `stream` for real-time output) |
| `show-whitelist` | Show active command policy + SFTP policy + output-log path for a server |
| `upload` | Upload local file to a remote server (CRLF-fix for shell scripts, skip-if-identical) |
| `download` | Download remote file to local disk |
| `transfer` | Unified upload / download / server-to-server relay (`mode`: `upload` / `download` / `relay`, optional `recursive`, optional `skipIfIdentical`) |
| `list-servers` | List configured (enabled) servers. Lean by default; `verbose:true` adds cached system status, `refresh:true` re-collects it (implies verbose). |
| `help` | Self-describing help text for the MCP client |

### show-whitelist

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

### execute-command

```json
{
  "tool": "execute-command",
  "params": {
    "cmdString": "docker ps",
    "connectionName": "dev",
    "timeout": 300000,
    "stream": true
  }
}
```

| Param | Required | Default | Description |
|-------|----------|---------|-------------|
| `cmdString` | ✅ | - | Command to execute |
| `connectionName` | ❌ | First in `--enable-servers` | Which server to run on |
| `timeout` | ❌ | 300000ms (stream) / 30000ms (no stream) | Timeout in ms |
| `stream` | ❌ | `true` | Real-time streaming output |

**When to use `stream: false`:**
- Simple, fast commands (ls, pwd, cat)
- When you don't need real-time feedback

## 📄 YAML Config Reference

```yaml
# OpenSSH config loading is enabled by default.
# true = load ~/.ssh/config, false = use YAML only.
# You can also provide explicit paths:
sshConfig:
  enabled: true
  paths:
    - ~/.ssh/config
    - ~/.ssh/config.d/work

# Eagerly connect to all enabled servers on startup.
# false (default) = lazy connect on first tool call.
preConnect: false

# Optional: root dir for execute-command full-output logs.
# Per-call logs land under <outputLogDir>/<server>/<user>/<ts>-<pid>-<rand>.log.
# Defaults to <cwd>/.handfree-output when unset. Supports ~ and relative paths.
outputLogDir: ~/handfree-logs

servers:
  server_name:
    # Required only for YAML-only servers. If a same-named Host exists in
    # ~/.ssh/config, these fields are optional overrides.
    host: 192.168.1.1
    port: 22
    username: root
    
    # Auth: use ONE of these. Omit agent to use SSH_AUTH_SOCK when present;
    # set agent only when you need a specific socket path.
    password: xxx
    privateKey: ~/.ssh/id_rsa
    agent: /path/to/ssh-agent.sock
    passphrase: key_password    # If privateKey is encrypted
    
    # Network — at most ONE of `socksProxy` or `jumpHost`. See "Jump host" below.
    # socksProxy: socks5://host:port
    # jumpHost: bastion

    
    # Command policy (regex patterns)
    # Default is blacklist. Set commandMode: whitelist to require a whitelist.
    commandMode: blacklist
    whitelist:                  # Active only in whitelist mode
      - "^ls.*$"
      - "^cat.*$"
    blacklist:                  # Block matching commands
      - "^docker system prune.*$"
    
    # Safe directory for destructive commands (rm, etc.)
    safeDirectory: /home/user   # rm allowed only within this path

    # SFTP path policy — applies ONLY to upload / download / transfer.
    # execute-command is NOT affected by these lists.
    # If `allowedRemoteDirectories` is unset or empty, SFTP is DISABLED for the server.
    allowedRemoteDirectories:
      - /home/user
      - /tmp
    # Extra local dirs allowed as SFTP source/target.
    # The MCP working directory is always permitted implicitly.
    allowedLocalDirectories:
      - /path/to/extra/local/dir
```

### Security note: command policy

`execute-command` defaults to `commandMode: blacklist`. In that mode commands are allowed unless they match built-in destructive guards, the built-in dangerous-command blacklist, or a server's configured `blacklist:` patterns. Built-in blocked operations include hidden/chained destructive file operations, risky absolute-path output redirection, system power commands (`reboot`, `shutdown`, `halt`, `poweroff`), recursive force delete (`rm -rf`), destructive disk writes (`dd ... of=`), and filesystem formatting commands. Set `commandMode: whitelist` to require every command to match `whitelist:` after blacklist checks. For compatibility, a YAML server that contains `whitelist:` without `commandMode:` is treated as whitelist mode.

### SFTP path policy

| Field | Scope | Default behavior |
|---|---|---|
| `allowedRemoteDirectories` | `upload` / `download` / `transfer` only | **Unset = SFTP disabled.** Must list absolute POSIX directories. |
| `allowedLocalDirectories` | `upload` / `download` only | Unset = only the MCP working directory is allowed. |

Path matching is exact-equal or `dir + separator` prefix. `..` segments and null bytes are rejected. Use `show-whitelist` to inspect a server's current SFTP policy.

### Jump host (ProxyJump-style)

Tunnel a target's SSH connection through another server defined in the same YAML. Useful when the target isn't directly reachable from your machine but a bastion is.

```yaml
servers:
  bastion:
    host: 1.2.3.4
    username: gate
    privateKey: ~/.ssh/id_rsa

  target:                       # NOT directly reachable
    host: 10.0.0.5
    username: app
    password: <target-password>
    jumpHost: bastion           # <- tunnel through `bastion`
    whitelist:                  # target's own policy
      - "^ls( .*)?$"
      - "^pwd$"
```

Rules (enforced at config load — bad configs fail fast):

- **Single level only.** The referenced jump host must NOT itself set `jumpHost`. No chaining.
- **Mutually exclusive with `socksProxy`** on the same target.
- **Self-reference is rejected.** `target.jumpHost: target` is invalid.
- **Independent policy.** The target authenticates with its OWN `username` / `password` / `privateKey`, and its own `whitelist` / `blacklist` / `safeDirectory` / `allowed*Directories` apply. The jump host is purely transport.
- **Jump host is still a normal server.** You can run tools against `bastion` directly; its connection is separate from the tunneling one.

**Hot-reload note:** `jumpHost` is connection-level, not policy-level. Editing it in `servers.yaml` while the server is running will NOT take effect — the hot-reloader only refreshes whitelist / blacklist / `safeDirectory` / `allowed*Directories`. Restart the MCP server to pick up `jumpHost` changes.

### Connection lifecycle (connect / reconnect)

- **Lazy by default.** A server's SSH client is created on its first tool call via `ensureConnected()`. Set `preConnect: true` (or pass `--pre-connect`) to open all enabled servers at startup in parallel; failures are logged but don't block startup.
- **Auto-reconnect on `execute-command`.** Every command runs inside a retry loop (default 3 attempts: 1 initial + 2 retries) with exponential backoff. If the underlying error matches a connection-shaped pattern (`econnreset`, `epipe`, `socket`, `closed`, `channel`, `end of stream`, or a `SSH_CONNECTION_FAILED` ToolError), the manager closes the dead client, reconnects, and retries the command. Non-connection errors (permission denied, validation, command-not-found) are returned immediately without retry.
- **SFTP transfers do NOT auto-retry.** `upload` / `download` / `transfer` lazy-connect via the same path, but a mid-transfer disconnect surfaces as a single failure — re-issue the call manually. This is a known gap.
- **No background keepalive or health probe.** Dead connections are only discovered on the next tool call. If you idle for hours through a NATed network, expect the first call after the gap to fail-then-reconnect on its own (you'll see one retry in the logs).

### Upload behaviors

- **CRLF auto-fix for shell scripts.** When uploading a `.sh`, `.bash`, or `.zsh` file, any `\r\n` line endings are automatically converted to `\n` before the bytes are sent. The response notes when this happens and how many line endings were rewritten. The local file on disk is left untouched.
- **Skip-if-identical (default on).** Before transferring, `upload` checks whether the remote file already matches the local payload. Files ≤ 256 MiB are compared byte-for-byte; larger files are compared via MD5 (using `md5sum` on the remote host). **Shell scripts (`.sh` / `.bash` / `.zsh`) are compared in a line-ending-agnostic way — both sides are LF-normalized before the comparison, so a CRLF-only diff is treated as identical and the upload is still skipped.** If they match, the upload is skipped and the response says so. Pass `skipIfIdentical: false` to force a re-upload. Recursive `transfer` (`mode: upload`, `recursive: true`) applies the same check per file.
- **Relay skip-if-identical (default on).** `transfer mode=relay` does the same check between two remote servers: matching size on both sides plus matching `md5sum` skips the transfer. If `md5sum` is missing on either server, the check falls back to a normal transfer.

### `execute-command` output capping & full logs

`execute-command` always persists the FULL stdout and stderr of every invocation to a local plain-text log file, then returns only a tail-truncated view to the caller. This keeps the LLM-visible payload small without losing any data.

- **Default cap:** 65536 bytes (64 KiB) per stream, tail-only. Set `maxOutputBytes` on the tool call to raise/lower the cap.
- **Streaming is unaffected.** When `stream: true`, every chunk still reaches the progress channel live; only the final aggregated return value is capped.
- **Log path:** `<outputLogDir>/<server-name>/<username>/<timestamp>-<pid>-<rand>.log`. Default `outputLogDir` is `<cwd>/.handfree-output`. Override with a top-level `outputLogDir:` entry in `servers.yaml` (supports `~` and relative paths).
- **Log format:** plain UTF-8 text with `=== META ===` / `=== STDOUT ===` / `=== STDERR ===` / `=== END ===` separators. Tail with `tail -f` while a command is running? Not yet — the file is finalized on close.
- **Truncation marker:** when output is trimmed, the returned text starts with an `[OUTPUT TRUNCATED]` header that lists total bytes, bytes dropped, and the on-disk log path. When output fits within the cap, no header is added and no log path is reported (the file is still written).
- **Retention:** none. Manage cleanup yourself (e.g. `find .handfree-output -mtime +7 -delete`).
- **Failures are non-fatal.** If the log file cannot be written, the command still completes and the failure is logged as an MCP-side warning.

```yaml
# servers.yaml
outputLogDir: ~/handfree-logs  # optional; defaults to <cwd>/.handfree-output
servers:
  dev: { ... }
```

## ⚙️ CLI Options

```text
--config          Optional path to YAML config/policy overlay
--ssh-config      Optional OpenSSH config path(s), comma-separated or repeated
--no-ssh-config   Disable automatic ~/.ssh/config loading
--enable-servers  Optional comma-separated list of servers to enable
--pre-connect     Eagerly connect to all enabled servers on startup
                  (overrides `preConnect` in YAML). Default: lazy connect.
```

> **Note**: `--enable-servers` controls which servers are available. The first server listed becomes the default when `connectionName` is not specified.
> If `--enable-servers` is omitted, all loaded servers are enabled; when more than one server is enabled, tools require `connectionName`.

### OpenSSH config support

The loader understands concrete `Host` entries and applies normal OpenSSH-style first-value matching against wildcard defaults. It supports `HostName`, `User`, `Port`, `IdentityFile`, `IdentityAgent`, `Include`, and common tokens such as `%h`, `%n`, `%p`, `%r`, `%u`, `%d`, and `%%`. Wildcard-only `Host *` blocks are used as defaults but are not exposed as runnable server names. `Match` blocks are ignored.

Connection settings are hot-reloaded when the loaded YAML/OpenSSH config files change. If host, user, port, identity, agent, passphrase, or proxy settings change, the existing SSH client for that server is closed and the next tool call reconnects with the new values. Whitelist, blacklist, SFTP policy, and output log settings also update live.

Example with selective servers:

```json
{
  "args": [
    "--config", "servers.yaml",
    "--enable-servers", "dev,staging"
  ]
}
```

## 🛡️ Security

- **Pick the right command policy**: use default blacklist mode for flexible automation, or `commandMode: whitelist` for locked-down hosts
- **Keep secrets safe**: Add `servers.yaml` to `.gitignore`
- **Per-server control**: Prod can be locked down, dev can be permissive

## 📋 TODO & PLAN

### High Priority
- [x] **Complete test coverage**: Add tests for `list-servers`, `upload`, `download`, `show-whitelist`, streaming mode, timeout/kill
- [ ] **Session support**: Add tools to list/create/resume/close persistent SSH sessions (for multi-command workflows)
- [ ] **LLM-based whitelist**: Allow LLM to propose commands, with human approval adding to dynamic whitelist

### Nice to Have
- [x] **Command history / output archive**: full stdout/stderr of every `execute-command` is persisted under `<outputLogDir>/<server>/<user>/*.log`
- [x] **Multi-command execution**: Execute multiple commands in sequence with `&&` or `;` safely (fixed: `2>/dev/null` now allowed)
- [x] **Connection auto-recovery**: `execute-command` retries with exponential backoff and forced reconnect on connection-shaped errors
- [ ] **SFTP retry parity**: extend the retry-with-reconnect loop to `upload` / `download` / `transfer`
- [ ] **TCP keepalive**: pass `keepaliveInterval` / `keepaliveCountMax` to `ssh2.Client` so half-open connections are detected without waiting for the next command
- [ ] **Server health check**: optional periodic ping to detect drops proactively

## 📄 License

ISC License

- Original work: © 2025 junki.cn ([ssh-mcp-server](https://github.com/classfang/ssh-mcp-server))
- Modifications: © 2026 woqucc (handfree-ssh-mcp)
