# 🤖 handfree-ssh-mcp

**Configure once. Let the LLM handle the rest.**

> 🧪 99.9% AI-coded [Include this Readme]. No artisanal hand-crafted code here.

A hands-free SSH automation tool via MCP. Fork of [ssh-mcp-server](https://github.com/classfang/ssh-mcp-server) designed for autonomous AI agent operations.

## 🎯 Philosophy

The original ssh-mcp-server requires passing credentials and options via CLI arguments every time. That's tedious.

**handfree-ssh-mcp** takes a different approach:

1. **Configure your servers once** in a YAML file
2. **Set your security whitelists** per server
3. **Let the LLM call whatever it needs** - hands-free

Less manual interventions. Just autonomous SSH execution with safeguards.

## ✨ What's New

| Feature | Original | handfree-ssh-mcp |
|---------|----------|------------------|
| Configuration | CLI args | **YAML config file only** |
| Multi-server | Messy `--ssh` flags | **Clean YAML structure** |
| Whitelists | Single comma-separated string | **Per-server arrays** |
| Streaming | Not supported | **Real-time output with `stream` param** |
| Discoverability | None | **`show-whitelist` tool for LLM** |

## 🚀 Quick Start

### 1. Create `servers.yaml`

```yaml
servers:
  dev:  # Server name - use this in --enable-servers
    host: xxxxx
    port: 22
    username: myuser
    password: mypassword
    # Define what the LLM is allowed to do
    whitelist:
      - "^ls.*$"
      - "^cat.*$"
      - "^pwd$"
      - "^docker.*$"
      - "^git.*$"
      # Add whatever commands you trust the LLM to run

  prod:
    host: XXXXX
    port: 22
    username: deploy
    privateKey: ~/.ssh/id_rsa
    whitelist:
      - "^ls.*$"        # Read only
      - "^cat.*$"
      - "^tail.*$"
    blacklist:
      - "^rm.*$"        # Never allow delete
      - "^shutdown.*$"
      - "^reboot.*$"
```

### 2. Add to MCP Config

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

### 3. Done. Let the LLM Work.

The AI can now execute commands on your servers. All within your defined security boundaries.

---

## 🛠️ Available Tools

| Tool | Description |
|------|-------------|
| `execute-command` | Run SSH command (with optional `stream` for real-time output) |
| `show-whitelist` | Show allowed commands for a server (helps LLM understand permissions) |
| `upload` | Upload file to server |
| `download` | Download file from server |
| `list-servers` | List configured servers |

### show-whitelist

**Use this first!** Let the LLM know what it's allowed to do:

```json
{
  "tool": "show-whitelist",
  "params": {
    "connectionName": "dev"
  }
}
```

Returns a formatted list of allowed command patterns with examples.

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
# Pre-connect on startup (optional)
preConnect: false

servers:
  server_name:
    host: 192.168.1.1          # Required
    port: 22                    # Optional, default 22
    username: root              # Required
    
    # Auth: use ONE of these
    password: xxx
    privateKey: ~/.ssh/id_rsa
    passphrase: key_password    # If privateKey is encrypted
    
    # Network
    socksProxy: socks5://host:port
    
    # Security (regex patterns)
    whitelist:                  # Only allow matching commands
      - "^ls.*$"
      - "^cat.*$"
    blacklist:                  # Block matching commands
      - "^rm -rf.*$"
    
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

### SFTP path policy

| Field | Scope | Default behavior |
|---|---|---|
| `allowedRemoteDirectories` | `upload` / `download` / `transfer` only | **Unset = SFTP disabled.** Must list absolute POSIX directories. |
| `allowedLocalDirectories` | `upload` / `download` only | Unset = only the MCP working directory is allowed. |

Path matching is exact-equal or `dir + separator` prefix. `..` segments and null bytes are rejected. Use `show-whitelist` to inspect a server's current SFTP policy.

### Upload behaviors

- **CRLF auto-fix for shell scripts.** When uploading a `.sh`, `.bash`, or `.zsh` file, any `\r\n` line endings are automatically converted to `\n` before the bytes are sent. The response notes when this happens and how many line endings were rewritten. The local file on disk is left untouched.
- **Skip-if-identical (default on).** Before transferring, `upload` checks whether the remote file already matches the local payload. Files ≤ 256 MiB are compared byte-for-byte; larger files are compared via MD5 (using `md5sum` on the remote host). **Shell scripts (`.sh` / `.bash` / `.zsh`) are compared in a line-ending-agnostic way — both sides are LF-normalized before the comparison, so a CRLF-only diff is treated as identical and the upload is still skipped.** If they match, the upload is skipped and the response says so. Pass `skipIfIdentical: false` to force a re-upload. Recursive `transfer` (`mode: upload`, `recursive: true`) applies the same check per file.

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
--config          Path to YAML config file (REQUIRED)
--enable-servers  Comma-separated list of servers to enable (REQUIRED for execute-command)
```

> **Note**: `--enable-servers` controls which servers are available. The first server listed becomes the default when `connectionName` is not specified.

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

- **Whitelist everything**: Define exactly what commands are allowed
- **Keep secrets safe**: Add `servers.yaml` to `.gitignore`
- **Per-server control**: Prod can be locked down, dev can be permissive

## 📋 TODO & PLAN

### High Priority
- [x] **Complete test coverage**: Add tests for `list-servers`, `upload`, `download`, `show-whitelist`, streaming mode, timeout/kill
- [ ] **Session support**: Add tools to list/create/resume/close persistent SSH sessions (for multi-command workflows)
- [ ] **LLM-based whitelist**: Allow LLM to propose commands, with human approval adding to dynamic whitelist

### Nice to Have
- [ ] **Command history**: Log executed commands per server for audit/debugging
- [x] **Multi-command execution**: Execute multiple commands in sequence with `&&` or `;` safely (fixed: `2>/dev/null` now allowed)
- [ ] **Server health check**: Periodic ping to detect connection drops early

## 📄 License

ISC License

- Original work: © 2025 junki.cn ([ssh-mcp-server](https://github.com/classfang/ssh-mcp-server))
- Modifications: © 2026 woqucc (handfree-ssh-mcp)
