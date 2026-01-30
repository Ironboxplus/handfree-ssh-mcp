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
