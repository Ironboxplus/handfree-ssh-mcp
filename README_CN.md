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
| upload | 上传本地文件到远程服务器；`localPath` 也可传数组以批量上传多个文件到同一个远程目录（见下方"批量上传"） |
| download | 从远程服务器下载文件；支持 `striped` 多通道分片下载（见下方"多通道分片下载"） |
| transfer | 上传、下载或在两台远端服务器之间 relay；支持碎文件并发、批量上传（`localPath` 数组）、临时 tar 打包、可选压缩、多通道分片下载和分块预取 |
| list-servers | 列出所有可用的 SSH 服务器配置 |
| workspace-run | 在配置好的 `runProfiles.<name>` 下，于远端服务器启动一个入口程序，持久运行：所有状态都写在远端文件系统（不落本机），可扛住 SSH 断线与 MCP adapter 重启。**本轮交付只实现 launch 阶段**（见下方"workspace-run（远程运行，仅 launch 阶段）"） |
| run-status | 按 `runId` 查询 `workspace-run` 运行状态（每次都经 SFTP 读远端状态目录，无本机缓存） |
| run-logs | 按字节偏移读取运行的 stdout/stderr，跨多次调用正确处理被截断在窗口边界上的多字节 UTF-8 字符 |
| run-list | 列出某服务器上的运行记录，按时间倒序 |
| run-cancel | 取消一次运行：先向进程组发 TERM，等待 `graceMs` 后仍存活则发 KILL；信号前会重新核对进程身份 |

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

### 📦 批量上传（`localPath` 传数组）

`upload` 与 `transfer mode=upload` 的 `localPath` 除了单个字符串外，也接受字符串数组，用于一次调用批量上传多个独立文件：

- 传字符串时行为与之前完全一致（纯文本响应），无任何可观察差异。
- 传数组时，`remotePath` 必须是目录，每个源文件落到 `remotePath/<basename>`。
- **basename 冲突在任何远端写入之前硬失败**：例如 `["a/config.yaml", "b/config.yaml"]` 会撞同一目标，返回 `BATCH_TARGET_COLLISION` 并列出冲突项；数组内重复路径同样报错，不会被静默去重。
- 数组长度上限 1000（超出返回 `BATCH_TOO_LARGE`），空数组返回 `INVALID_CONFIGURATION`。
- 并发复用与递归传输相同的 `fileConcurrency`（默认 4，上限 8）。
- `onError` 控制失败处理：默认 `"abort"`——一旦某个文件失败就停止调度新文件，等待已在传输中的文件完成；`"continue"` 则无视之前的失败继续尝试每个文件。两种模式都会返回每个文件的 `uploaded` / `skipped` / `failed` 状态及失败原因。
- 每个文件仍然复用现有单文件上传逻辑：skip-if-identical、`.sh`/`.bash`/`.zsh` 的 CRLF 修正、`fast`、路径策略校验全部自动继承，不重新实现。
- 数组入参返回结构化 JSON（`{ results, total, uploadedCount, skippedCount, failedCount, crlfFixedCount }`），而不是单文件时的纯文本结果。
- 本轮 `archive: true` 不支持与数组 `localPath` 同时使用；`download`/`relay` 暂不支持数组形式的 `localPath`。

### 🧵 多通道分片下载（`striped`）

`download` 与 `transfer mode=download` 支持 `striped: true`（默认 `false`，不开启时单文件下载行为与之前完全一致）：将同一个远程文件切分为 `stripeCount`（默认 4，上限 8，与 `fileConcurrency` 相同的 OpenSSH `MaxSessions` 余量考量）个不重叠的字节区间，每个区间各自使用独立的 SFTP channel 并发拉取，通过定位写（positional write）直接写入本地预分配的 temp 文件，各区间完成顺序互不影响。`chunkSize`（默认 262144 字节）限制单个区间一次读入内存的字节数，`maxBufferBytes`（默认 64 MiB）硬性限制 `stripeCount * chunkSize`，即任意时刻 MCP 进程内存中缓冲的数据总量上限——大文件不会被整个装入内存。全部区间写完后先校验本地 temp 文件大小（远端暴露 `md5sum` 时还会尽力校验 MD5），通过后才原子 rename 到目标路径；任一分片失败或校验失败都会删除 temp 文件，从不触碰最终目标路径。同时设置 `fast` 时 `striped` 优先生效。该开关只改变字节的搬运方式，不改变工具的返回内容。

### 🏃 workspace-run（远程运行，仅 launch 阶段）

在 YAML 中声明 `runProfiles.<name>`（`server`、`remoteRoot`、`environment.type: venv|executable`、`allowedEntrypoints`、`env` 白名单等）后即可用 `workspace-run` 启动。远端 wrapper 用 `setsid` 使目标进程脱离本次 SSH 会话、拥有独立进程组，并把 `meta.json`/`stdout.log`/`stderr.log`/`pid`/`heartbeat`/`exit.json` 原子写入 `~/.handfree-runs/<runId>/`——**没有本机 JobStore、没有常驻 daemon**，MCP adapter 重启不会丢任何东西，因为它本来就没持有任何权威状态；代价是查询状态/日志/取消都需要能连上远端，没有离线缓存视图。

```json
{ "tool": "workspace-run", "params": { "profile": "qwen-dev", "entrypoint": "train.py", "push": false } }
{ "tool": "run-status", "params": { "runId": "run_20260915T120000Z_ab12cd34" } }
{ "tool": "run-cancel", "params": { "runId": "run_20260915T120000Z_ab12cd34" } }
```

**本轮明确未实现**（均返回明确的 `*_NOT_AVAILABLE` 错误，不会被静默忽略）：

- `push`（预推送阶段，P2-02）：必须显式传 `false`，代码需已存在于 `remoteRoot`；省略（默认 true）或传 `true` 返回 `PUSH_NOT_AVAILABLE`。
- `collect`（跑完拉回产物，P2-06）：必须为空/省略，请改用 `download`/`transfer`；非空数组返回 `COLLECT_NOT_AVAILABLE`。
- `sync: "flush"`（Phase 3 的常驻同步屏障）：只支持 `"none"`/省略；`"flush"` 返回 `SYNC_NOT_AVAILABLE`。
- `run-retry`：本轮完全未实现。
- `environment.type: conda | module | slurm`、`gpu.required`、`secretEnv`：配置可以解析成功，但启动时会分别返回 `ENVIRONMENT_ADAPTER_NOT_AVAILABLE` / `GPU_VALIDATION_NOT_AVAILABLE` / `SECRET_ENV_NOT_AVAILABLE`。仅 `environment.type: venv`（直接调用 `<path>/bin/python`，不依赖 `source activate`）与 `executable` 可用。

`run-cancel` 会向整个远端进程组发 `TERM`，等待 `graceMs`（默认 5000ms）后仍存活再发 `KILL`；发信号前会重新核对远端 boot id、pid、pgid、`/proc` 启动 tick 以及从存活进程自身环境变量中读回的 wrapper token，任一不匹配（PID 复用、主机重启）都会转入 `orphaned` 而不是冒险向可能已被复用的 PID 发信号。

## 🛡️ 安全注意事项

- **命令策略**：默认黑名单模式会拦截内置破坏性 guard、内置危险命令（如 `rm -rf`、`reboot`、`shutdown`、`dd ... of=`）和自定义 `blacklist`；需要更严格控制时设置 `commandMode: whitelist`
- **私钥安全**：确保运行此服务器的机器安全
- **速率限制**：考虑在防火墙后运行并启用速率限制
- **路径遍历**：内置保护，但请注意上传/下载路径

## 📄 许可证

ISC 许可证 - 基于 [ssh-mcp-server](https://github.com/classfang/ssh-mcp-server) by Junki

## 🙏 致谢

本项目是 [classfang/ssh-mcp-server](https://github.com/classfang/ssh-mcp-server) 的分支。感谢原作者提供的优秀基础！
