# 🤖 handfree-ssh-mcp

一个通过 MCP（模型上下文协议）实现的免手动 SSH 自动化工具。基于 [ssh-mcp-server](https://github.com/classfang/ssh-mcp-server) 开发，为 AI 代理自主操作提供增强功能。

## 📝 项目概述

handfree-ssh-mcp 使 AI 助手能够通过标准化的 MCP 接口执行远程 SSH 命令。非常适合自动化工作流、DevOps 自动化和免手动服务器管理。

## ✨ 主要特性

- **🔒 安全连接**：支持密码认证、私钥认证（含密码短语支持）
- **🧩 自动读取 SSH 配置**：默认加载用户目录下的 `~/.ssh/config`，可用 YAML 增量覆盖连接字段和安全策略
- **🛡️ 命令安全控制**：通过白名单和黑名单机制过滤命令
- **🔄 标准化 MCP 接口**：与 AI 助手（Cursor、Claude 等）无缝集成
- **📂 文件传输**：双向文件传输（上传/下载）
- **🔑 凭证隔离**：SSH 凭证本地管理，永不暴露给 AI 模型
- **⏱️ 流式支持**：长时间运行命令的实时输出
- **🌐 SOCKS 代理**：内置代理支持

## 🛠️ 工具列表

| 工具 | 描述 |
|------|------|
| execute-command | 在远程服务器执行 SSH 命令并获取结果 |
| execute-command-stream | 执行命令并获取实时流式输出 |
| upload | 上传本地文件到远程服务器 |
| download | 从远程服务器下载文件 |
| list-servers | 列出所有可用的 SSH 服务器配置 |

## 📚 使用方法

### 🔧 MCP 配置示例

> **⚠️ 重要**：每个命令行参数及其值必须是 `args` 数组中的独立元素。

#### ⚙️ 命令行选项

```text
选项:
  --config            可选 YAML 配置/安全策略覆盖文件
  --ssh-config        可选 OpenSSH config 路径，可逗号分隔或重复传入
  --no-ssh-config     禁用默认的 ~/.ssh/config 自动加载
  --enable-servers    可选，逗号分隔的启用服务器名；不传则启用全部已加载 Host
  --pre-connect       启动时预连接所有启用服务器
```

#### 🔑 直接复用 `~/.ssh/config`

如果你的 `~/.ssh/config` 里已有：

```sshconfig
Host dev
  HostName 192.168.1.1
  User root
  IdentityFile ~/.ssh/id_ed25519
```

MCP 配置可以直接写：

```json
{
  "mcpServers": {
    "handfree-ssh-mcp": {
      "command": "npx",
      "args": [
        "-y",
        "handfree-ssh-mcp",
        "--enable-servers", "dev"
      ]
    }
  }
}
```

#### 🛡️ 用 YAML 增量添加安全策略

`servers.yaml` 可以只补同名 Host 的策略，也可以覆盖连接字段：

```yaml
sshConfig: true

servers:
  dev:
    whitelist:
      - "^pwd$"
      - "^ls( .*)?$"
      - "^cat .*$"
    blacklist:
      - "^rm.*$"

  prod:
    host: prod.example.com
    username: deploy
    privateKey: ~/.ssh/id_ed25519
    whitelist:
      - "^ls( .*)?$"
      - "^tail .*$"
```

然后在 MCP 配置中传入 YAML：

```json
{
  "mcpServers": {
    "handfree-ssh-mcp": {
      "command": "npx",
      "args": [
        "-y",
        "handfree-ssh-mcp",
        "--config", "/path/to/servers.yaml",
        "--enable-servers", "dev,prod"
      ]
    }
  }
}
```

在特定连接上执行：

```json
{
  "tool": "execute-command",
  "params": {
    "cmdString": "ls -al",
    "connectionName": "prod"
  }
}
```

### ⏱️ 命令执行超时

- **timeout**: 命令执行超时（毫秒），默认 30000ms
- **execute-command-stream**: 扩展超时（默认 300000ms / 5分钟），适用于长时间运行的任务

## 🛡️ 安全注意事项

- **命令白名单**：强烈建议使用以限制可执行命令
- **私钥安全**：确保运行此服务器的机器安全
- **速率限制**：考虑在防火墙后运行并启用速率限制
- **路径遍历**：内置保护，但请注意上传/下载路径

## 📄 许可证

ISC 许可证 - 基于 [ssh-mcp-server](https://github.com/classfang/ssh-mcp-server) by Junki

## 🙏 致谢

本项目是 [classfang/ssh-mcp-server](https://github.com/classfang/ssh-mcp-server) 的分支。感谢原作者提供的优秀基础！
