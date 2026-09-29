[← 返回 README](../../README_CN.md)

# 文件传输

## relay 分块预取

`transfer` 的 `mode: "relay"` 会以带偏移量的 SFTP 分块读写替代单路流式 pipe：目标端等待写入确认时，源端可提前下载后续分块。默认窗口是 `sftpConcurrency: 64`、`chunkSize: 32768`，应用层分块缓存至多约 2 MiB；可通过这两个参数调节，最大窗口为 64 MiB。文件仍只经过 MCP 进程内存，不写入本机临时文件，结束后继续做大小与可用时的 MD5 校验。

## relay 的 `strategy`（两端直传）

`transfer mode=relay` 支持 `strategy: "relay" | "direct" | "auto"`。`"relay"`（默认）就是上面的分块预取行为，未做任何改动。`"direct"` 会**在源服务器上**执行拷贝（优先 `rsync`，否则 `tar` 通过 `ssh` 管道传输；不支持 `rclone`），使本机 MCP 进程完全不经手文件字节；当源服务器无法直连目标、目标主机指纹尚未在源服务器上被信任、非交互式 `existing-remote-key` 认证不可用，或源服务器上两种 backend 都不可用时，会给出明确失败原因。认证完全依赖源服务器自身已有的信任关系（其默认 SSH 身份 / `known_hosts`）——本工具不会读取、拼装或传输任何私钥，也绝不会传递 `StrictHostKeyChecking=no` 之类的自动信任参数。直传无法穿透 NAT：请确保源到目标可直连，或改用跳板机/overlay 网络，或退回 `strategy: "relay"`。`"auto"` 会带真实超时地探测上述条件（路由、主机指纹、backend 可用性、认证、目标路径策略），可行时使用直传，否则回退到 relay 并报告准确原因。

## tar-before-transfer 与碎文件并发

- `upload`、`download` 以及 `transfer` 的上传/下载模式现在默认启用 `fast`，即使用 ssh2 `fastPut` / `fastGet`；需要兼容路径时可显式设置 `fast: false`。
- 不使用 tar 的递归传输通过 `fileConcurrency` 并行处理独立文件，默认 4、最大 8。上限收紧是因为每个并发文件都会在同一 SSH 连接上打开各自的 SFTP channel，必须低于远端的 `MaxSessions`（OpenSSH 常见默认值为 10），否则会稳定触发 channel 打开失败。实现会先建立完整目录树，再并发传文件，主要用于降低大量碎文件的逐文件往返开销。
- 设置 `archive: true` 后，源文件或目录会先自动打包为临时 tar，只传输一个归档文件，到目标目录后自动解包并清理本机及远端临时归档。源 basename 保持不变，无需再设置 `recursive: true`。
- `archiveCompression` 可选 `none`（默认）、`gzip`、`bzip2`、`xz`、`zstd`。参与打包或解包的 MCP 宿主与远端服务器都必须具备对应的 `tar`/压缩支持。

## 批量上传（`localPath` 传数组）

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

## 多连接下载（`connections`）

`download` 与 `transfer mode=download` 支持 `connections`（默认 `1`，上限 `8`）。为 `1` 时行为与之前完全一致。大于 `1` 时，文件被切分为相应数量的不重叠字节区间，**每个区间走一条独立的 SSH/TCP 连接**拉取，通过定位写直接写入本地预分配的 temp 文件，校验大小后原子 rename 到目标路径。任一连接失败都会取消其余连接、删除 temp 文件，且从不触碰最终目标路径。

关键在于是独立的**连接**，而不是更多的 SFTP channel：同一条 SSH 连接上的所有 channel 共享该连接的流控窗口（ssh2 把它写死为 2 MiB），所以多开 channel 换不来任何东西；多一条连接才多一个窗口。

该选项在**高延迟**链路上有效——单连接的吞吐大致被 窗口/RTT 限制；在低延迟局域网上没有意义。每条连接都是一次独立的 SSH 握手，且所有握手并发进行（总代价约等于一次握手，而不是 N 次），因此对端的相关限制是 sshd 的 `MaxStartups` 而非 `MaxSessions`——OpenSSH 默认的 `10:30:100` 在未认证连接达到 10 条时开始丢弃。

这些连接**按服务器池化**：传输成功后连接被放回池中，同一服务器上的下一次多连接下载、上传或中转直接复用，不再握手。每台服务器最多 8 条——需要的连接数超过空闲数时会排队等待；中转按固定顺序占用两端的名额，因此两个方向相反的中转不会互相死锁。空闲连接 60 秒后关闭，`close-connection` 会立即关闭它们。失败的传输会关闭其连接而不是放回池中；池中已失效的连接会被透明替换。`reuseConnection=false` 绕过连接池：使用全新连接，用完即关。

在真实 `tc netem` 环境下实测（50 ms / 1 Gbps，128 MiB 文件，3 次取 median，每次校验 SHA-256）：

| 设置 | 吞吐 |
|---|---|
| 默认单连接 | 17.54 MiB/s |
| `connections: 2` | 28.54 MiB/s |
| `connections: 4` | 45.71 MiB/s |
| `connections: 8` | 53.86 MiB/s |

上表是**首次调用**，所有握手都计入耗时。同一服务器上的重复调用复用池中的连接、跳过握手：同一实验环境中重复调用实测 `2` 为 35.2 MiB/s、`4` 为 63.2、`8` 为 82.8（同一轮中 4 连接首次调用为 45.6；约 0.8 秒的差距就是一轮并发握手）。

以上数字只对那一条被整形的链路成立，实际收益取决于你自己链路的 RTT 与带宽。超过 `4` 之后收益递减。（2.1.4 之前的版本是一条接一条地建连，在那条链路上每条约 0.7 秒，导致 `8` 与单连接一样慢；数据通路本身从来不是瓶颈。）`connections` 仅适用于单个文件，对 relay 的 `strategy: "direct"`/`"auto"`、批量（数组）`localPath`、`recursive: true`、`archive: true` 均会被拒绝。

## 多连接上传

`upload` 与 `transfer mode=upload` 也接受同样的 `connections`（默认 `1`，上限 `8`）。大于 `1` 时，每个字节区间经各自独立的 SSH/TCP 连接写入目标旁边的**同一个远端临时文件**：只有第 0 条连接负责创建/截断，其余连接打开时不截断。所有区间成功、临时文件大小校验通过后，才替换 `remotePath`——对端声明 `posix-rename@openssh.com` 时（OpenSSH 均支持，已在真实 OpenSSH 上验证）是一次原子改名；否则先删除旧文件再改名，期间 `remotePath` 会短暂不存在。任一连接失败时，临时文件被删除，`remotePath` 保持原内容不变。跳过相同文件与 shell 脚本 CRLF→LF 修正照常生效。

在 50 ms RTT 下上传 128 MiB 文件的实测结果（每次都在容器内校验 SHA-256，且每次覆盖同一个远端路径）：

| 设置 | 吞吐 |
|---|---|
| 默认单连接（`fastPut`） | 29.84 MiB/s |
| `connections: 2` | 35.18 MiB/s |
| `connections: 4` | 43.48 MiB/s |
| `connections: 8` | 44.92 MiB/s |

收益小于下载。以上数字包含每次调用约 0.7 秒的建连时间。有了连接池，重复上传会跳过这部分：`2` 为 38.9 MiB/s、`4` 为 53.9、`8` 为 52.7，单连接为 29.1。该实验环境只对服务端到客户端方向做了带宽整形，所以上传数字体现的是 50 ms RTT 的影响，没有 1 Gbps 上限。

## 多连接中转（relay）

`transfer mode=relay` 在默认的 `strategy: "relay"` 下也接受 `connections`。与 `"direct"`/`"auto"` 组合时会被拒绝，因为那两种是在源服务器上直接拷贝，没有字节区间可分。大于 `1` 时，文件被切成对应数量的字节区间，每个区间走各自的一**对**独立连接：一条连源服务器，一条连目标服务器，两段各自拥有自己的窗口。因此每台服务器上各有 `N` 条连接；源和目标是同一台服务器（self-relay）时总共只开 `N` 条，每条连接上同时开一个读通道和一个写通道。与单连接 relay「原地写入目标文件」不同：多连接时先写到目标旁边的临时文件，校验大小和 md5 通过后，才改名覆盖目标（与多连接上传的替换步骤相同）。任何一步失败，临时文件会被删除，目标保持原内容。

在两个实验容器之间中转 128 MiB 文件的实测结果（源 → MCP 主机这一段整形为 50 ms / 1 Gbps，每次都在目标容器内校验 SHA-256）：

| 设置 | 吞吐 |
|---|---|
| 默认单连接（窗口化 relay） | 16.36 MiB/s |
| `connections: 2` | 23.74 MiB/s |
| `connections: 4` | 33.64 MiB/s |
| `connections: 8` | 31.71 MiB/s |

那条链路上 `8` 并不比 `4` 快，用 `4` 即可。复用池中连接的重复中转实测：`2` 为 26.6 MiB/s、`4` 为 37.3、`8` 为 37.0。
