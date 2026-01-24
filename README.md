# 🤖 handfree-ssh-mcp

A hands-free SSH automation tool via MCP (Model Context Protocol). Fork of [ssh-mcp-server](https://github.com/classfang/ssh-mcp-server) with enhanced features for autonomous AI agent operations.

## 📝 Project Overview

handfree-ssh-mcp enables AI assistants to execute remote SSH commands through a standardized MCP interface. Perfect for autonomous workflows, DevOps automation, and hands-free server management.

## ✨ Key Features

- **🔒 Secure Connections**: Password authentication, private key authentication (with passphrase support)
- **🛡️ Command Security Control**: Whitelist and blacklist mechanisms for command filtering
- **🔄 Standardized MCP Interface**: Seamless integration with AI assistants (Cursor, Claude, etc.)
- **📂 File Transfer**: Bidirectional file transfers (upload/download)
- **🔑 Credential Isolation**: SSH credentials managed locally, never exposed to AI models
- **⏱️ Streaming Support**: Real-time output for long-running commands
- **🌐 SOCKS Proxy**: Built-in proxy support for network routing

## 🛠️ Tools List

| Tool | Description |
|------|-------------|
| execute-command | Execute SSH commands on remote servers and get results |
| execute-command-stream | Execute commands with real-time streaming output |
| upload | Upload local files to remote servers |
| download | Download files from remote servers |
| list-servers | List all available SSH server configurations |

## 📚 Usage

### 🔧 MCP Configuration Examples

> **⚠️ Important**: Each command line argument and its value must be separate elements in the `args` array.

#### ⚙️ Command Line Options

```text
Options:
  -h, --host          SSH server host address
  -p, --port          SSH server port
  -u, --username      SSH username
  -w, --password      SSH password
  -k, --privateKey    SSH private key file path
  -P, --passphrase    Private key passphrase (if any)
  -W, --whitelist     Command whitelist, comma-separated regular expressions
  -B, --blacklist     Command blacklist, comma-separated regular expressions
  -s, --socksProxy    SOCKS proxy server address (e.g., socks://user:password@host:port)
```

#### 🔑 Using Password

```json
{
  "mcpServers": {
    "handfree-ssh-mcp": {
      "command": "npx",
      "args": [
        "-y",
        "handfree-ssh-mcp",
        "--host", "192.168.1.1",
        "--port", "22",
        "--username", "root",
        "--password", "your-password"
      ]
    }
  }
}
```

#### 🔐 Using Private Key

```json
{
  "mcpServers": {
    "handfree-ssh-mcp": {
      "command": "npx",
      "args": [
        "-y",
        "handfree-ssh-mcp",
        "--host", "192.168.1.1",
        "--port", "22",
        "--username", "root",
        "--privateKey", "~/.ssh/id_rsa"
      ]
    }
  }
}
```

#### 🔏 Using Private Key with Passphrase

```json
{
  "mcpServers": {
    "handfree-ssh-mcp": {
      "command": "npx",
      "args": [
        "-y",
        "handfree-ssh-mcp",
        "--host", "192.168.1.1",
        "--port", "22",
        "--username", "root",
        "--privateKey", "~/.ssh/id_rsa",
        "--passphrase", "your-passphrase"
      ]
    }
  }
}
```

#### 🌐 Using SOCKS Proxy

```json
{
  "mcpServers": {
    "handfree-ssh-mcp": {
      "command": "npx",
      "args": [
        "-y",
        "handfree-ssh-mcp",
        "--host", "192.168.1.1",
        "--port", "22",
        "--username", "root",
        "--password", "your-password",
        "--socksProxy", "socks://username:password@proxy-host:proxy-port"
      ]
    }
  }
}
```

#### 📝 Using Command Whitelist and Blacklist

**Whitelist Example** (only allow specific commands):

```json
{
  "mcpServers": {
    "handfree-ssh-mcp": {
      "command": "npx",
      "args": [
        "-y",
        "handfree-ssh-mcp",
        "--host", "192.168.1.1",
        "--port", "22",
        "--username", "root",
        "--password", "your-password",
        "--whitelist", "^ls( .*)?,^cat .*,^df.*"
      ]
    }
  }
}
```

**Blacklist Example** (block dangerous commands):

```json
{
  "mcpServers": {
    "handfree-ssh-mcp": {
      "command": "npx",
      "args": [
        "-y",
        "handfree-ssh-mcp",
        "--host", "192.168.1.1",
        "--port", "22",
        "--username", "root",
        "--password", "your-password",
        "--blacklist", "^rm .*,^shutdown.*,^reboot.*"
      ]
    }
  }
}
```

> Note: If both whitelist and blacklist are specified, the command must pass both checks to be executed.

### 🧩 Multi-SSH Connection Example

Specify multiple SSH connections with unique names:

```bash
npx handfree-ssh-mcp \
  --ssh "name=dev,host=1.2.3.4,port=22,user=alice,password=xxx" \
  --ssh "name=prod,host=5.6.7.8,port=22,user=bob,password=yyy"
```

Execute on a specific connection:

```json
{
  "tool": "execute-command",
  "params": {
    "cmdString": "ls -al",
    "connectionName": "prod"
  }
}
```

With timeout:

```json
{
  "tool": "execute-command",
  "params": {
    "cmdString": "ping -c 10 127.0.0.1",
    "connectionName": "prod",
    "timeout": 5000
  }
}
```

### ⏱️ Command Execution Timeout

- **timeout**: Command execution timeout in milliseconds (default: 30000ms)
- **execute-command-stream**: Extended timeout (default: 300000ms / 5 minutes) for long-running tasks

### 🗂️ List All SSH Servers

```json
{
  "tool": "list-servers",
  "params": {}
}
```

Response:

```json
[
  { "name": "dev", "host": "1.2.3.4", "port": 22, "username": "alice" },
  { "name": "prod", "host": "5.6.7.8", "port": 22, "username": "bob" }
]
```

## 🛡️ Security Considerations

- **Command Whitelisting**: Strongly recommended to restrict executable commands
- **Private Key Security**: Ensure the machine running this server is secure
- **Rate Limiting**: Consider running behind a firewall with rate-limiting
- **Path Traversal**: Built-in protection, but be mindful of upload/download paths

## 📄 License

ISC License - Based on [ssh-mcp-server](https://github.com/classfang/ssh-mcp-server) by Junki

## 🙏 Credits

This project is a fork of [classfang/ssh-mcp-server](https://github.com/classfang/ssh-mcp-server). Thanks to the original author for the excellent foundation!
