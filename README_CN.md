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
| download | 从远程服务器下载文件；支持 `connections` 多连接分段下载（见下方「多连接下载」） |
| transfer | 上传、下载或在两台远端服务器之间 relay；支持碎文件并发、批量上传（`localPath` 数组）、临时 tar 打包、可选压缩、分块预取，以及 relay 的 `strategy: "relay" \| "direct" \| "auto"`（源到目标直传，绕过本机） |
| list-servers | 列出所有可用的 SSH 服务器配置 |
| workspace-run | 在远端服务器启动一个入口程序，**无需任何 YAML 配置**（直接传 `remoteRoot` + `venv`/`executable`，也可用 `runProfiles.<name>` 预设）：`[push] → preflight → launching → remote-running → [collect]`。持久运行：所有状态都写在远端文件系统（不落本机），可扛住 SSH 断线与 MCP adapter 重启。详见下方"workspace-run（远程运行）" |
| run-status | 按 `runId` 查询 `workspace-run` 运行状态（每次都经 SFTP 读远端状态目录，无本机缓存） |
| run-logs | 按字节偏移读取运行的 stdout/stderr，跨多次调用正确处理被截断在窗口边界上的多字节 UTF-8 字符 |
| run-list | 列出某服务器上的运行记录，按时间倒序 |
| run-cancel | 取消一次运行：先向进程组发 TERM，等待 `graceMs` 后仍存活则发 KILL；信号前会重新核对进程身份 |
| run-retry | 用某次运行自己保存的（非秘密）配置快照重新发起一次新运行，而不是读当前实时配置；记录 `parentRunId` |

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

### 🔀 relay 的 `strategy`（两端直传）

`transfer mode=relay` 支持 `strategy: "relay" | "direct" | "auto"`。`"relay"`（默认）就是上面的分块预取行为，未做任何改动。`"direct"` 会**在源服务器上**执行拷贝（优先 `rsync`，否则 `tar` 通过 `ssh` 管道传输；不支持 `rclone`），使本机 MCP 进程完全不经手文件字节；当源服务器无法直连目标、目标主机指纹尚未在源服务器上被信任、非交互式 `existing-remote-key` 认证不可用，或源服务器上两种 backend 都不可用时，会给出明确失败原因。认证完全依赖源服务器自身已有的信任关系（其默认 SSH 身份 / `known_hosts`）——本工具不会读取、拼装或传输任何私钥，也绝不会传递 `StrictHostKeyChecking=no` 之类的自动信任参数。直传无法穿透 NAT：请确保源到目标可直连，或改用跳板机/overlay 网络，或退回 `strategy: "relay"`。`"auto"` 会带真实超时地探测上述条件（路由、主机指纹、backend 可用性、认证、目标路径策略），可行时使用直传，否则回退到 relay 并报告准确原因。

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

### 🔀 多连接下载（`connections`）

`download` 与 `transfer mode=download` 支持 `connections`（默认 `1`，上限 `8`）。为 `1` 时行为与之前完全一致。大于 `1` 时，文件被切分为相应数量的不重叠字节区间，**每个区间走一条独立的 SSH/TCP 连接**拉取，通过定位写直接写入本地预分配的 temp 文件，校验大小后原子 rename 到目标路径。任一连接失败都会取消其余连接、删除 temp 文件，且从不触碰最终目标路径。

关键在于是独立的**连接**，而不是更多的 SFTP channel：同一条 SSH 连接上的所有 channel 共享该连接的流控窗口（ssh2 把它写死为 2 MiB），所以多开 channel 换不来任何东西；多一条连接才多一个窗口。

该选项在**高延迟**链路上有效——单连接的吞吐大致被 窗口/RTT 限制；在低延迟局域网上没有意义。每条连接都是一次独立的 SSH 握手，且所有握手并发进行（总代价约等于一次握手，而不是 N 次），因此对端的相关限制是 sshd 的 `MaxStartups` 而非 `MaxSessions`——OpenSSH 默认的 `10:30:100` 在未认证连接达到 10 条时开始丢弃。

在真实 `tc netem` 环境下实测（50 ms / 1 Gbps，128 MiB 文件，3 次取 median，每次校验 SHA-256）：

| 设置 | 吞吐 |
|---|---|
| 默认单连接 | 17.54 MiB/s |
| `connections: 2` | 28.54 MiB/s |
| `connections: 4` | 45.71 MiB/s |
| `connections: 8` | 53.86 MiB/s |

以上数字只对那一条被整形的链路成立，实际收益取决于你自己链路的 RTT 与带宽。超过 `4` 之后收益递减。（2.1.4 之前的版本是一条接一条地建连，在那条链路上每条约 0.7 秒，导致 `8` 与单连接一样慢；数据通路本身从来不是瓶颈。）`connections` 仅适用于单个文件，对 relay 的 `strategy: "direct"`/`"auto"`、批量（数组）`localPath`、`recursive: true`、`archive: true` 均会被拒绝。

### 多连接上传

`upload` 与 `transfer mode=upload` 也接受同样的 `connections`（默认 `1`，上限 `8`）。大于 `1` 时，每个字节区间经各自独立的 SSH/TCP 连接写入目标旁边的**同一个远端临时文件**：只有第 0 条连接负责创建/截断，其余连接打开时不截断。所有区间成功、临时文件大小校验通过后，才替换 `remotePath`——对端声明 `posix-rename@openssh.com` 时（OpenSSH 均支持，已在真实 OpenSSH 上验证）是一次原子改名；否则先删除旧文件再改名，期间 `remotePath` 会短暂不存在。任一连接失败时，临时文件被删除，`remotePath` 保持原内容不变。跳过相同文件与 shell 脚本 CRLF→LF 修正照常生效。

在 50 ms RTT 下上传 128 MiB 文件的实测结果（每次都在容器内校验 SHA-256，且每次覆盖同一个远端路径）：

| 设置 | 吞吐 |
|---|---|
| 默认单连接（`fastPut`） | 29.84 MiB/s |
| `connections: 2` | 35.18 MiB/s |
| `connections: 4` | 43.48 MiB/s |
| `connections: 8` | 44.92 MiB/s |

收益小于下载。以上数字包含每次调用约 0.7 秒的建连时间，文件越大这部分占比越小。该实验环境只对服务端到客户端方向做了带宽整形，所以上传数字体现的是 50 ms RTT 的影响，没有 1 Gbps 上限。

### 多连接中转（relay）

`transfer mode=relay` 在默认的 `strategy: "relay"` 下也接受 `connections`。与 `"direct"`/`"auto"` 组合时会被拒绝，因为那两种是在源服务器上直接拷贝，没有字节区间可分。大于 `1` 时，文件被切成对应数量的字节区间，每个区间走各自的一**对**独立连接：一条连源服务器，一条连目标服务器，两段各自拥有自己的窗口。因此每台服务器上各有 `N` 条连接；源和目标是同一台服务器（self-relay）时总共只开 `N` 条，每条连接上同时开一个读通道和一个写通道。与单连接 relay「原地写入目标文件」不同：多连接时先写到目标旁边的临时文件，校验大小和 md5 通过后，才改名覆盖目标（与多连接上传的替换步骤相同）。任何一步失败，临时文件会被删除，目标保持原内容。

在两个实验容器之间中转 128 MiB 文件的实测结果（源 → MCP 主机这一段整形为 50 ms / 1 Gbps，每次都在目标容器内校验 SHA-256）：

| 设置 | 吞吐 |
|---|---|
| 默认单连接（窗口化 relay） | 16.36 MiB/s |
| `connections: 2` | 23.74 MiB/s |
| `connections: 4` | 33.64 MiB/s |
| `connections: 8` | 31.71 MiB/s |

那条链路上 `8` 并不比 `4` 快，用 `4` 即可。

### 🏃 workspace-run（远程运行）

**不需要任何 YAML 配置**：直接在调用里传 `remoteRoot` 加 `venv`（或 `executable`）即可，对任何已启用的服务器都能用——包括从 `~/.ssh/config` 读来的那些：

```json
{ "tool": "workspace-run", "params": {
  "server": "gpu-box", "remoteRoot": "/data/proj", "venv": "/data/envs/proj",
  "entrypoint": "train.py", "args": ["--epochs", "3"]
} }
```

内联方式下：`entrypoint` 可以是 `remoteRoot` 下任意安全相对路径（`..`、绝对路径、盘符路径仍一律拒绝），`env` 的 key 不受白名单限制，`push` 默认为 **false**（认为代码已经在 `remoteRoot` 上；要上传就传 `pushPaths`），collect 的本地落地目录用 `collectLocalDir` 指定。

YAML 里的 `runProfiles.<name>`（`server`、`remoteRoot`、`environment.type: venv|executable`、`allowedEntrypoints`、`env` 白名单等）是同一批字段的**可选预设**——重复跑同一个任务时更方便，也是唯一能把可运行范围**收紧**（`allowedEntrypoints`、`env` 白名单）的方式，但它不是前置条件。

远端 wrapper 用 `setsid` 使目标进程脱离本次 SSH 会话、拥有独立进程组，并把 `meta.json`/`stdout.log`/`stderr.log`/`pid`/`heartbeat`/`exit.json` 原子写入 `~/.handfree-runs/<runId>/`——**没有本机 JobStore、没有常驻 daemon**，MCP adapter 重启不会丢任何东西，因为它本来就没持有任何权威状态；代价是查询状态/日志/取消都需要能连上远端，没有离线缓存视图。

完整流水线为 `[push] → preflight → launching → remote-running → [collect]`：

```json
{ "tool": "workspace-run", "params": { "profile": "qwen-dev", "entrypoint": "train.py" } }
{ "tool": "run-status", "params": { "runId": "run_20260915T120000Z_ab12cd34" } }
{ "tool": "run-cancel", "params": { "runId": "run_20260915T120000Z_ab12cd34" } }
{ "tool": "run-retry", "params": { "runId": "run_20260915T120000Z_ab12cd34" } }
```

- **`push`**：启动前把声明的本地文件/目录上传到 `remoteRoot`（profile 用 `push.paths`，内联用 `pushPaths`），复用与 `upload`/`transfer` 相同的批量/递归上传逻辑，默认 skip-if-identical——未变化的文件不会重传。声明了 `push.paths` 的 profile 默认为 `true`（或看其 `defaultPush`），未传 `pushPaths` 的内联运行默认为 `false`。打开 push 却没有任何来源，会在触网前返回 `INVALID_CONFIGURATION`；传 `push: false` 可跳过并使用 `remoteRoot` 上已有的代码。push 失败绝不会进入 launching 阶段，错误信息会指明失败的文件/目录与所处阶段。push 完成（或跳过）后会对远端 entrypoint 做 stat + 内容哈希，连同一份已推送文件清单的摘要一起记为该次运行的 `revision`，事后可据此判断跑的到底是哪一版代码。
- **`collect`**（默认取 profile 的 `collect.paths`）：运行结束后按显式 glob（相对 `remoteRoot`）把产物拉回本地的 `runProfiles.<name>.collect.localDir`（内联则是 `collectLocalDir`）——**绝不会**默认拉取整个 `remoteRoot`。只要 `collect.paths`/调用参数非空，就必须给出本地落地目录。只要实际请求了 collect（无论来自 profile 默认值还是显式参数），`workspace-run` 调用就会**阻塞**（受 `timeout` 限制，默认取 profile 的 `timeout` 或 10 分钟）直到运行进入终态后再执行 collect；不请求 collect 的普通启动行为不变，进程确认起来后立即返回。有总字节上限和文件数上限（`collect.maxBytes`/`collect.maxFiles`），超限会让 collect 阶段失败并报告已经拉取的清单——绝不静默截断。即便运行失败或被取消，collect 默认仍会执行（日志与部分产物往往正是诊断材料）；collect 失败绝不会改写运行本身的 exit code，会在 `details.collect` 中单独呈现。传 `collect: []` 可对某次调用禁用 collect。glob 匹配会拒绝 `..`、绝对路径，且从不穿过符号链接。
- `sync: "flush"`（Phase 3 的常驻同步屏障，本轮未实现）：只支持 `"none"`/省略；`"flush"` 返回 `SYNC_NOT_AVAILABLE`。
- `environment.type: conda | module | slurm`、`gpu.required`、`secretEnv`：配置可以解析成功，但启动时会分别返回 `ENVIRONMENT_ADAPTER_NOT_AVAILABLE` / `GPU_VALIDATION_NOT_AVAILABLE` / `SECRET_ENV_NOT_AVAILABLE`。仅 `environment.type: venv`（直接调用 `<path>/bin/python`，不依赖 `source activate`）与 `executable` 可用。

`run-cancel` 会向整个远端进程组发 `TERM`，等待 `graceMs`（默认 5000ms）后仍存活再发 `KILL`；发信号前会重新核对远端 boot id、pid、pgid、`/proc` 启动 tick 以及从存活进程自身环境变量中读回的 wrapper token，任一不匹配（PID 复用、主机重启）都会转入 `orphaned` 而不是冒险向可能已被复用的 PID 发信号。

`run-retry` 会读取**某次运行自己保存的配置快照**（从其 `meta.json` 经 SFTP 读回），而不是当前实时的 `runProfiles` 配置——因此配置热重载或 profile 被删除都不会改变一次重试实际执行的内容。它会拿到全新的 `runId` 并记录 `parentRunId`；原来那次运行不受影响、仍可独立查询。对一次在本功能上线之前发起的运行调用 `run-retry` 会返回 `RETRY_SNAPSHOT_UNAVAILABLE`；若快照声明了 `secretEnv`（本轮无法重新解析）则返回 `SECRET_REQUIRED`。

## 🛡️ 安全注意事项

- **命令策略**：默认黑名单模式会拦截内置破坏性 guard、内置危险命令（如 `rm -rf`、`reboot`、`shutdown`、`dd ... of=`）和自定义 `blacklist`；需要更严格控制时设置 `commandMode: whitelist`
- **私钥安全**：确保运行此服务器的机器安全
- **速率限制**：考虑在防火墙后运行并启用速率限制
- **路径遍历**：内置保护，但请注意上传/下载路径

## 📄 许可证

ISC 许可证 - 基于 [ssh-mcp-server](https://github.com/classfang/ssh-mcp-server) by Junki

## 🙏 致谢

本项目是 [classfang/ssh-mcp-server](https://github.com/classfang/ssh-mcp-server) 的分支。感谢原作者提供的优秀基础！
