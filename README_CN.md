# 🤖 handfree-ssh-mcp

一个通过 MCP（模型上下文协议）实现的免手动 SSH 自动化工具。基于 [ssh-mcp-server](https://github.com/classfang/ssh-mcp-server) 开发，为 AI 代理自主操作提供增强功能。

## 📝 项目概述

handfree-ssh-mcp 使 AI 助手能够通过标准化的 MCP 接口执行远程 SSH 命令。非常适合自动化工作流、DevOps 自动化和免手动服务器管理。

## ✨ 主要特性

- **🔒 安全连接**：支持密码认证、私钥认证（含密码短语支持）
- **🧩 自动读取 SSH 配置**：默认加载用户目录下的 `~/.ssh/config`，可用 YAML 增量覆盖连接字段和安全策略
- **🛡️ 命令安全控制**：默认黑名单模式，支持切换到白名单模式
- **🔄 标准化 MCP 接口**：与 AI 助手（Cursor、Claude 等）无缝集成
- **📂 文件传输**：上传、下载和双远端 relay；relay 使用有界的分块预取窗口，不在本机落地临时文件
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
| transfer | 上传、下载或在两台远端服务器之间 relay；支持碎文件并发、临时 tar 打包、可选压缩和分块预取 |
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
        "@aaarc/handfree-ssh-mcp",
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
    # 默认 commandMode: blacklist，只拦内置危险命令和 blacklist 命中的命令。
    blacklist:
      - "^docker system prune.*$"

  prod:
    host: prod.example.com
    username: deploy
    privateKey: ~/.ssh/id_ed25519
    commandMode: whitelist
    whitelist:
      - "^pwd$"
      - "^ls( .*)?$"
      - "^cat .*$"
    blacklist:
      - "^rm.*$"
```

然后在 MCP 配置中传入 YAML：

```json
{
  "mcpServers": {
    "handfree-ssh-mcp": {
      "command": "npx",
      "args": [
        "-y",
        "@aaarc/handfree-ssh-mcp",
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

### 📂 relay 分块预取

`transfer` 的 `mode: "relay"` 会以带偏移量的 SFTP 分块读写替代单路流式 pipe：目标端等待写入确认时，源端可提前下载后续分块。默认窗口是 `sftpConcurrency: 64`、`chunkSize: 32768`，应用层分块缓存至多约 2 MiB；可通过这两个参数调节，最大窗口为 64 MiB。文件仍只经过 MCP 进程内存，不写入本机临时文件，结束后继续做大小与可用时的 MD5 校验。

### 📦 tar-before-transfer 与碎文件并发

- `upload`、`download` 以及 `transfer` 的上传/下载模式现在默认启用 `fast`，即使用 ssh2 `fastPut` / `fastGet`；需要兼容路径时可显式设置 `fast: false`。
- 不使用 tar 的递归传输通过 `fileConcurrency` 并行处理独立文件，默认 4、最大 8。上限收紧是因为每个并发文件都会在同一 SSH 连接上打开各自的 SFTP channel，必须低于远端的 `MaxSessions`（OpenSSH 常见默认值为 10），否则会稳定触发 channel 打开失败。实现会先建立完整目录树，再并发传文件，主要用于降低大量碎文件的逐文件往返开销。
- 设置 `archive: true` 后，源文件或目录会先自动打包为临时 tar，只传输一个归档文件，到目标目录后自动解包并清理本机及远端临时归档。源 basename 保持不变，无需再设置 `recursive: true`。
- `archiveCompression` 可选 `none`（默认）、`gzip`、`bzip2`、`xz`、`zstd`。参与打包或解包的 MCP 宿主与远端服务器都必须具备对应的 `tar`/压缩支持。

## 🛡️ 安全注意事项

- **命令策略**：默认黑名单模式会拦截内置破坏性 guard、内置危险命令（如 `rm -rf`、`reboot`、`shutdown`、`dd ... of=`）和自定义 `blacklist`；需要更严格控制时设置 `commandMode: whitelist`
- **私钥安全**：确保运行此服务器的机器安全
- **速率限制**：考虑在防火墙后运行并启用速率限制
- **路径遍历**：内置保护，但请注意上传/下载路径

## 📄 许可证

ISC 许可证 - 基于 [ssh-mcp-server](https://github.com/classfang/ssh-mcp-server) by Junki

## 🙏 致谢

本项目是 [classfang/ssh-mcp-server](https://github.com/classfang/ssh-mcp-server) 的分支。感谢原作者提供的优秀基础！
