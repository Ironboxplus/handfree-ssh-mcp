# handfree-ssh-mcp v2 可执行开发计划

> 状态：Draft / implementation-ready  
> 制定日期：2026-09-14  
> 修订：2026-09-14（Rev.2）— 阶段顺序调整为「传输加速 → 远程运行 → 三模式同步 → WebUI」；同步范围由单向 push 扩展为 `push / pull / bidirectional` 三模式  
> 修订：2026-09-14（Rev.3）— **本轮交付范围收窄为 Phase 0 / 1 / 2**；Phase 3（三模式同步）与 Phase 4（WebUI）暂缓，设计保留不删。新增 `transfer` 批量上传、`workspace-run` 的 `push`/`collect` phase 流水线。测试政策收紧为全真实执行、禁止 mock。  
> 当前代码基线：`main@66ffc04`，工作树包含尚未提交的 v1.0.19 transfer/archive/fast/TDD 变更  
> 目标版本：`2.0.0`（现有 1.x MCP tool 与服务器配置尽量向后兼容）

## 0. 本轮交付范围（Rev.3）

| 阶段 | 状态 | 说明 |
|---|---|---|
| Phase 0 | **本轮交付** | preflight、基线修复、SSH lab、契约、模块化、JobStore/EventBus、Controller daemon |
| Phase 1 | **本轮交付** | TransferMetrics、路径身份基座、批量上传、checker/walker、striped、multi-channel relay、external engine、direct planner |
| Phase 2 | **本轮交付** | workspace-run：`push` → preflight → launching → remote-running → `collect` |
| Phase 3 | 暂缓 | 三模式同步。设计（§5.6 决策表、schema、任务）全部保留，不在本轮实施 |
| Phase 4 | 暂缓 | WebUI + Streamable HTTP MCP。设计保留，不在本轮实施 |
| Phase 5 | 部分 | 本轮只做文档/打包/发布门中适用于已交付功能的部分 |

暂缓不等于删除：Phase 3/4 的契约位（`sync=flush`、sync tools 名称、HTTP 路由）在 Phase 0 契约中**保留占位并明确返回未实现错误**，避免将来回填时推翻既有 schema。本轮任何任务都不得因为「同步以后会做」而留下半成品代码路径。

## 1. 计划目的

本计划把以下五项需求落实为可以按顺序执行、测试和验收的开发任务。列出顺序即实施优先级：

1. 传输优化：补齐性能观测、并行目录检查、多连接单文件分片、direct/relay 自动选择和真实 WAN 条件基准。
2. 远程环境运行代码：使用远端 venv/conda/module/Slurm/GPU 环境启动任务，并提供持久状态、日志与取消能力。
3. 三模式文件同步：基于真实系统文件 watcher 和周期远端扫描，经持久 SSH/SFTP 会话在 `push`、`pull`、`bidirectional` 三种方向下自动同步；并回填远程运行的同步屏障。
4. WebUI：使用 React、TypeScript、Vite、shadcn/ui 和 Tailwind CSS 展示并控制服务器、同步、运行和传输任务。
5. 两台远端机器直传：在网络、认证和 host-key 条件满足时让源端直接向目标端传输；不满足时可解释地回退本机 relay。（随需求 1 一并在 Phase 1 实施）

本计划不是功能愿望列表。每个阶段均包含依赖、产物、TDD 顺序、真实执行测试、验收命令、完成定义和回滚点。后续实施必须按任务 ID 更新勾选状态和证据，不得仅凭代码存在宣称完成。

### 1.1 Rev.2 顺序调整说明

原计划顺序为「同步 → 运行 → 传输加速 → WebUI」。Rev.2 改为「传输加速 → 运行 → 三模式同步 → WebUI」，理由与代价：

- `TransferMetrics` 原属 Phase 1，却是全部传输性能数值门的前置证据来源，必须与传输加速同阶段。Rev.2 将其移为 P1-01。
- 远程运行对同步的唯一硬依赖是 sync barrier。`sync=none` 路径无需同步引擎即可完整实现，因此运行可先于同步落地；barrier 作为 P3-07 回填。
- 同步引擎是全计划风险最高的部分（误删、冲突、双向收敛）。把它放在传输与运行之后，可以复用已经过真实验收的 transfer engine、job store 和 metrics，而不是同时调试两套新机制。
- 代价：远程运行在 Phase 2 期间只能使用显式预传输而非自动屏障；这一限制必须在 tool 描述、help 和 README 中明示，不得让调用方误以为代码已自动同步。

## 2. 已验证基线与设计依据

### 2.1 当前 sshmcp 基线

- [ ] 实施开始前重新记录 `git status --short`、当前 commit、Node/npm 版本；禁止覆盖或清理用户现有未提交变更。
- [ ] 将当前 v1.0.19 transfer/archive/fast 变更形成可恢复检查点。提交、建分支或 stash 均需由用户明确授权；不得使用 `git reset --hard` 或 `git checkout --`。
- [x] 当前 `SSHConnectionManager` 已缓存 SSH client、去重并发连接、默认 keepalive，并支持 jump host。
- [x] 当前 MCP 仅使用 stdio transport；MCP 子进程退出后，SSH client、后台任务 Map 和 watcher 生命周期随之结束。
- [x] 当前配置文件已有 `fs.watch` 热重载，但没有项目目录同步 watcher。
- [x] 当前 `fast=true` 已是 upload/download 默认值；其含义是单 SFTP channel 内的 `fastPut`/`fastGet` 并发请求，不是多 SSH 连接分片。
- [x] 当前 relay 已实现有界 positional read/write 窗口，默认 `64 × 32 KiB`，但源端和目标端仍各只有一个 SFTP channel。
- [x] 当前递归 upload/download 有 `fileConcurrency`，但目录发现、metadata checker、远端 mkdir 仍有串行路径。
- [x] 当前 archive 支持 `none/gzip/bzip2/xz/zstd`，适合首次或批量传输，不适合作为每次文件变化的增量同步方式。
- [x] 2026-09-12 基线测试：`npm test` 为 324/324 通过；真实 transfer acceptance 为 9/9 通过。
- [ ] **基线回归（2026-09-14 复测）**：Windows 宿主上 `npm test` 为 319/324，`transfer-real.test.ts` 9 个用例失败 5 个。根因为本机 `tar` 把 `E:\`/`C:\` 盘符路径解析为远程 host spec（`archiveCreateArgs`/`archiveExtractArgs` 直接传绝对路径给 `-cf` 与 `-C`）。此失败必须在 P0-01 之前修复或正式归因，不得计入任何新功能的 RED 证据。
- [x] 当前 transfer coverage：`transfer.js` 行 87.88%、分支 82.14%、函数 100%；巨大 manager 行 44.16%、函数 59.75%。

### 2.2 对照源码快照

对照仓库已用 `gh repo clone --depth 1 --filter=blob:none` 获取并完成 Retrieval MCP 索引。它们只作为调研和行为参照，不作为构建输入：

| 项目 | Commit | 本地调研路径 | 许可证 | 采用边界 |
|---|---|---|---|---|
| Syncthing | `2ca95cf1498104113fdfde46df4107f2450a0f71` | `C:\Users\Arc\AppData\Local\Temp\sshmcp-research-20260912\syncthing` | MPL-2.0 | 借鉴 watcher、索引、临时文件、冲突和恢复思想；未经许可证审查不得复制实现文件 |
| rclone | `c3ba184611c3356acef327c5a42d530564f68466` | `C:\Users\Arc\AppData\Local\Temp\sshmcp-research-20260912\rclone` | MIT | 借鉴 checker/transfer 分层、连接池、WriterAt、多连接 SFTP 和 accounting |

关键设计依据：

- Syncthing：watcher 事件先聚合；事件溢出或 watcher 错误时转完整扫描；即使 watcher 正常也保留周期性 reconciliation；写入临时文件、校验后原子替换；双向更新使用版本和冲突模型。
- rclone：分别控制目录 checker、文件 transfer、单文件 stream、SFTP outstanding requests 和连接池；多连接 SFTP upload 先创建/截断/预分配一次，再用不同连接对不重叠 offset 执行 `WriteAt`。
- ssh2 1.16.0：默认 `fastXfer` 为 64 个 32 KiB 请求；单 channel 的 `MAX_WINDOW` 为 2 MiB、packet 为 32 KiB。增加单 channel request 数量不能自动突破 channel window。
- 双向同步的对端差异：Syncthing 两端都有常驻 agent，可以互推变更事件。本项目远端只有标准 sshd，没有 agent，因此远端变更只能靠周期扫描发现。这是 `bidirectional`/`pull` 的固有延迟来源，必须在文档中明示，不能用「实时双向」描述。

### 2.3 Rev.3 未提交改动代码审查发现（2026-09-14）

对工作树中未提交的 v1.0.19 变更（`ssh-connection-manager.ts` +949 行、三个 tool、两个新测试文件）逐块审查的结论。这些不是「待保护的既有成果」，而是**未完成的工作**，必须在 P0-01 收尾。

| 编号 | 性质 | 位置 | 结论 |
|---|---|---|---|
| F1 | **确认缺陷** | `ssh-connection-manager.ts:4813` `runLocalTar`；`tests/helpers/real-ssh-server.ts:361` | `spawn("tar", args)` 收到 `E:\...` 盘符路径，GNU tar 按 `host:path` 解析并以 exit 128 失败。这是 §2.1 记录的 5 个红测试的**唯一**根因，与任何新功能无关。修法为仅在 `win32` 注入 `--force-local`；共享的 `archiveCreateArgs`/`archiveExtractArgs` 不得加该 flag，否则会发给真实 Linux 远端。 |
| F2 | 健壮性 | `ssh-connection-manager.ts:1528` | `for (let i = 0; i < workersRemaining; i++)` 的循环上界正是 worker 会递减的变量。当前无活跃 bug（worker 必在首个 `await` 前挂起），但该不变量仅因「恰好不会同步 break」而成立。须把 count 捕获为 const。 |
| F3 | 真实限制未处理 | `ssh-connection-manager.ts:1206` | `MAX_RECURSIVE_FILE_CONCURRENCY = 32`，而每个并发 worker 各开一条 SFTP channel，OpenSSH 默认 `MaxSessions 10`。设到 32 必然 channel open failure。Rev.3 决定：**先降到 8** 并在 help/README 说明受远端 `MaxSessions` 约束；真正的 per-server channel budget 是 P1-03 的范围，不在本次收尾中提前实现。 |
| F4 | 设计问题 | `ssh-connection-manager.ts:4772` | `createLocalArchiveWorkspace` 在 `process.cwd()` 下建临时归档目录。MCP server 的 cwd 不确定，会污染用户项目目录，且大归档受 cwd 所在卷容量限制。改用 `os.tmpdir()`，并确保不因此削弱 `validateLocalPath` 的用户面路径策略。 |
| F5 | 已知未完成，记账 | `ssh-connection-manager.ts` `downloadDirectory` 的 `collect` | 目录枚举仍是深度优先串行 `await listRemoteDir`，并发只存在于文件传输阶段。README 现有措辞「递归小文件并发」因此偏乐观。并行 walker 属 **P1-03** 范围，本次不修，但 README 措辞需在 P1-03 前保持准确。 |

约束：F1–F4 的收尾必须遵守 7.2 / 7.2.1（全真实执行、禁止 mock、三盒齐备）；F1 的 RED 已天然存在（5 个真实失败的测试），不得为其编造额外的假 RED。

## 3. 范围、非目标与兼容性

### 3.1 v2 首批范围

- 一个独立于 MCP stdio 生命周期的本地 Controller daemon。
- 内建 SFTP engine 的可观测性、目录并发和 capability-gated 多连接分片。
- 远端 A 到远端 B 的 `auto/direct/relay` 策略。
- 可选调用已经安装的 `rsync` 或 `rclone`；不得自动下载安装二进制。
- 远端运行任务，支持 venv、显式 executable、环境变量、GPU 约束、持久日志、状态恢复和取消。
- 三模式目录同步：`push`（本地→远端）、`pull`（远端→本地）、`bidirectional`（双向，带三态比较与冲突处理），支持 watch、暂停、恢复、flush、rescan、状态查询和双侧安全删除策略。
- 同步落地后回填运行任务的同步屏障。
- 本机 loopback WebUI，实时显示 Controller 事件并调用同一底层 service。
- 真实文件、真实 SSH、真实 SFTP、真实 shell、真实 venv、真实浏览器测试。

### 3.2 明确非目标

- v2.0.0 的 `bidirectional` 仅覆盖「一个本地 root ↔ 一个远端 root」两端场景，使用三态比较（base/local/remote）；不实现 N 设备版本向量、设备发现、NAT 穿透和全球 relay 网络。
- v2.0.0 不在远端安装常驻 agent，因此远端变更发现依赖周期扫描而非事件推送。
- v2.0.0 不自动安装 Python、CUDA、venv、conda、rsync、rclone、tar 或远端 agent。
- v2.0.0 不把私钥复制到另一台服务器。
- v2.0.0 不默认开启 SSH agent forwarding。
- v2.0.0 不默认删除任何一侧的多余文件；`pull` 与 `bidirectional` 可能删除本地文件，必须与远端删除同等受保护。
- v2.0.0 不默认把 WebUI 绑定到 `0.0.0.0`/公网。
- v2.0.0 不以 tar 作为 watcher 每次变化的同步算法。
- v2.0.0 不把 localhost 或内存 fake transport 的速度作为 WAN 性能结论。
- 不将 Syncthing MPL-2.0 源文件直接拷入当前 ISC 项目。

### 3.3 向后兼容要求

- 现有 `execute-command`、`command-status`、`upload`、`download`、`transfer`、`list-servers`、`show-whitelist`、`close-connection`、`help` tool 名称继续存在。
- 现有 OpenSSH config、YAML `servers`、`--enable-servers`、`--pre-connect` 和 stdio 启动方式继续可用。
- `transfer` 现有参数语义不变；新策略参数必须有安全默认值。
- 当前命令 whitelist/blacklist、SFTP local/remote path policy 必须覆盖 WebUI、sync、run 和 direct backend，不能出现旁路。
- 旧配置不包含 `daemon/syncProfiles/runProfiles/web` 时默认使用 `daemonMode: embedded`，进程生命周期等价于当前 1.x；显式启用任一常驻新功能时默认推导为 `daemonMode: auto`。用户显式配置的 mode 始终优先。
- Node 运行时升级属于 v2 breaking change。目标最低版本定为 Node `>=24.15.0`，以使用 `node:sqlite`；发布说明必须明确这一点，并保留 1.x 给旧 Node 用户。
- “向后兼容”只承诺旧 tool/config 的功能与响应兼容；Node 最低版本、显式启用 daemon 后的生命周期和新增 state directory 属于已声明的 v2 变化。

## 4. 目标架构

```text
MCP clients                         Browser
    │ stdio                            │ HTTP + WS/SSE
    ▼                                  ▼
MCP adapter ───── local IPC ───── Controller daemon
                                      │
             ┌────────────────────────┼─────────────────────────┐
             ▼                        ▼                         ▼
      SshConnectionPool          PersistentJobStore         EventBus
             │                        │                         │
       ┌─────┼─────┐          ┌───────┼────────┐                │
       ▼     ▼     ▼          ▼       ▼        ▼                │
    Command SFTP  Direct   Transfer  Sync   WorkspaceRun         │
       │     │     │          │       │        │                 │
       └─────┴─────┴──────────┴───────┴────────┴─────────────────┘
```

### 4.1 模块边界

计划中的目录结构：

```text
src/
  cli/
    main.ts
    daemon-command.ts
    mcp-command.ts
  controller/
    controller.ts
    lifecycle.ts
    ipc-server.ts
    ipc-client.ts
  connection/
    ssh-connection-pool.ts
    ssh-client-factory.ts
    sftp-session-pool.ts
    capabilities.ts
  jobs/
    job-types.ts
    job-store.ts
    sqlite-job-store.ts
    event-bus.ts
  fspath/
    path-identity.ts            # lstat + realpath + ancestor containment
    case-sensitivity-probe.ts
    ignore-matcher.ts
  transfer/
    transfer-service.ts
    transfer-planner.ts
    transfer-metrics.ts
    builtin-sftp-engine.ts
    striped-sftp-engine.ts
    relay-engine.ts
    direct-engine.ts
    external-engine.ts
  run/
    workspace-run-service.ts
    run-profile.ts
    remote-runner.ts
    environment-resolver.ts
    run-wrapper.ts
  sync/
    sync-service.ts
    sync-profile.ts
    watcher.ts
    event-aggregator.ts
    manifest-store.ts
    local-scanner.ts
    remote-scanner.ts
    mode-planner.ts             # push / pull / bidirectional 决策表
    conflict-resolver.ts
    reconciler.ts
  http/
    http-server.ts
    auth.ts
    api/
  tools/
    execute-command.ts
    command-status.ts
    upload.ts
    download.ts
    transfer.ts
    list-servers.ts
    show-whitelist.ts
    close-connection.ts
    help.ts
    workspace-run.ts
    run-*.ts
    transfer-status.ts
    transfer-cancel.ts
    sync-*.ts
  services/
    ssh-connection-manager.ts   # 逐阶段缩减，最终成为兼容 facade 或删除
web/
  src/
  package.json
  vite.config.ts
tests/
  acceptance/
  e2e/
  performance/
  fixtures/ssh-lab/
```

`fspath/` 独立于 `sync/`，因为传输分片 temp 文件、运行 entrypoint 校验和同步扫描都需要同一套路径身份校验；它在 Phase 1 建立，后续阶段直接复用，不允许各自再写一份。

### 4.2 Controller 生命周期

- daemon 是 SSH 连接、watcher、job、WebUI 和持久状态的唯一所有者。
- MCP adapter 不持有独立 SSH client；它通过本地 IPC 调 Controller。
- Windows 使用带当前用户 ACL 的 Named Pipe；Unix 使用权限 `0600` 的 Unix Domain Socket。
- 将三个身份概念严格分开：`instanceId` 是稳定 daemon/state namespace；`configRevision` 是每次内容变更的 revision；`policyFingerprint` 是当前权限策略摘要。
- `instanceId = SHA-256(explicit instanceName + canonical config source paths + enabledServers + stateDir identity)`；不含配置内容、policy 或 secret。文件路径和 pipe/socket 使用至少前 32 个十六进制字符（128 bit），hello 再校验完整 256 bit。同一用户、同一 `instanceId` 只允许一个 daemon，不同实例可以并存。
- daemon 是配置 owner。adapter 负责解析 CLI 以定位 config source，但必须把规范化 config fingerprint 交给 daemon；`--config`、`--ssh-config`、`--no-ssh-config`、`--enable-servers` 都属于 config identity，不能由某个 adapter 临时覆盖共享 daemon。
- secret 原值及普通 digest 都不得进入 instanceId、公开路径或日志。daemon 从 instanceId 对应的唯一配置源自行读取 credentials/policy，adapter 不能提供另一份 secret 覆盖；credential rotation 只改变受保护的 configRevision。
- IPC hello 必须包含 `protocolVersion/packageVersion/instanceId/configRevision/policyFingerprint/stateDirIdentity`；daemon 先完成待处理热重载再比较 revision/fingerprint，仍不匹配则明确失败，不能静默复用或合并配置。
- IPC 消息必须有 `protocolVersion/requestId/method/params`，连接时先握手；adapter 与 daemon 主版本不兼容时明确报错并拒绝执行，不能按旧 schema 猜测。
- IPC frame 必须有长度上限；日志和文件内容不得无界塞进单个 frame，改用 offset 分页或 event stream。
- `handfree-ssh-mcp` 无子命令时继续启动 stdio MCP adapter；adapter 发现 daemon 不存在时按 `daemonMode` 决定自动启动或报错。
- 提供：
  - `handfree-ssh-mcp daemon start`
  - `handfree-ssh-mcp daemon serve`
  - `handfree-ssh-mcp daemon status`
  - `handfree-ssh-mcp daemon stop`
  - `handfree-ssh-mcp mcp`
  - `handfree-ssh-mcp web open`（在交互终端显示一次性 code并打开无凭据 URL）
- mode 推导：旧配置默认为 `embedded`；显式存在 sync/run/web 配置时默认为 `auto`；显式值 `embedded/auto/external` 覆盖推导。CI 可用 `embedded` 收集覆盖率；故障诊断可用 `external` 禁止自动启动。
- auto 模式启动 daemon 时必须脱离 MCP 的 stdin/stdout/stderr：stdout 绝不能继承并污染 MCP stdio JSON-RPC，daemon 日志写专用文件。
- daemon 退出前停止接收新 job、取消 watcher、flush 数据库、关闭 SSE、等待可中断任务清理，然后关闭 SSH client。

### 4.3 持久状态

使用 Node `node:sqlite`，数据库默认位于：

- Windows：`%LOCALAPPDATA%\handfree-ssh-mcp\instances\<instanceId>\state.db`
- Linux/macOS：`$XDG_STATE_HOME/handfree-ssh-mcp/instances/<instanceId>/state.db`，未定义时使用 `~/.local/state/handfree-ssh-mcp/instances/<instanceId>/state.db`

`node:sqlite` 的 `DatabaseSync` 不得直接在传输/SSH 事件循环中执行大批同步 SQL。数据库由一个专用 worker thread 持有，Controller 通过有界消息队列批量提交；队列满时施加 backpressure，不能丢 job state。测试中的 in-memory DB 只可用于纯 store 测试，真实 acceptance 必须使用磁盘数据库和真实重启。

最低表集合：

```sql
schema_migrations(version PRIMARY KEY, applied_at, checksum)
jobs(id, type, state, created_at, started_at, finished_at, profile, server, error_json, metadata_json)
job_events(event_id INTEGER PRIMARY KEY AUTOINCREMENT, job_id, job_seq, event_type, timestamp, payload_json)
transfer_checkpoints(job_id, phase, source, destination, bytes_done, bytes_total, metrics_json)
run_records(job_id PRIMARY KEY REFERENCES jobs(id), profile, server, remote_dir, remote_pid, state, exit_code, manifest_generation, metadata_json)
server_capabilities(server, key, value_json, checked_at, expires_at)

sync_profiles(name, direction, generation, owner_state, activity_phase, active_job_id,
              last_local_scan_at, last_remote_scan_at, last_success_at, last_error_json,
              local_root_identity, remote_root_identity, delete_epoch)

-- 三态模型：base 为上次成功同步时双方一致的状态
sync_manifest(profile, relative_path, kind,
              local_size, local_mtime_ns, local_mode, local_hash, local_seen_at,
              remote_size, remote_mtime_ns, remote_mode, remote_hash, remote_seen_at,
              base_size, base_mtime_ns, base_hash, base_synced_at,
              generation, tombstone, tombstone_side)

sync_conflicts(profile, relative_path, detected_at, conflict_kind,
               local_state_json, remote_state_json, base_state_json,
               resolution, resolved_at, resolved_by, artifact_path)
```

要求：

- schema migration 必须向前事务化；失败时数据库保持旧版本可读。
- SQLite 开启 WAL、busy timeout、foreign keys 和 defensive mode。
- 任何 UI/MCP API 都不能执行任意 SQL。
- `event_id` 是全局单调 cursor，供 SSE/HTTP catch-up；`job_seq` 在单个 job 内从 1 递增，唯一约束为 `(job_id, job_seq)`。
- 日志大内容写文件，数据库只保存元数据和路径，避免数据库无限膨胀。
- 所有异步操作都只有一个 canonical `jobId`。run tool 为用户可读性使用字段名 `runId`，但其值与 `jobs.id/run_records.job_id` 完全相同；响应同时给出 `jobId` 和 `runId` 并断言二者相等。
- sync profile 是长期配置/运行状态；每次 initial sync、watch batch、flush、rescan、remote scan、reconciliation 都建立独立 sync job，profile 只保存当前 generation 和 owner 状态。
- `base_*` 只有在一次「该路径双侧内容确认一致」的成功同步后才更新；任何未完成、被取消或校验失败的传输都不得推进 base，否则 `bidirectional` 会把未同步的改动误判为「对侧新增」。
- retention 默认：已完成 job/event 30 天、日志 14 天、过期 capability 7 天、成功 temp 立即清理、失败 temp 24 小时、tombstone 30 天、已解决 conflict 记录 30 天；均可配置总字节上限。GC 跳过 running/recovering job并写审计 event。
- migration 前执行 WAL checkpoint、磁盘空间 preflight 和 SQLite backup API；备份为 `state.db.v<old>.<timestamp>.bak` 且权限与原 DB 相同。新二进制只支持当前 schema 和前一 schema 的只读诊断；旧 1.x 不读取 v2 DB。未来 schema 或 migration 中断时拒绝 mutating service并提供 `daemon database restore <backup>`。

## 5. 对外配置与 API 契约

### 5.1 YAML 配置草案

```yaml
daemon:
  instanceName: default
  mode: auto                  # auto | embedded | external
  # stateDir omitted = platform default; instanceId subdirectory is automatic

web:
  enabled: false
  host: 127.0.0.1
  port: 8765
  # tokenFile omitted = <resolved config state dir>/web.token

transferDefaults:
  strategy: auto              # auto | direct | relay
  engine: auto                # auto | builtin | rsync | rclone
  fast: true
  striped: auto               # off | auto | on
  checkers: 8
  transfers: 4
  streams: 4
  requestsPerStream: 64
  chunkSize: 32768
  maxBufferBytes: 268435456

runProfiles:
  qwen-dev:
    syncProfile: qwen-dev     # 可选；未设置时 server 与 remoteRoot 必填
    environment:
      type: venv              # venv | conda | module | slurm | executable
      path: /data/arc/venvs/qwen
    executable: python
    allowedEntrypoints:
      - train.py
      - benchmarks/*.py
    env:
      PYTHONUNBUFFERED: '1'
    secretEnv:
      HF_TOKEN:
        provider: process-env
        key: HF_TOKEN
    gpu:
      required: true
      visibleDevices: auto
    timeout: 24h

syncProfiles:
  qwen-dev:
    localRoot: E:/Projects/qwen
    server: gpu4090
    remoteRoot: /data/arc/qwen
    direction: bidirectional  # push | pull | bidirectional
    watch: true               # 本地 watcher；远端无 agent，靠 remoteScanInterval
    remoteScanInterval: 5m    # pull/bidirectional 必填；push 模式忽略
    initialSync: archive      # archive | files
    archiveCompression: zstd
    reconcileInterval: 10m
    debounceMs: 500
    maxBatchDelayMs: 5000
    maxPendingEvents: 4096
    atomicWrites: true
    conflict:
      policy: fail            # fail | newer-wins | local-wins | remote-wins | keep-both
      keepBothSuffix: '.conflict-{side}-{timestamp}'
      typeChange: fail        # file<->dir 变更始终可单独收紧，不允许 newer-wins
    delete:
      enabled: false
      propagate: none         # none | push | pull | both
      requireApproval: true
      approvalTtl: 5m
      rootIdentity: marker-and-volume
      divergence: conflict-fail  # conflict-fail | authoritative-overwrite | backup-then-overwrite
      backupRetention: 7d
      remote:                 # 删除远端文件的上限
        maxCountPerRun: 100
        maxBytesPerRun: 1GiB
        maxPercentPerEpoch: 5
        maxCountPerEpoch: 500
        maxBytesPerEpoch: 5GiB
      local:                  # 删除本地文件的上限，pull/bidirectional 才可能触发
        backupBeforeDelete: true
        backupDir: .handfree-trash
        maxCountPerRun: 50
        maxBytesPerRun: 512MiB
        maxPercentPerEpoch: 2
        maxCountPerEpoch: 200
        maxBytesPerEpoch: 2GiB
    ignore:
      - .git/**
      - node_modules/**
      - .venv/**
      - __pycache__/**
      - build/**
      - dist/**
      - '*.pyc'

directRoutes:
  source-to-destination:
    sourceServer: source
    destinationServer: destination
    destinationHost: destination.internal
    destinationPort: 22
    destinationUser: app
    hostKey: SHA256:REQUIRED_PIN
    credentialMode: existing-remote-key  # existing-remote-key | agent-forward
    backends: [rsync, rclone, tar-ssh]
```

配置契约必须由 `src/contracts/config-schema.ts` 的 Zod schema 定义，并生成 JSON Schema；README 示例必须参加 parse test。统一规则：

- duration 接受正整数毫秒或字符串 `ms/s/m/h/d`；byte size 接受正整数或 IEC 字符串 `KiB/MiB/GiB`，大小写敏感，溢出安全整数即失败。
- `~` 只在 path 字段展开；默认不展开任意环境变量。Windows 接受盘符和反斜杠并规范化，remote path 始终按 POSIX 处理。
- unknown key 默认报错；迁移期只有列入 `deprecatedKeys` 的字段产生一次 warning。
- glob 均相对各自 root，路径分隔符规范化为 `/`；匹配大小写由目标文件系统 capability 决定，而不是由 Controller OS 猜测。
- `stateDir/config source/daemon mode/IPC identity/web bind/token file` 为 restart-required；server connection/policy、sync/run profile 为 dynamic。
- `direction` 变更属于 restart-of-profile：必须先 drain 当前 profile、重建 base 状态（等同一次完整 reconciliation），不允许在运行中热切方向。
- reload 时 running job 使用创建时的不可变、已去除 secret 原值的 config snapshot；新配置只影响新 job。删除正在 watch 的 profile先进入 draining，完成当前原子操作后停止。
- instanceName、config source path、enabledServers 或 stateDir 改变会得到新 instanceId并启动/连接另一个 daemon；同一配置源的内容 reload 只递增 configRevision，不允许原 daemon 改变 instanceId。

run profile 的约束：若设置 `syncProfile`，`server` 和 `remoteRoot` 必须从该 sync profile 派生且不得重复配置；没有 `syncProfile` 时两者才是必填。创建 run 时持久化 config revision、非秘密配置 snapshot、manifest generation 和 root digest，后续 launch/status/retry 不混读热更新配置。

### 5.2 新 MCP tools

传输（Phase 1）：

- 扩展现有 `transfer`：`strategy`、`engine`、`striped`、`streams`、`checkers`、`transfers`、`maxBufferBytes`、`background`。
- 扩展 `upload` 与 `transfer mode=upload` 的 `localPath` 为 `string | string[]`（批量上传，见 5.7）。
- `transfer-status { jobId }`
- `transfer-cancel { jobId }`
- `transfer-capabilities { sourceServer?, destServer?, refresh? }`

运行（Phase 2）：

- `workspace-run { profile, entrypoint, args?, env?, push?, collect?, sync?, timeout?, stream? }`
- `run-status { runId }`
- `run-logs { runId, stream?, offset?, maxOutputBytes? }`
- `run-list { profile?, server?, state?, limit? }`
- `run-cancel { runId, graceMs? }`
- `run-retry { runId, push? }`

`workspace-run` 参数语义：

- `push`（boolean，默认取 profile 的 `defaultPush`，profile 未声明时为 `true`）：启动前把 profile 声明的本地源一次性推送到 `remoteRoot`。走 Phase 1 的 TransferService，不需要同步引擎。
- `collect`（string[]，默认取 profile 的 `collect.paths`，未声明则跳过）：远端进程退出后按 glob 拉回产物。
- `sync`（Phase 3 占位）：本轮只接受 `none`；传入 `flush` 返回 `SYNC_NOT_AVAILABLE`，不得静默忽略。

同步（Phase 3，暂缓，仅保留契约占位）：

- `sync-start { profile, initial?: boolean }`
- `sync-stop { profile }`
- `sync-pause { profile }`
- `sync-resume { profile }`
- `sync-flush { profile, timeout? }`
- `sync-rescan { profile, side?: "local" | "remote" | "both", paths? }`
- `sync-status { profile?, includeFiles?: boolean, includeConflicts?: boolean }`
- `sync-plan { profile, includeDeletes?: boolean }`：创建不可变 plan，只计算，不修改任何一侧；返回 `planId/planDigest/expiresAt/direction/pushSummary/pullSummary/deleteSummary/conflictSummary`。
- `sync-approve-delete { planId, planDigest }`：经调用方明确确认后发行短期单次 approval token。
- `sync-apply-plan { planId, approvalToken? }`：执行完全相同的 plan；含任何一侧 delete 时必须提供 token。
- `sync-conflicts { profile, state?: "open" | "resolved", limit? }`
- `sync-resolve-conflict { profile, relativePath, resolution: "take-local" | "take-remote" | "keep-both", planDigest }`

所有 tool 返回统一 envelope：

```json
{
  "ok": true,
  "jobId": "transfer_20260914_ab12cd34",
  "state": "running",
  "message": "Transfer started",
  "next": "Poll transfer-status",
  "details": {}
}
```

统一 envelope 只适用于新 tools，以及显式 `background:true` 的扩展 transfer。未指定 `background` 的旧 upload/download/transfer 调用继续等待终态并返回旧文本结果；不得把旧 tool 静默改成 JSON envelope。

统一错误对象：

```json
{
  "code": "STABLE_MACHINE_CODE",
  "message": "bounded human-readable message",
  "retryable": false,
  "details": {},
  "cleanup": { "attempted": true, "completed": true, "residue": [] }
}
```

`details` 经过 schema 和大小限制，不能包含 secret、私钥或无界远端输出。

### 5.3 IPC、HTTP 与事件契约

IPC 使用 4-byte big-endian 长度前缀加 UTF-8 JSON，单 frame 最大 8 MiB。消息类型为 `hello/request/response/cancel/subscribe/event/ping/pong`；`requestId` 在一条连接内唯一。adapter 断线只取消标记为 `cancelOnDisconnect` 的请求，持久 job 默认继续。取消是幂等请求，重复取消返回当前终态。

共享契约位于 `src/contracts/`，由 MCP adapter、IPC、HTTP 和 WebUI 从同一份 Zod/TypeScript 定义生成，不允许手写四份类型。HTTP v1 至少包含：

```text
GET  /api/v1/servers
POST /api/v1/servers/:server/reconnect
POST /api/v1/servers/:server/close
GET  /api/v1/servers/:server/files?path=&cursor=&limit=
GET  /api/v1/servers/:server/files/stat?path=
GET  /api/v1/jobs?type=&state=&cursor=&limit=
GET  /api/v1/jobs/:jobId
GET  /api/v1/jobs/:jobId/events?afterEventId=&limit=
GET  /api/v1/jobs/:jobId/logs?stream=stdout|stderr&offset=&limit=
POST /api/v1/jobs/:jobId/cancel
GET  /api/v1/sync/profiles
POST /api/v1/sync/:profile/start|stop|pause|resume|flush|rescan|plan
GET  /api/v1/sync/:profile/conflicts?state=&cursor=&limit=
POST /api/v1/sync/:profile/conflicts/resolve
POST /api/v1/sync/plans/:planId/approve-delete
POST /api/v1/sync/plans/:planId/apply
POST /api/v1/commands
POST /api/v1/runs
POST /api/v1/runs/:runId/retry
POST /api/v1/transfers
GET  /api/v1/transfers/capabilities?sourceServer=&destinationServer=&refresh=
GET  /api/v1/events?afterEventId=&types=     # SSE
POST /api/v1/auth/bootstrap
POST /api/v1/auth/logout
```

- 列表 pagination 使用不透明 cursor，默认 50、最大 500。
- logs 使用 byte offset，默认 64 KiB、最大 1 MiB，并返回 `nextOffset/hasMore`；UTF-8 边界逻辑与 MCP run-logs 共用。
- SSE 使用全局 `event_id`，客户端以 `Last-Event-ID` 或 `afterEventId` 恢复；server 发 heartbeat，保留期之外返回 `EVENT_CURSOR_EXPIRED` 并要求重新获取 snapshot。
- v2 首批实时通道选择 SSE；不实现交互 PTY，因此不需要 WebSocket。若后续增加 PTY，另立安全设计。
- HTTP success 返回 `{ok:true,data,requestId}`，error 返回统一错误并映射稳定 HTTP 状态；MCP/IPC 保持同一个 machine code。
- 所有 schema 生成 OpenAPI artifact `artifacts/openapi.json`，并由 contract tests 验证示例。
- files API 在 v2 首批只读 list/stat；文件写入通过 transfer/sync service，Command API 调用现有 command policy，server action 调用现有 connection service，均不得在 HTTP handler 重写业务逻辑。
- delete 固定两阶段协议：plan 绑定双侧 generation、configRevision、policyFingerprint 和完整文件列表 digest；approve 只对该 digest 发行单次 token；apply 前再次比较全部绑定值，任一变化返回 `STALE_SYNC_PLAN`。token 只保存不可逆随机摘要，不写 URL/普通日志，使用或过期立即失效。

### 5.4 Transfer 合法组合

| 拓扑 | strategy | engine/backend | striped | 规则 |
|---|---|---|---|---|
| local→remote / remote→local | 不适用，传入即报错 | `auto/builtin/rsync/rclone` | 仅 `builtin` 单文件可用 | `auto` 优先 capability-gated builtin striped，再 current fast；外部 engine 只在显式允许且可安全注入凭据时选择 |
| remote A→remote B | `relay` | `builtin` | 可用于 builtin multi-channel relay | 数据经过 Controller；forced relay 不尝试 direct |
| remote A→remote B | `direct` | direct backend `rsync/rclone/tar-ssh` | 不适用，传入 `on` 即报错 | 命令在 A 执行；任一 capability 不满足即失败，不回退 |
| remote A→remote B | `auto` | direct backend 后 builtin relay | planner 决定 | direct 顺序 `rsync→rclone→tar-ssh`，全部不可用再 relay，并报告原因 |

`archive` 是 transfer 前后的 transform，不是 engine。archive 与 striped 不同时启用；`striped:on + archive:true` 报错，`striped:auto` 在 archive 时解析为 off。`tar-ssh` 只叫 `directBackend`，不加入通用 `engine` 枚举。所有响应返回 requested plan 和 actual plan。

### 5.5 Job 状态机

通用状态：

```text
queued -> preparing -> running -> verifying -> completed
                  └-> cancelling -> cancelled
                  └---------------> failed
```

通用 job 合法转换如下；任何其他转换返回 `INVALID_STATE_TRANSITION`：

| From | To |
|---|---|
| queued | preparing, cancelling, failed |
| preparing | running, cancelling, failed |
| running | verifying, cancelling, failed |
| verifying | completed, cancelling, failed |
| cancelling | cancelled, failed |
| recovering | running, verifying, completed, cancelled, failed, orphaned |
| orphaned | recovering, failed |

`completed/cancelled/failed` 是终态。进程崩溃时遗留的非终态在重启后先进入 `recovering`；身份无法证明时进入 `orphaned`，禁止自动重跑或发送 signal。

Controller recovery scanner 拥有唯一的 system-only 转换权限：`preparing/running/verifying/cancelling → recovering`，每次转换必须写 recovery event且幂等。尚未产生任何副作用的 `queued` 保持 queued并重新调度；recovering 时收到 cancel，只记录 cancel intent，完成远端/临时文件身份确认后进入 cancelling 或直接 cancelled。普通 API 不能触发 system-only 转换。

sync profile owner 状态独立于 job：`stopped → starting → watching ↔ paused → stopping → stopped`；单独的 `activity_phase` 为 `idle|scanning-local|scanning-remote|planning|syncing|conflict-blocked|error|recovering`，`last_error_json` 保存详情，`active_job_id` 指向当前 mutating job。每个 batch/scan/flush 仍有独立 jobId。run job 在通用 `running` 内用 `phase=push|preflight|launching|remote-running|collect` 表示（Phase 3 回填时 `push` 位置可取 `syncing`），不把这些 phase 混入通用 state enum。phase 流水线的通用规则见 5.8。每次 state/phase 转换必须与 event 同事务持久化。

### 5.6 三模式同步决策表

对每个 `relative_path`，比较 `base`（上次成功同步的一致状态）、`local`（本地当前）、`remote`（远端当前）三个状态。`≡` 表示与 base 一致，`≠` 表示已变更，`∅` 表示不存在。

| local | remote | push | pull | bidirectional |
|---|---|---|---|---|
| ≡ | ≡ | no-op | no-op | no-op |
| ≠ | ≡ | upload | **忽略本地改动**（不回滚本地） | upload |
| ≡ | ≠ | 覆盖远端（divergence 策略） | download | download |
| ≠ | ≠ 且 hash 相同 | 更新 base | 更新 base | 更新 base |
| ≠ | ≠ 且 hash 不同 | 按 divergence 策略 | 按 divergence 策略 | **CONFLICT** |
| ∅（base 有） | ≡ | delete remote（需授权） | 重新下载 | delete remote（需授权） |
| ≡ | ∅（base 有） | 重新上传 | delete local（需授权） | delete local（需授权） |
| ∅ | ∅ | 清 tombstone | 清 tombstone | 清 tombstone |
| ∅（base 有） | ≠ | 按 divergence 策略 | download | **CONFLICT**（delete-vs-modify） |
| ≠ | ∅（base 有） | upload | 按 divergence 策略 | **CONFLICT**（modify-vs-delete） |
| 新增 | 新增 且 hash 相同 | upload | download | 更新 base |
| 新增 | 新增 且 hash 不同 | 按 divergence 策略 | 按 divergence 策略 | **CONFLICT**（both-created） |
| 类型变更 file↔dir | 任意 | 按 `conflict.typeChange` | 按 `conflict.typeChange` | 按 `conflict.typeChange`，默认 fail |

规则：

- `push` 永不修改本地，`pull` 永不修改远端；违反即为实现缺陷，必须有断言测试。
- `bidirectional` 命中 CONFLICT 时按 `conflict.policy`：`fail` 记录冲突、跳过该路径、profile 进入 `conflict-blocked`，其余路径继续同步；`keep-both` 保留双方并按 `keepBothSuffix` 重命名；其余策略按名称直取一侧。
- 无论何种 policy，冲突都必须写入 `sync_conflicts` 并产生审计 event；自动解决也不例外。
- 只有该路径双侧内容确认一致后才推进 `base_*`。
- 远端状态的新鲜度受 `remoteScanInterval` 限制；plan 必须附带 `remoteScannedAt`，apply 前若远端状态过期则强制重扫。

## 5.7 批量上传契约

`upload` 与 `transfer mode=upload` 的 `localPath` 扩展为 `string | string[]`。传字符串时行为与 1.x 完全一致，不得有任何可观察差异。

传数组时：

- `remotePath` 必须是目录；每个源文件落到 `remotePath/<basename>`。
- **basename 冲突在传输前硬失败**：`["a/config.yaml", "b/config.yaml"]` 会撞同一目标，返回 `BATCH_TARGET_COLLISION` 并列出冲突项。数组内重复路径同样报错，不静默去重。
- 数组长度上限 1000，超出返回 `BATCH_TOO_LARGE`。空数组返回 `INVALID_CONFIGURATION`。
- 并发复用 `fileConcurrency`（默认 4、上限 32），并受 P1-03 的 per-server channel budget 约束。
- `onError`：默认 `abort`（停止调度新文件，在飞的传完，逐文件报告）；`continue` 需显式指定。两种模式都必须返回**每个文件**的 `uploaded | skipped | failed` 及失败原因。
- 逐文件独立复用现有单文件逻辑：skip-if-identical、`.sh`/`.bash`/`.zsh` 的 CRLF 修正、`fast`、路径策略校验。汇总里分别给出 skip 命中数和 CRLF 修正数。
- `archive: true` + 数组：本轮返回 `INVALID_CONFIGURATION`（现有 archive 实现只接受单一 source path，多来源需重写 `archiveCreateArgs`）。该组合列为后续增强。
- 数组入参是全新形状，因此返回结构化 JSON 结果；字符串入参继续返回旧文本结果。此差异不违反 3.3，因为没有任何 1.x 调用方会传数组。
- 本轮只扩展上传方向。`download`/`relay` 的数组形式与 `[{localPath, remotePath}]` 显式配对形式均列为后续增强，不在本轮范围。

## 5.8 Job phase 流水线

复合能力通过**声明式 phase 流水线**表达，而不是新增复合工具。每种 job 类型声明一个有序 phase 列表，每个 phase 调用一个已存在的 service；参数决定某 phase 是否执行及如何执行。

```text
workspace-run:  [push] → preflight → launching → remote-running → [collect]
transfer:       [pack] → connect → transfer → verify → [extract] → cleanup
```

规则：

- 整条流水线只有一个 canonical `jobId`、一个通用状态机、一套 cleanup matrix、一条 event 流。禁止内部再起独立 job。
- phase 名进入 `jobs.metadata_json` 与 event payload，`run-status`/`transfer-status` 必须能回答「当前卡在哪个 phase」。
- 任一 phase 失败即整条流水线失败；cleanup **按 phase 反序**执行，每个 phase 声明自己的清理动作。
- 可选 phase 被跳过时仍要在结果里显式标注 `skipped` 及原因，不能静默消失。
- 新增复合能力的正确做法是给流水线加一个 phase，不是新增一个 tool。任何新增 tool 的提议必须先说明为什么它不能表达为 phase。

`collect` phase 的专属约束：

- 必须由显式 glob 声明（`collect.paths`），**禁止默认拉取整个 remoteRoot**。
- 必须有总字节上限与文件数上限，超限则 `collect` phase 失败并报告已拉取清单，不静默截断。
- run 失败或被取消时**默认仍执行 collect**（日志与部分产物往往正是诊断材料），结果标注 run 的终态。
- `collect` 失败不得改写 run 的 exit code；它是独立 phase，有自己的子状态与错误对象。

## 6. 分阶段实施任务

关键路径和允许并行关系：

```text
P0-00 → P0-01 ─┬→ P0-03 → P0-04 → P0-05 → P0-06
                └→ P0-02 ────────────────────┘
PHASE-0-GATE → P1-01 → P1-02 → P1-09 → P1-03 → P1-04 → P1-05 → P1-06 → P1-07 → P1-08
PHASE-1-GATE → P2-01 → P2-02 → P2-03 → P2-04 → P2-06 → P2-05
PHASE-2-GATE → Phase 5（本轮）

--- 以下暂缓，设计保留 ---
PHASE-1-GATE → P3-01 → ... → P3-06 ； PHASE-2-GATE + P3-06 → P3-07
PHASE-3-GATE → P4-01 → ... → P4-06
```

本轮（Rev.3）关键路径为 `P0-00 → … → PHASE-0-GATE → P1-* → PHASE-1-GATE → P2-* → PHASE-2-GATE`。P1-09（批量上传）插在 P1-02 之后，因为它依赖路径身份基座；它与 P1-03 之后的性能任务无相互依赖，可并行。

- P0-02 fixture 可与 P0-03 contracts 并行，但 P0-04 之后的 service acceptance 同时依赖二者。
- Phase 2（运行）与 P3-01..P3-06（同步）在 PHASE-1-GATE 之后可以由不同工作树并行，但不能同时修改共享 contracts/Controller；共享契约变更先单独合并并重跑 P0 gates。
- P3-07 是把同步屏障回填进运行任务，必须同时满足 PHASE-2-GATE 和 P3-06。
- Phase 4 必须等待 Job/Event/Sync/Run/Transfer API 稳定，不能以临时 fake API 先行绑定。
- 每个任务开始前在 journal 记录 `dependsOn` 的 acceptance artifact；缺少任一前置 PASS 时不得开工。

## Phase 0：保护基线、拆出可测试边界、建立真实测试实验室

目标：不改变现有外部行为，先建立后续功能共同依赖。

### P0-00 环境 preflight 与 gate 分类

- [ ] 新建 `scripts/preflight.mjs`，输出 JSON 和表格，检查 Node `>=24.15.0`、npm、git、gh、tar、Docker/Compose、可用磁盘、loopback port、Playwright 浏览器和当前平台 watcher。
- [ ] CI Linux fixture 检查 OpenSSH、rsync、zstd、Python venv 和 `CAP_NET_ADMIN/tc netem`。
- [ ] capability 分三类：A=所有开发/发布环境必需，B=Linux/Windows CI matrix 必需，C=专用 qualification（GPU、CUDA、Slurm、conda、module、可选 rclone）。
- [ ] A 缺失立即失败；B 只能在不负责该平台的本地开发机显示 `NOT_APPLICABLE`，对应 CI 不得跳过；C 仅在该 adapter 声明发布或相关 profile 启用时成为必需。
- [ ] 任何 `SKIP` 必须写 capability、原因、批准者和同 commit 的替代 artifact；发布所需 A/B gate 不允许批准跳过。
- [ ] SSH lab 镜像固定 digest并安装 tar、rsync、zstd、Python/venv；netem runner 显式授予 `CAP_NET_ADMIN`。

- [x] **P0-00-A1**：已完成（2026-09-15 验收）。`scripts/preflight.mjs` + `src/tests/preflight.test.ts`（7 个真实子进程测试）。独立复核：`npm test` 336/336；`--require A` → exit 0，`--require A,B` → exit 2（`unmetRequired: ["linux-lab-environment"]`），`--require Z` → exit 1，写入目标不可用 → exit 3 且回落到 temp 路径。WSL 探测使用 `wsl.exe -l -q` + UTF-16LE 解码，不匹配任何本地化文案（本机为中文 Windows）。

P0-00 实施记录与偏差：

- [x] `gh` 降为 C 类：它不参与构建或测试，仅用于发布自动化与 §2.2 的一次性参考仓库克隆。P0-00 的检查清单同时列出 Docker 与 Playwright，二者均非 A 类，可见「被检查」不等于「A 类」。保留真实探测并记录 `details.detected`。
- [ ] **已知缺口（交由 P0-02）**：在 win32/darwin 上，5 个「lab 内部」探针（openssh-server / rsync / zstd / python-venv / netem+CAP_NET_ADMIN）为 NOT_APPLICABLE，因为本机尚无可供验证的 Linux 环境，未实现 exec-into-Docker/WSL 的探测逻辑。这是刻意克制而非遗漏：在无法真实验证的前提下交付该逻辑等同于伪造结果，违反 §7.2。P0-02 provision 出 Linux 环境后必须补齐并真实验收。
- [x] `configFingerprint` 目前只是本次 preflight 调用输入（package 版本、node、platform、arch、`--require` 集合）的指纹，用于 artifact 比对；**不是** §4.2 的 `instanceId`/`configRevision`/`policyFingerprint` 体系，后者需 P0-03 的 `src/contracts/` 落地后才能实现。已在代码注释中标注，避免后续误用。

### P0-01 基线与工作树保护

- [ ] 完成 §2.3 表中的 F1–F4，使本机 `npm test` 回到全绿。F1 的 RED 已天然存在（5 个真实失败的测试），不得编造额外假 RED；F2–F4 按 7.1 的行为变更类型走 RED→GREEN→REFACTOR，按 7.2.1 补齐三盒。
- [ ] F5（串行目录枚举）登记为 P1-03 范围，本任务不修；但需检查 README/README_CN 现有「递归小文件并发」措辞是否夸大，必要时先改准确。
- [ ] 记录 `git status --short`、`git diff --stat`、commit、Node/npm 和依赖版本到实施 journal。
- [ ] 确认现有 v1.0.19 未提交文件归属，避免新功能覆盖这些改动。
- [ ] 请求用户选择可恢复检查点：授权 commit/branch、授权 stash，或授权在权限受控的 state directory 创建包含 tracked diff 与 untracked 文件的本地 snapshot。三者均未授权时将 P0-01 标记 BLOCKED，禁止进入 P0-03/P0-04。
- [ ] 检查点记录类型、绝对位置、文件 manifest、SHA-256 和恢复命令；在一次性临时副本执行 restore drill，验证与原工作树内容 hash 相同。
- [ ] 运行并保存：`npm test`、`npm run test:coverage:transfer`、`npm pack --dry-run`。
- [ ] 运行 `git diff --check`；只允许已知换行警告，不允许 whitespace error。

- [ ] **P0-01-A1**：基线命令日志落到 `artifacts/baseline/`；既有失败已单独归因，不得计入新功能 RED。
- [ ] **P0-01-A2**：`artifacts/baseline/checkpoint.json` 记录用户授权、checkpoint SHA-256 和 restore drill PASS；没有授权则明确 BLOCKED。

### P0-02 真实 SSH 实验室

- [ ] 新建 `tests/fixtures/ssh-lab/compose.yaml`。
- [ ] 至少启动 `source`、`destination` 两个真实 Linux OpenSSH 容器。
- [ ] 两台容器分别有独立 host key、用户、文件根和日志。
- [ ] source 可通过仅测试使用的 pinned key 访问 destination，以测试 direct；另有一组网络/认证配置必然失败，以测试 relay fallback。
- [ ] 安装真实 `tar`、`rsync`、Python 和创建真实 venv；rclone 可作为单独带标签的 fixture，不成为所有测试的硬依赖。
- [ ] fixture 使用随机高位 host port，避免占用开发机固定端口。
- [ ] 测试结束删除容器和测试 volume；失败时保留日志 artifact，不保留秘密。

- [ ] **P0-02-A1**：从测试进程分别通过 SSH 执行 `uname`、SFTP 上传固定 seed 随机文件、下载并核对 SHA-256；日志写 `artifacts/ssh-lab/`。

### P0-03 契约先行

- [ ] 实现 `src/contracts/` 的 config、IPC、HTTP、job、event、sync、run、transfer 和 error Zod schema。
- [ ] 生成 TypeScript types、JSON Schema 和 OpenAPI；前端只导入生成/共享类型。
- [ ] 为 5.3–5.6 的 framing、分页、cursor、identity、状态转换、transfer 组合和三模式决策表写 contract tests。
- [ ] 三模式决策表以纯函数实现并做穷举 value test：每个 `(direction, local, remote, base)` 组合都有唯一确定结果，不存在未覆盖分支。
- [ ] 对旧 foreground tool response 建 characterization contract；对新/background tool 建 envelope contract。
- [ ] schema 版本与 IPC/HTTP major version 绑定；不兼容请求必须失败。

- [ ] **P0-03-A1**：`node scripts/validate-contracts.mjs` exit 0，生成 `artifacts/openapi.json` 和 `artifacts/schemas/*.json`；所有文档示例可解析。
- [ ] **P0-03-A2**：三模式决策表穷举测试 100% 分支覆盖；`push` 分支不产生任何本地写操作、`pull` 分支不产生任何远端写操作，由类型或断言强制。

### P0-04 模块化 facade

- [ ] 先写 characterization tests，冻结现有 tool、连接复用、重试、path policy、archive 和 relay 行为。
- [ ] 提取 `SshConnectionPool`，保留 `SSHConnectionManager` 作为兼容 facade。
- [ ] 提取 `TransferService`，现有 upload/download/transfer tool 只调用 service。
- [ ] 不在本任务中改变传输算法或 tool schema。

- [ ] **P0-04-A1**：既有测试全部通过；新增真实 SSH characterization tests 通过；公共返回文本和错误码不变。

### P0-05 JobStore 与 EventBus

- [ ] RED：真实 SQLite 文件重启后 job 和 event cursor 不可恢复。
- [ ] GREEN：实现 migration、JobStore、递增 event seq、查询和恢复。
- [ ] RED：订阅者断开后不能从最后 seq 续传。
- [ ] GREEN：EventBus 支持 live subscribe + persisted catch-up。
- [ ] REFACTOR：日志 payload 大于阈值时写日志文件，只在 DB 保存引用。

- [ ] 增加 migration interruption、WAL、磁盘满、future schema、只读数据库、retention/GC 和 restore 测试。
- [ ] **P0-05-A1**：关闭并重新打开真实磁盘 SQLite JobStore 后，运行中/已完成 job 可查询，event cursor 无重复、无缺口。
- [ ] **P0-05-A2**：中断 migration 后 mutating API 被拒绝，只读诊断和 `database restore` 可恢复旧备份。

### P0-06 Controller daemon 与 IPC

- [ ] RED：MCP adapter 退出后测试 SSH client和 durable sentinel job 全部消失。
- [ ] GREEN：实现 daemon、单实例锁、IPC、adapter 自动连接。
- [ ] RED：并发启动两个 daemon。
- [ ] GREEN：只有一个成为 owner，另一个返回现有 daemon 状态。
- [ ] 实现有序 shutdown 和崩溃恢复。
- [ ] 实现 instanceId namespace、configRevision 和 hello fingerprint 拒绝测试；两个不同实例同时运行时状态、policy、连接和 DB 完全隔离。

- [ ] **P0-06-A1**：关闭 MCP adapter 后 daemon PID 仍在；重新启动 adapter 能查询之前的 sentinel job；执行 `daemon stop` 后 socket/pipe、锁和 SSH client 全部释放。
- [ ] **P0-06-A2**：daemon auto 启动不向 MCP stdout 写任何非 JSON-RPC 字节；不同 instanceId adapter 无法连错 daemon。

- [ ] **PHASE-0-GATE**：外部行为不变、真实 SSH lab 可重复运行、契约 artifacts 完整、持久 job 与 daemon 生命周期成立。

## Phase 1：传输可观测性、加速与远端直传

目标：把传输做到可测量、可加速、可解释，并为后续所有阶段提供共享的路径身份基座。

### P1-01 TransferMetrics

- [ ] 为每个 transfer 记录 `connect/stat/compare/list/mkdir/pack/transfer/verify/extract/cleanup` 阶段时间。
- [ ] 记录 bytes、当前速度、滑动平均速度、ETA、buffer bytes、SFTP channel/SSH connection 数量、重试次数和实际 engine/strategy。
- [ ] 每 250–1000 ms 合并进度事件，避免每个 32 KiB ACK 写数据库。
- [ ] `vvv` 继续提供底层诊断，但正常 metrics 不依赖 `vvv`。
- [ ] 在响应中区分请求参数与实际采用参数。

- [ ] **P1-01-A1**：真实 256 MiB 固定 seed 随机文件 transfer 的 bytes 单调递增，最终值等于文件大小；取消和失败也保留阶段耗时；artifact 为 `artifacts/transfer-metrics/*.json`。

### P1-02 路径与身份安全基座

本任务建立 `src/fspath/`，供传输分片、运行 entrypoint 校验和后续同步扫描共用。

- [ ] 统一 Windows/POSIX 相对路径表示，拒绝 `..`、NUL、绝对相对子路径和 root escape。
- [ ] 每次实际 open/rename/run 前执行 `lstat + realpath + ancestor containment`，而不只做字符串检查；本地读取尽量用 no-follow handle，open 后 `fstat` 并在读取结束再次核对 identity/size/mtime。Windows 检查 reparse point；Unix 检查 symlink。
- [ ] 探测两端大小写敏感性并缓存到 `server_capabilities`；在大小写不敏感目标上发现 `A.py`/`a.py` 冲突时暂停并报错，不得静默覆盖。
- [ ] symlink 默认跳过并记录；后续显式模式才允许复制链接本身，绝不默认跟随到 root 外。
- [ ] ignore matcher 支持明确 glob 语义，供 transfer 与 sync 共用；默认排除 `.git`、内部 temp、state DB 和 output logs，用户可覆盖非安全默认项。
- [ ] 保留 1.x 的 `allowedLocalDirectories`/`allowedRemoteDirectories` 语义；embedded legacy upload/download 继续保留当前 cwd 隐式允许规则以兼容 1.x。

- [ ] **P1-02-A1**：真实目录包含大小写冲突、空格、Unicode、长文件名、Unix symlink、Windows junction/reparse point 和 traversal；静态逃逸均拒绝。rename race 使 source identity 改变时放弃本次传输并重扫，不提交正式目标。

### P1-03 并行 checker 和目录 walker

- [ ] 将目录发现、metadata checker、文件 transfer 分成三个队列和 semaphore。
- [ ] remote directory walker 有界并发 `readdir`，不再深度优先逐目录串行等待。这正是 §2.3 F5 登记的欠账：当前 `downloadDirectory` 的 `collect` 逐目录 `await listRemoteDir`。
- [ ] 落地 per-server channel budget 后，重新评估 §2.3 F3 临时下调的 `fileConcurrency` 上限（8），在 budget 保护下可安全放宽。
- [ ] mkdir 按 parent depth 分层，同层有界并发。
- [ ] 对每台 server 设置总 channel budget，避免 checkers + transfers 超过 sshd `MaxSessions`。
- [ ] queue 有 backpressure，禁止先把百万文件全部装入内存。
- [ ] 资源层级固定为 `global → server → SSH connection → job → stream/request`；获取顺序只能从左到右，取消/失败按反序释放，禁止交叉持锁等待。
- [ ] 默认 global SSH connections=16、per-server connections=8、per-server channels=16、per-job streams=4；planner 可向下调，不能越过上层 budget。
- [ ] 双腿 relay 必须以稳定 server-name 顺序一次性预留两端预算，预留失败回队列，避免 A→B 与 B→A 死锁。
- [ ] 例：同一 server 上两个 transfer job，各请求 4 streams；per-server channel budget=6 时公平分配 3+3，而不是第一个占满 4 后第二个饥饿。对应写取消释放和 FIFO 公平测试。

- [ ] **P1-03-A1**：10,000 个 4 KiB 文件 fixture 内存受限；同场相对串行 baseline 的 median 总耗时至少降低 30%，或达到远端 metadata capability 上限的 70%；远端 tree hash 相同。

### P1-04 Striped SFTP download

- [ ] 先实现多连接 download，因为本地 positional write 的兼容性可控。
- [ ] 预分配本地 temp 文件；每个 stream 使用独立 SSH/SFTP channel 或 connection 拉取不重叠区间。
- [ ] 并发 positional write；完成后 size/hash 验证并原子 rename。
- [ ] 总 buffer 受 `maxBufferBytes` 硬限制。
- [ ] 任一 worker 失败即取消其余 worker并清理 temp；连接错误不污染健康连接池。

- [ ] **P1-04-A1**：1 GiB 随机文件在 50 ms/1 Gbps netem 下，striped 相对同场单 channel baseline 至少 1.8×，或达到整形带宽 70% 以上；二者满足其一且 SHA-256 相同。

### P1-05 Capability-gated striped upload

- [ ] 创建、截断和预分配目标 temp 文件只执行一次。
- [ ] worker 后续打开同一 temp 文件时不得带 truncate flag。
- [ ] 不同 worker 写不重叠 offset。
- [ ] capability probe 使用独立随机 temp 文件验证多 handle、random offset、truncate 和最终 hash。
- [ ] probe 结果带 TTL 存入 `server_capabilities`。
- [ ] `striped=auto`：probe 成功采用；失败回退 current fast。
- [ ] `striped=on`：不支持时明确失败，不静默改变用户强制策略。
- [ ] `striped=off`：始终 current fast/buffered。
- [ ] `chunkSize > 32 KiB` 必须经过 server capability 证明；默认维持 32 KiB。

- [ ] **P1-05-A1**：OpenSSH fixture 走 striped；限制随机写的真实兼容性 fixture 自动回退；正式目标文件从未用于 probe；结果 SHA-256 相同。

### P1-06 多通道 relay

- [ ] relay planner 根据 RTT、文件大小、channel budget 和 memory budget 选择 stream 数。
- [ ] 每个 stream 负责不重叠 range；源 read 和目标 write 解耦但总 buffer 有界。
- [ ] 明确区分 `requestsPerStream` 与 `streams`。
- [ ] self-relay 保持单 server 连接复用和安全 offset 行为。
- [ ] 任一腿失败取消整个 job，保留可诊断的 source/destination phase。

- [ ] **P1-06-A1**：执行 8.2 的 canonical relay performance gate；任务正文不复制另一套阈值。Controller RSS 与目标 SHA-256 同时满足 8.2。

### P1-07 外部 engine 与远端执行 adapter

- [ ] 只探测和调用已经安装的 `rsync`/`rclone`/`ssh`/`tar`，不得自动下载。
- [ ] 实现统一的 local/remote subprocess wrapper：精确 argv/quote、bounded stdout/stderr、timeout、cancel、durable marker、exit status 和 cleanup。
- [ ] version/capability probe 有缓存和 TTL。
- [ ] credentials 不出现在 process title、日志和 tool response；local external engine 只支持 agent/private-key path或经安全 provider 注入的密码，不把 password 放 argv。
- [ ] subprocess stdout/stderr 进入统一 Job/Event/Metrics。
- [ ] external engine 失败按 planner 策略回退或终止；不得在同一正式文件上不清理地重复尝试。
- [ ] 内建 engine 始终保留，外部 binary 不是基础 upload/download 的硬依赖。

- [ ] **P1-07-A1**：在真实 SSH lab 分别执行可用/缺失/非零退出/超时/取消的外部 engine；秘密不出现在进程列表、日志、event 或响应。

### P1-08 Direct planner 与生命周期

- [ ] `strategy=auto` 依次检查 route、TCP:22、host key、engine、非交互认证和目标 path policy。
- [ ] probe 必须有超时并返回逐项结果。
- [ ] direct 优先级：远端 source 上的 `rsync`，其次 `rclone`，其次 `tar | ssh`；仅选 route 允许的 direct backend。
- [ ] 在 source 上运行时，source path 被视为本地路径，destination 为唯一 remote，确保数据 A→B。
- [ ] destination host key 必须 pinned；禁止自动接受 unknown host key。
- [ ] `existing-remote-key` 不传输任何私钥。
- [ ] `agent-forward` 默认禁用；启用时需要本地 agent、固定 destination、限定任务生命周期并在完成后立即关闭 channel。
- [ ] direct 不满足时：`auto` 记录原因并回退 relay；`direct` 明确失败。
- [ ] 网络不可达时不得声称可以绕过 NAT；文档建议使用已有 overlay/jump/relay。
- [ ] source 端为 direct 创建 durable wrapper/marker，记录 jobId、PID identity、engine、目标 temp、stdout/stderr 和 exit；取消遵循精确身份校验（与 P2-04 同一套实现）。
- [ ] destination 只写 jobId 绑定的 temp，完成验证后原子替换；daemon crash 后先查询 source marker、进程和 destination temp/hash，再决定恢复、完成或 orphaned。
- [ ] 每个 backend 定义 cleanup matrix：probe fail、auth fail、source read fail、destination write fail、cancel、Controller crash、unknown outcome。
- [ ] unknown outcome 禁止直接覆盖重试；只有 marker 与 temp identity/hash 一致时允许安全重入。

- [ ] **P1-08-A1**：真实 source 容器通过 rsync 直接传 destination；Controller relay data byte counter 为 0、控制/日志流量受限、目标 SHA-256 正确；破坏 route/host-key/auth 后 auto 回退且原因准确。
- [ ] **P1-08-A2**：direct 中途强杀 Controller，重启后不重复覆盖，能恢复/完成或进入 orphaned并安全清理。

### P1-09 批量上传

按 5.7 契约实现。依赖 P1-02 的路径身份基座；与 P1-03 之后的性能任务无相互依赖。

- [ ] `localPath` 扩展为 `string | string[]`；字符串入参行为与 1.x 逐字节一致，由 characterization test 冻结。
- [ ] 数组入参要求 `remotePath` 为目录，每个源落到 `remotePath/<basename>`。
- [ ] basename 冲突与数组内重复路径在**任何远端写入发生之前**硬失败，返回 `BATCH_TARGET_COLLISION` 并列出冲突项。
- [ ] 长度上限 1000（`BATCH_TOO_LARGE`）、空数组拒绝。
- [ ] 并发复用 `fileConcurrency`，受 per-server channel budget 约束。
- [ ] `onError: abort`（默认）停止调度新文件、等待在飞文件收尾；`onError: continue` 显式开启。两者都返回逐文件结果。
- [ ] 逐文件复用 skip-if-identical、CRLF 修正、`fast`、路径策略；汇总给出 skip 与 CRLF 计数。
- [ ] `archive: true` + 数组返回 `INVALID_CONFIGURATION`。
- [ ] 数组入参返回结构化 JSON；字符串入参保持旧文本输出。
- [ ] 更新 `help`、README、README_CN。

- [ ] **P1-09-A1**（黑盒）：经真实 stdio MCP 传 12 个真实文件到真实 OpenSSH fixture，逐文件 SHA-256 与本地一致；其中 2 个已存在且内容相同者被 skip；1 个 `.sh` 发生 CRLF 修正；返回的逐文件状态与远端实际状态完全吻合。
- [ ] **P1-09-A2**（灰盒）：注入第 7 个文件的真实失败（目标目录只读），`abort` 模式下后续文件未被调度、在飞文件已收尾、远端无半文件；`continue` 模式下其余 11 个成功且第 7 个被准确标记失败。
- [ ] **P1-09-A3**（白盒）：basename 冲突检测、重复路径检测、长度上限为纯函数，穷举 value test；断言冲突检测在任何 SFTP 调用前完成（以真实 SFTP 调用计数为 0 证明）。

- [ ] **PHASE-1-GATE**：能够解释实际选择的 strategy/engine；真实 direct 不经 Controller 数据面；release qualification 的单文件、relay 和碎文件数值门通过；批量上传三盒验收通过；`src/fspath/` 被 transfer 全量使用且无旁路。

## Phase 2：远程 workspace run

本阶段不依赖同步引擎。`workspace-run` 自带 `push` phase：调用 Phase 1 的 TransferService 一次性推送代码，成功才启动，一次调用完成「上传 → 跑 → 收产物」。常驻同步引擎的 `sync=flush` 屏障是 Phase 3 的 P3-07，与 `push` 并存而非替代——`push` 是一次性确定性推送，`flush` 是等待持续同步收敛，两种心智模型长期都保留。

### P2-01 Run profile 和环境预检

- [ ] 解析 `runProfiles`，引用不存在的 server profile 时启动即失败；本阶段 `syncProfile` 字段解析但拒绝启用（返回 `SYNC_PROFILE_NOT_AVAILABLE`），Phase 3 才放开。
- [ ] working directory、executable、entrypoint、args 和 env 分开建模并逐项 quote；禁止把用户参数拼进未经约束的 shell 模板。
- [ ] venv 直接调用 `<venv>/bin/python` 或 Windows 对应 executable，不依赖 `source activate`。
- [ ] conda/module/Slurm 通过受配置控制的 adapter；每个 adapter 有 capability probe。
- [ ] GPU required 时验证远端 GPU/CUDA；失败不得静默回退 CPU。
- [ ] `allowedEntrypoints` glob 相对规范化 remoteRoot，复用 P1-02 的大小写语义与路径身份校验，只匹配 regular file；最终 executable/entrypoint 在启动瞬间再次验证。
- [ ] `env` 覆盖只允许 profile 声明的 key 或 allowlist。
- [ ] 普通 `env` 才可持久化；`secretEnv` 只保存 `{provider,key,version}` 引用。首批 provider 为 Controller process environment 和权限受控 secret file。
- [ ] 调用时提交的临时 secret 是 write-only、不回显、不持久化；依赖临时 secret 的 run 在 daemon 重启后不能自动 retry，必须重新提交。
- [ ] 远端 secret 通过 mode `0600` 的短期 env file 交给 wrapper，启动后立即删除；文档明确同一远端用户仍可从 `/proc` 等位置观察进程环境，这是权限边界而不是可消除的秘密隔离。

- [ ] **P2-01-A1**：真实 Linux venv 中运行脚本，脚本打印 `sys.executable`、cwd、非秘密 env 和参数，全部与不可变 profile snapshot 一致；secret 仅断言存在，不输出值。

### P2-02 push phase 与 run revision

- [ ] 实现 `push` phase：按 profile 声明的本地源，经 TransferService 推送到 `remoteRoot`。`push` 默认 `true`（可由 profile 的 `defaultPush` 覆盖）。
- [ ] push 复用 P1-09 的批量/递归上传与 skip-if-identical；未变化的文件不重传。
- [ ] **push 失败绝不进入 preflight/launching**；错误对象指明失败文件与阶段。
- [ ] push 完成后对 entrypoint 做 stat + hash，连同已推送文件清单摘要记为该 run 的 revision，使事后可判断跑的是哪一版代码。
- [ ] `push: false` 时跳过该 phase，结果显式标注 `push: skipped` 及原因，并仍记录 entrypoint revision。
- [ ] 记录不可变 config revision、非秘密配置 snapshot 和 remoteRoot 根摘要；后续 launch/status/retry 不混读热更新配置。
- [ ] 为 P3-07 预留 `sync=flush` 的参数位与错误码，本阶段传入即返回 `SYNC_NOT_AVAILABLE`，不得静默忽略。

- [ ] **P2-02-A1**（黑盒）：修改本地脚本后直接调用 `workspace-run`，一次调用内完成推送并运行，远端输出新内容，revision 与推送后的真实 hash 一致。
- [ ] **P2-02-A2**（灰盒）：构造真实 push 失败（远端目录只读），远端不出现任何新进程，job 停在 `push` phase 且错误指明失败文件；`push: false` 时跳过推送、运行旧版本并在结果中标注 skipped。热重载配置不改变已创建 run snapshot。

### P2-03 持久远端 runner

- [ ] 每个 run 创建 `~/.handfree-runs/<runId>/` 或 profile 指定 state root。
- [ ] 写入 `meta.json/stdout.log/stderr.log/pid/heartbeat/exit.json`。
- [ ] 普通 Linux 使用独立进程组；支持的环境优先 `systemd-run --user`，Slurm profile 使用真实 job ID。
- [ ] 远端 wrapper 原子写状态；exit code 和 signal 都可恢复。
- [ ] 进程身份至少保存 remote boot ID、PID、PGID、`/proc` start ticks、随机 wrapper token 和 executable identity；systemd/Slurm 则保存唯一 scope/job ID。
- [ ] SSH 断开或 MCP adapter 重启不能自动杀死已成功启动的 durable run。
- [ ] Controller 重启后从远端状态恢复运行记录并校正数据库。

- [ ] **P2-03-A1**：启动 30 秒真实 Python 程序，关闭 adapter 和 daemon 后重启，仍能查询运行状态与增量日志，并最终获得真实 exit code。

### P2-04 Run logs、cancel 和 retry

- [ ] logs 使用 byte offset，处理 UTF-8 半字符，不重复、不跳字节。
- [ ] cancel 先向远端进程组发 TERM，等待 `graceMs`，仍存活再 KILL。
- [ ] cancel 前重新核对 boot ID/start ticks/wrapper token/scope；不匹配进入 `orphaned`，绝不向可能复用的 PID/PGID 发信号。
- [ ] 取消只影响指定 run，不得误杀同用户其他 Python 进程。
- [ ] retry 复制原 run 的非秘密 config snapshot，重新解析 secret reference；临时 secret 缺失时返回 `SECRET_REQUIRED`，生成新 runId 并记录 parentRunId。
- [ ] Slurm cancel 使用 `scancel <exactJobId>`；不允许模糊匹配进程名。

- [ ] **P2-04-A1**：真实子进程再派生孙进程，cancel 后整个目标进程组退出；无关同名进程保持运行。
- [ ] **P2-04-A2**：构造旧 PID identity 不匹配/PID reuse，cancel 进入 orphaned 且无关进程仍存活。

### P2-06 collect phase

按 5.8 的 collect 约束实现。

- [ ] 远端进程退出后，按 `collect.paths` 的显式 glob 拉回产物；未声明则跳过并标注。
- [ ] **禁止默认拉取整个 remoteRoot**；未声明 glob 时不得回退为「全拉」。
- [ ] 总字节上限与文件数上限；超限时 collect phase 失败并报告已拉取清单，不静默截断。
- [ ] run 失败或被取消时默认仍执行 collect，结果标注 run 终态；`collect: []` 可显式关闭。
- [ ] collect 失败不改写 run 的 exit code，作为独立子状态与错误对象呈现。
- [ ] 拉取走 Phase 1 TransferService，落地到 profile 声明的本地目录，复用路径策略与原子写。
- [ ] glob 解析相对 `remoteRoot`，复用 P1-02 的大小写语义与路径身份校验，拒绝逃逸。

- [ ] **P2-06-A1**（黑盒）：真实程序写出多个产物文件后退出，collect 按 glob 拉回，本地 SHA-256 与远端一致；未匹配 glob 的文件未被拉取。
- [ ] **P2-06-A2**（灰盒）：真实超限（产物总字节超过上限）时 collect 失败、已拉取清单准确、run 的 exit code 未被改写；run 被 cancel 后 collect 仍执行并标注 run 为 cancelled。
- [ ] **P2-06-A3**（白盒）：glob 相对化与逃逸拒绝为纯函数，穷举 value test，含 `..`、绝对路径、符号链接指向 root 外。

### P2-05 Workspace run tools

- [ ] 注册 `workspace-run/run-status/run-logs/run-list/run-cancel/run-retry`。
- [ ] 更新 `help`、README、README_CN 和 server instructions。
- [ ] Web/MCP 调用同一个 RunService，不复制业务逻辑。

- [ ] **P2-05-A1**：从真实 stdio MCP 完成 run start/status/log/cancel/retry，HTTP 尚未启用时也能全流程工作；响应的 `runId === jobId`。

- [ ] **PHASE-2-GATE**：一次 tool 调用完成 `push → preflight → launching → remote-running → collect` 全流水线；run 在 adapter 与 daemon 双重启后仍可查询与取消；phase 可见、失败按 phase 反序清理；通用 venv gate 必过，GPU/Slurm 等按已声明 C 类 adapter qualification 验收。常驻同步引擎的 `flush` 屏障不在本 gate 范围内。

## Phase 3：三模式同步引擎（Rev.3 暂缓，设计保留）

> 本阶段不在本轮交付范围。以下任务与验收项全部保留，供后续启动时直接使用。启动前需重跑 PHASE-1-GATE 与 PHASE-2-GATE 并按 7.2.1 补齐三盒验收项。

### P3-01 Sync profile 与 ignore

- [ ] 解析并严格验证 `syncProfiles`，包含 `direction`、`remoteScanInterval`、`conflict` 和双侧 `delete` 配置。
- [ ] `direction: pull|bidirectional` 未配置 `remoteScanInterval` 时启动即失败。
- [ ] daemon sync profile 的 `localRoot` 必须显式位于 server 的 `allowedLocalDirectories`；不得把任意 adapter cwd 作为共享 daemon 的新增权限。
- [ ] `remoteRoot` 必须在对应 `allowedRemoteDirectories` 内。
- [ ] 复用 P1-02 的路径身份、大小写探测、symlink 策略与 ignore matcher，不得再写一份。
- [ ] `direction` 热切换被拒绝；必须先 stop 该 profile，再以重建 base 的完整 reconciliation 重新 start。

- [ ] **P3-01-A1**：三种 direction 的配置各自 parse 成功；缺 `remoteScanInterval`、`delete.propagate` 与 `direction` 不相容（如 `direction: push` 配 `propagate: pull`）等组合在启动时即失败。

### P3-02 真实 watcher 与事件聚合

- [ ] 引入 Chokidar；锁定精确版本并记录许可证。
- [ ] 使用真实 OS watcher，不引入 fake watcher adapter 作为验收路径。
- [ ] 实现 add/change/unlink/addDir/unlinkDir 聚合、atomic-save 折叠、debounce 和 max-delay。
- [ ] 事件超过 `maxPendingEvents` 时折叠到受影响父目录；仍超限时标记 full reconciliation。
- [ ] watcher error/overflow 立即安排 full reconciliation。
- [ ] watcher 重启使用 1 分钟起步、最高 1 小时的指数退避；测试配置允许缩短时间但走同一代码路径。
- [ ] 即使 watcher 健康也执行周期 reconciliation。
- [ ] 忽略本服务生成的 temp 文件、`.handfree-trash` 和正在处理路径。
- [ ] `direction: pull` 时本地 watcher 仍可开启用于冲突检测，但绝不触发上传。

- [ ] **P3-02-A1**：真实编辑器式 `write temp -> rename` 只生成一次最终 upsert；短时间连续写不会上传半文件；制造超过阈值的真实事件后最终远端仍与本地一致。

### P3-03 双端 manifest 与 scanner

- [ ] 本地初扫保存 kind/size/mtime_ns/mode/hash/generation。
- [ ] 远端 scanner 按 `remoteScanInterval` 周期运行，复用 P1-03 的并发 walker 和 checker 预算。
- [ ] 两侧都先 quick-check（size + mtime）；只有 metadata 可疑时才 hash。远端 hash 优先用远端 `sha256sum`，不可用时回落到读取内容计算并记录降级。
- [ ] scanner 与 hasher 分开限流；hash worker 数量可配且有 CPU 上限。
- [ ] 扫描过程中任一侧文件 size/mtime 改变时放弃该结果并重新排队。
- [ ] manifest 更新与 job event 在同一事务边界内提交。
- [ ] `base_*` 仅在该路径双侧确认一致后推进；未完成/取消/校验失败的传输一律不推进 base。
- [ ] reconciliation 必须发现 watcher 漏掉的本地新增、修改和删除，以及周期扫描发现的远端新增、修改和删除。

- [ ] **P3-03-A1**：重启 daemon 不会重新 hash 全部未变化文件；通过真实 watcher 停止窗口制造漏事件后，periodic/manual rescan 能修复状态；在远端直接改文件后，一个 `remoteScanInterval` 内被发现。
- [ ] **P3-03-A2**：构造传输中途失败与取消，`base_*` 未被推进；重跑后该路径被正确识别为待同步而不是「对侧新增」。

### P3-04 原子增量应用

- [ ] 首次同步可用 archive，但 archive 解包后必须建立 manifest。
- [ ] 日常变化按文件传输，不重打整个 tar。
- [ ] 写入目标侧同目录 `.handfree-sync.<job>.<random>.tmp`；本地侧与远端侧使用同一套 temp/校验/替换协议。
- [ ] 校验 size/hash 后用原子 rename 替换（远端用 SFTP rename，本地用 `fs.rename`）。
- [ ] capability probe 验证目标平台的 rename-overwrite/`posix-rename` 行为；不支持安全原子替换时使用同目录 backup-swap，并在响应中标明降级，仍不允许暴露半文件。
- [ ] 在替换前对 temp 设置允许的 mode/mtime；metadata 失败按 profile 的 strictness 决定失败或警告，不能悄悄忽略。
- [ ] 失败保留旧正式文件；temp 受 TTL 清理并可用于后续恢复时必须先校验。
- [ ] mkdir 按目录深度分层，同层有界并发；两侧同规则。
- [ ] 文件传输与 checker 使用不同 semaphore，并受 P1-03 的 server budget 约束。

- [ ] **P3-04-A1**：远端观察进程持续读取目标文件，任何时刻只看到旧完整内容或新完整内容；传输中止时不出现部分正式文件。
- [ ] **P3-04-A2**：`pull` 方向下本地观察进程看到同样的原子性；中止时本地不出现半文件。

### P3-05 三模式规划器、冲突与双侧删除

- [ ] 按 5.6 决策表实现 `mode-planner`，纯函数、无 I/O、可穷举测试。
- [ ] `push` 永不写本地，`pull` 永不写远端；由类型系统或运行期断言强制，并有针对性测试。
- [ ] CONFLICT 按 `conflict.policy` 处理；`fail` 时记录冲突、跳过该路径、profile 进入 `conflict-blocked`，其余路径继续同步。
- [ ] `keep-both` 按 `keepBothSuffix` 生成双份并写 `sync_conflicts.artifact_path`；两份都必须是完整文件。
- [ ] 所有冲突（含自动解决）写入 `sync_conflicts` 并产生审计 event。
- [ ] file↔dir 类型变更按 `conflict.typeChange`，默认 fail，不允许被 `newer-wins` 之类策略静默处理。
- [ ] delete 默认关闭；`delete.propagate` 必须与 `direction` 相容，不相容组合在配置解析期失败。
- [ ] 开启后也必须先生成 plan，受双侧独立的数量/字节/百分比/epoch 上限保护。
- [ ] 删除在所有 upsert 成功后执行；目录最后删除。
- [ ] 首次允许 delete 时创建并持久化两侧 root UUID/volume identity/epoch；任一侧 root 不存在、权限拒绝、marker/volume identity 改变、扫描不完整或异常变空时禁止生成该方向的 delete plan。
- [ ] 本地删除默认 `backupBeforeDelete: true`，移入 `backupDir` 而非直接 unlink，并受 `backupRetention` 清理。
- [ ] delete 不能通过多轮 reconciliation 重置计数绕过 epoch 上限。
- [ ] 任一非空 delete plan 都需要基于精确 plan digest 的短期单次 approval token；超过任一绝对/百分比/epoch 阈值则硬失败，approval 也不能越过硬上限。任一侧文件列表或 generation 变化使 plan/token 失效。
- [ ] divergence 默认 `conflict-fail`；可选 `authoritative-overwrite` 或 `backup-then-overwrite`，必须在 plan 中逐项显示被覆盖的对侧修改。
- [ ] plan 必须携带 `remoteScannedAt`；apply 前若远端状态超过新鲜度阈值则强制重扫并使旧 plan 失效。

- [ ] **P3-05-A1**：穷举决策表的真实文件场景回放：对每个组合在真实两端构造状态、运行一次同步、断言最终两端状态与决策表一致。
- [ ] **P3-05-A2**：真实移走/拒绝访问 localRoot、替换 volume identity、异常空扫描和连续 reconciliation 均不删除任一侧文件。
- [ ] **P3-05-A3**：`bidirectional` 下同时修改同一文件两侧，`policy: fail` 产生冲突记录、两侧文件均未被覆盖、profile 进入 `conflict-blocked`，其余文件仍正常同步；`keep-both` 产生两份完整文件。

### P3-06 Sync tools 与恢复

- [ ] 注册 `sync-start/stop/pause/resume/flush/rescan/status/plan/approve-delete/apply-plan/conflicts/resolve-conflict`。
- [ ] `sync-flush` 等待当前 watcher batch、本地 scanner、必要的远端重扫、transfer 和 manifest commit 全部完成。
- [ ] `sync-rescan` 支持 `side: local | remote | both`。
- [ ] daemon 重启后恢复 `watching/paused` profile；中断中的传输重新 reconciliation，而不是盲目续写正式文件。
- [ ] 同一 profile 同时只有一个 mutating sync job；多个 status/plan/conflicts 可并发。
- [ ] 不同 profile 共享同一 server 时受 server channel budget 控制。
- [ ] MCP adapter 退出不停止 daemon watcher；daemon 重启后按 profile owner state 恢复 watcher并先 reconciliation。

- [ ] **P3-06-A1**：MCP 黑盒调用、adapter/daemon 分别重启、两侧真实文件变化、最终双端 tree hash 一致（`bidirectional`）或单侧权威一致（`push`/`pull`）全部通过。

### P3-07 回填运行任务的同步屏障

- [ ] 放开 `runProfiles.syncProfile`，`workspace-run` 默认执行 `sync=flush`。
- [ ] flush 成功后记录 manifest generation 和根摘要，替换 P2-02 的 stat+hash 简化 revision。
- [ ] flush 失败时不得启动远端程序。
- [ ] `sync=none` 仍允许，但必须由调用方显式指定，并在 run metadata 中标注未同步。
- [ ] 运行期间发生的新文件变化进入下一 generation，不改变已记录的 run revision。
- [ ] 更新 `help`、README/README_CN，移除 P2-02 期间的「不自动同步」提示。

- [ ] **P3-07-A1**：修改本地脚本后立即调用 `workspace-run`，远端运行输出新内容；构造同步失败时远端没有新进程；热重载配置不改变已创建 run snapshot。

- [ ] **PHASE-3-GATE**：`push`/`pull`/`bidirectional` 三种模式均可长期运行；watcher 丢事件、远端第三方修改、源根异常或 daemon 重启后仍能安全收敛；任一侧都不误删；冲突可被发现、记录和解决；运行任务的同步屏障生效。

## Phase 4：WebUI 和可选 Streamable HTTP MCP（Rev.3 暂缓，设计保留）

> 本阶段不在本轮交付范围。以下任务与验收项全部保留，供后续启动时直接使用。

### P4-01 SDK 安全升级

- [ ] 将 `@modelcontextprotocol/sdk` 从 1.17.5 升级到实施时最新、且不低于 1.26.0 的修复版本，并固定精确版本。
- [ ] 阅读对应 migration guide，更新 import/transport/schema，运行全部现有 MCP 黑盒测试。
- [ ] 不在多个 client/transport 间共享同一个 `McpServer` 或 StreamableHTTP transport；每个连接创建正确的 protocol server，业务状态只共享 Controller service。
- [ ] 添加依赖安全扫描，阻止回落到已知受影响范围。

- [ ] **P4-01-A1**：stdio MCP compatibility suite 通过，dependency audit 证明 SDK 不在已知受影响版本范围；升级记录包含 migration diff。

### P4-02 Streamable HTTP MCP transport

- [ ] 在 `/mcp` 提供可选 Streamable HTTP；默认关闭，与 `/api/v1` 明确分离。
- [ ] 每个 HTTP MCP session/连接创建独立 protocol server/transport，底层只共享 Controller client。
- [ ] 定义 session ID、认证、最大 body、请求超时、取消、SSE response、idle expiry 和 shutdown drain。
- [ ] 两个 client 使用相同 JSON-RPC request ID 时响应仍严格隔离。
- [ ] HTTP MCP 与 stdio MCP 使用同一 contracts/tool registration factory，不复制 schema。

- [ ] **P4-02-A1**：两个真实并发 HTTP MCP client 重复 request ID、交错长短请求和取消，结果不串线；关闭 session 后资源释放。

### P4-03 Web API 安全边界

- [ ] 默认只绑定 `127.0.0.1`。
- [ ] 首次启动生成随机 bearer token，token file 权限仅当前用户可读。
- [ ] 定义浏览器登录流程：`handfree-ssh-mcp web open` 只打开无凭据 URL，并在终端显示短时、单次 bootstrap code；用户在 UI 输入后换取 `HttpOnly + SameSite=Strict` 会话 cookie。code/token 不进入 URL、history、localStorage、sessionStorage 或页面日志。
- [ ] 用户直接访问 URL 使用相同输入页；bootstrap code 使用后立即失效。定义 logout、session expiry、token rotate/revoke、token file 丢失恢复。
- [ ] token file 原子创建并拒绝 symlink/reparse point，启动时验证 owner/ACL/权限。
- [ ] 验证 Host 和 Origin，防 DNS rebinding；所有 mutating API 校验 CSRF/origin。
- [ ] 日志和 API 自动遮盖 password、private key、passphrase、token 和完整环境秘密。
- [ ] 非 loopback bind 必须显式配置 TLS、allowedHosts 和认证，否则启动失败。
- [ ] API 只调用 Controller service；不能调用 shell 拼接 curl/CLI 绕过策略。

- [ ] **P4-03-A1**：无 bootstrap/session、重复 code、过期 code、错 Origin、错 Host、跨站 form、SSE 无认证均失败；正常 localhost UI 可用。

### P4-04 React 前端骨架

- [ ] 新建 `web/`：React + TypeScript + Vite + Tailwind CSS + shadcn/ui。
- [ ] production build 输出由 daemon 静态托管。
- [ ] 使用 TanStack Query 管理 server state；SSE 负责 event stream；只用轻量 store 保存 UI 临时状态。
- [ ] 提供连接断开、自动重连、`lastEventId` catch-up 和过期状态标记。
- [ ] 支持浅色/深色、桌面和窄屏；基础可访问性键盘操作通过。

- [ ] **P4-04-A1**：刷新页面后从持久 API 恢复状态；SSE 断线重连不重复、不丢失；cursor 过期时重新 snapshot。

### P4-05 页面功能

- [ ] Servers：连接、RTT、keepalive、状态、GPU、jump chain、reconnect/close。
- [ ] Sync：direction、watch/scanning/syncing/paused/conflict-blocked/error、pending、generation、两侧最后扫描时间、plan、flush、pause/resume/rescan。
- [ ] Conflicts：冲突列表、三态对比（base/local/remote）、take-local/take-remote/keep-both 操作。
- [ ] Runs：revision、环境、GPU、PID/job ID、stdout/stderr、cancel/retry。
- [ ] Transfers：strategy/engine、阶段、bytes、速度、ETA、stream/channel/connection、cancel。
- [ ] Explorer/Command：严格复用 SFTP path policy 和 command policy；默认不提供无约束交互 shell。
- [ ] 错误详情显示结构化 code、是否可重试、已执行清理和建议下一步。

- [ ] **P4-05-A1**：用真实 Controller snapshot/event 数据逐页完成核心操作；页面显示的 job state、actual transfer plan、冲突三态和日志 offset 与 API 一致。

### P4-06 Playwright 真实 E2E

- [ ] 启动真实 Controller、真实 Web production build、真实 OpenSSH fixtures。
- [ ] Playwright 操作 UI 创建同步、触发真实本地文件变化、在远端制造真实变更、解决一次真实冲突、启动真实 venv 程序、观察日志并取消。
- [ ] Playwright 发起真实 relay/direct transfer 并验证进度。
- [ ] 禁止 MSW、Nock、假 SSE、假 SSH 数据作为 E2E 验收。
- [ ] 收集页面 screenshot、console error、network failure 和浏览器覆盖率 artifact。

- [ ] **P4-06-A1**：`npm run test:e2e:web` 在 production UI + real Controller + OpenSSH lab 上 exit 0，artifact 落到 `artifacts/e2e-web/`。

- [ ] **PHASE-4-GATE**：用户可从 WebUI 完成与 MCP 相同的服务器、同步、运行和传输工作流，且两者共享同一真实状态。

## Phase 5：发布、迁移与运行验证

### P5-01 文档与 migration

- [ ] 更新 README/README_CN 的 v2 架构、Node 24 要求、daemon、配置、tools、安全模型和故障排查。
- [ ] 提供 1.x → 2.x migration：旧命令、旧 YAML、state directory、Web token、daemon 生命周期。
- [ ] 清楚区分 current fast、striped、relay、direct、archive、rsync delta。
- [ ] 明确说明三模式同步的语义边界：远端无 agent，远端变更靠 `remoteScanInterval` 周期发现，不是实时双向。
- [ ] 记录 Syncthing/rclone 设计来源和许可证边界，不复制 MPL 实现。
- [ ] 提供性能调优表，但只引用真实 benchmark 产物。

- [ ] **P5-01-A1**：`node scripts/validate-docs.mjs` 验证 README/README_CN 的 YAML、JSON 和 CLI 示例，链接 schema 与实际 tool registry 一致。

### P5-02 打包

- [ ] `npm pack --dry-run` 仅包含需要的 backend build、WebUI production assets 和许可证。
- [ ] 不包含测试密钥、Docker volume、SQLite state、token、日志、调研 clone、benchmark 大文件。
- [ ] 验证全新临时目录安装 tarball 后可启动 daemon、stdio MCP 和 WebUI。
- [ ] Windows 和 Linux 至少各完成一次 tarball smoke。

- [ ] **P5-02-A1**：同一 commit 的 Windows/Linux `artifacts/package-smoke/result.json` 均 PASS，tarball file manifest 无禁入内容。

### P5-03 发布门

- [ ] 所有 correctness、coverage、security、E2E、performance gates 通过。
- [ ] 生成版本变更记录和已知限制。
- [ ] 发布前再次检查 npm 身份、版本是否已存在、dist-tag；不得因计划存在自动发布。
- [ ] `npm publish`、Git commit、push、tag、GitHub Release 均需用户在对应阶段明确授权。
- [ ] 发布后验证 registry metadata、tarball 内容、integrity、`latest`/预发布 tag 和全新安装 smoke。

- [ ] **P5-03-A1**：发布前 `npm run test:release:verify-artifacts` exit 0；若用户授权发布，发布后生成 registry verification artifact。
- [ ] **PHASE-5-GATE**：迁移、文档、跨平台 package smoke 和发布前 gates 完成；发布动作本身只有得到当次授权才执行。

## 7. TDD 与真实测试政策

### 7.1 强制顺序

任务按类型提供证据：

- **行为变更/bug fix**：严格 RED → GREEN → REFACTOR；RED 必须失败于目标断言，而不是编译、端口或 fixture 错误。
- **characterization/refactor**：先建立 GREEN 行为基线，再重构并证明外部行为未变；不制造虚假 RED。
- **fixture/build/migration**：以 preflight failure、smoke failure 或 migration interruption 为起始证据。
- **文档/schema/example**：以 schema parse、链接、示例执行和 source-truth 检查为证据。
- **发布/授权**：以审计记录、artifact 和用户授权为证据，不要求 RED。

所有会改变运行行为的任务在适用时继续执行 REAL ACCEPTANCE、COVERAGE 和 1.x REGRESSION。

### 7.2 全真实执行，禁止 mock

**本项目新增与修改的代码一律禁止 mock。** 不使用 mock 库、不用 stub 替身、不 monkey-patch 被测对象的方法、不用 fake timer 推进时间。所有测试都必须驱动真实进程、真实文件系统、真实 SSH/SFTP 连接、真实子进程。

具体禁止：

- mock/fake SSH client 代替真实 OpenSSH；
- mock SFTP 代替真实字节传输；
- 猴子补丁替换 `openSftp`、`acquireSshClient`、`spawn` 等内部方法来制造分支；
- 手工调用回调代替真实事件；
- fake timer 代替真实等待；
- 手工写数据库行代替真实服务写入；
- fake SSE/API/MSW/Nock；
- 随机生成期望值后不核验最终文件内容；
- “调用返回成功”代替远端 PID、exit code、tree hash 和清理验证；
- localhost 吞吐代替 netem/WAN 条件 benchmark。

错误路径同样必须用**真实手段**制造，而不是打桩：只读目录造写失败、`chmod 000` 造权限拒绝、关闭容器造连接中断、`kill -9` 造崩溃、超大文件造超限、占用端口造绑定失败、写满 tmpfs 造磁盘满。若某条错误路径在真实条件下无法制造，必须在追踪矩阵中登记原因并给出替代的真实近似场景，不得用 mock 补齐。

允许：

- 对**纯函数**做白盒 value test（路径归一化、状态机转换、决策表、planner 决策、参数校验）——纯函数没有外部依赖，不涉及 mock；
- 临时目录中的真实文件；
- 固定 seed 生成的真实随机数据并核对最终 SHA-256；
- in-process MCP transport 验证 schema，但不能代替真实 stdio/SSH acceptance；
- 自建的**真实**测试服务器（如 `tests/helpers/real-ssh-server.ts` 这样跑真实 ssh2 Server、真实 SFTP、真实子进程的进程内服务），它不是 mock。

现有 `command-validation.test.ts` 等文件中的 legacy fake-client 测试属于技术债：本轮**不得新增**同类测试；被本轮改动触及的模块，其 fake-client 测试必须一并迁移到真实 SSH lab，迁移记录写入 journal。

### 7.2.1 黑盒 / 白盒 / 灰盒三盒要求

每个会改变运行行为的任务，验收项必须同时覆盖三类，缺一不可：

| 盒型 | 视角 | 本项目的具体形态 |
|---|---|---|
| **黑盒** | 只经公开入口，不看内部 | 经真实 stdio MCP 调用 tool，断言返回值 + 真实两端文件/进程的最终状态（SHA-256、tree manifest、exit code） |
| **白盒** | 直接测内部单元 | 纯函数穷举 value test（决策表、路径归一化、冲突检测、参数校验），要求分支全覆盖 |
| **灰盒** | 公开入口驱动，但观测内部不变量 | 真实调用的同时观测 SFTP channel 计数、并发峰值、phase 转换序列、连接池占用、清理残留、事件流顺序 |

灰盒的观测手段必须是**真实计数与真实状态**（如 `real-ssh-server.ts` 的 `stats.maxActiveWrites`、进程树快照、数据库实际行），不是打桩拦截。

验收项命名遵循 `P<phase>-<task>-A<n>` 并在括号标注盒型，例如 `P1-09-A2（灰盒）`。追踪矩阵校验脚本拒绝任何缺少三盒之一的行为变更任务。

### 7.3 覆盖率门槛

| 模块 | 行覆盖率 | 分支覆盖率 | 函数覆盖率 |
|---|---:|---:|---:|
| `contracts/**`（手写） | 95% | 95% | 95% |
| `controller/**` | 95% | 90% | 95% |
| `jobs/**` | 95% | 90% | 95% |
| `fspath/**` | 95% | 90% | 95% |
| `sync/**` | 90% | 85% | 90% |
| `sync/mode-planner.ts` | 100% | 100% | 100% |
| `run/**` | 90% | 85% | 90% |
| `transfer/**` | 90% | 85% | 90% |
| `connection/**` | 90% | 85% | 90% |
| `http/**` | 85% | 80% | 90% |
| WebUI | 80% | 75% | 85% |

后端覆盖率以 TypeScript source map 映射后的源码统计，固定使用 `c8`；include 为 `src/{contracts,controller,connection,jobs,fspath,transfer,sync,run,http}/**/*.ts`，只排除 `.d.ts`、`src/contracts/generated/**`、纯 type/barrel、测试和 build。手写 Zod refinement/状态转换必须计入。`c8` 必须覆盖 adapter 启动的 daemon 子进程并合并 `.coverage/backend/<platform>/` 原始 V8 coverage，不能只测 adapter。

`mode-planner.ts` 要求 100%：它是纯函数且组合有限，任何未覆盖分支都意味着存在一种未定义的同步行为。

WebUI 使用 Vitest Browser/coverage-v8 覆盖纯组件和真实 DOM 行为；API 连接页面的覆盖率来自 Playwright 对 instrumented production-like build 的 Istanbul coverage并映射回 TSX source map。最终由 `scripts/coverage-report.mjs` 合并但分别执行 backend/WebUI 阈值，不把一个模块的高覆盖率补给另一个模块。

平台专属分支由 Windows/Linux CI coverage artifact 合并。任何排除或不可达行写入 `coverage-waivers.json`，包含 source line、原因、风险、替代测试 ID、仓库维护者批准标识和过期日期；release verifier 只接受 CODEOWNERS/项目 owner 在同 commit 审批且未过期的 waiver，无 waiver 的未覆盖行不得忽略。

### 7.4 必须新增的可执行脚本

```json
{
  "preflight": "node scripts/preflight.mjs --require A",
  "test:unit": "npm run build && node scripts/test-runner.mjs unit",
  "test:acceptance:ssh": "node scripts/ssh-lab.mjs test ssh",
  "test:acceptance:transfer": "node scripts/ssh-lab.mjs test transfer",
  "test:acceptance:run": "node scripts/ssh-lab.mjs test run",
  "test:acceptance:sync": "node scripts/ssh-lab.mjs test sync",
  "test:e2e:web": "node scripts/web-e2e.mjs",
  "test:coverage": "node scripts/coverage-report.mjs --enforce",
  "bench:transfer:smoke": "node scripts/benchmark.mjs --profile smoke",
  "bench:transfer:qualify": "node scripts/benchmark.mjs --profile release",
  "bench:transfer:full": "node scripts/benchmark.mjs --profile full",
  "test:security": "node scripts/security-gate.mjs",
  "test:package": "node scripts/package-smoke.mjs",
  "test:release:local": "node scripts/release-gate.mjs --local",
  "test:release:verify-artifacts": "node scripts/release-gate.mjs --verify-artifacts",
  "test:release": "npm run test:release:local"
}
```

脚本契约：

- 所有 runner exit 0=通过、1=断言失败、2=缺失必需 capability、3=基础设施错误，并在 `artifacts/<gate>/result.json` 写相同分类。
- `test-runner.mjs` 读取显式 suite manifest，不依赖 Windows shell glob。
- `ssh-lab.mjs` 负责 Compose up、健康检查、执行和 finally cleanup；失败日志写 artifact。
- `release-gate --local` 超时 45 分钟，运行当前平台 A gates、真实 SSH acceptance、coverage、security、Web E2E、package smoke 和 performance smoke；performance smoke 只查功能/明显退化，不给出吞吐 qualification 结论。
- Windows/Linux CI matrix 分别运行 `test:release:local`，artifact manifest 包含 commit SHA、config fingerprint、runner image digest 和 SHA-256。
- `bench:transfer:qualify` 只在 Linux netem runner 运行并覆盖所有数值性能门；最长 3 小时。
- `bench:transfer:full` 为 nightly/manual 完整矩阵；不是每个 PR 或本地 release 的同步依赖。
- `test:release:verify-artifacts` 核对同一 commit 的 Windows、Linux、release benchmark，以及启用的 C 类 adapter qualification artifact。

本机验收入口是一条命令：

```powershell
npm run test:release
```

正式发布还必须在同一 commit 上执行并通过：

```powershell
npm run test:release:verify-artifacts
```

## 8. 性能基准与验收指标

### 8.1 测试矩阵

矩阵分层：

- PR/local smoke：10 ms、100 Mbps、0% loss；64 MiB 随机文件和 1,000×4 KiB。优化模式与同一 build 的 compatibility baseline 同场比较：单文件 baseline=`striped:off,current fast`，relay baseline=`single-stream current windowed`，碎文件 baseline=`checkers:1,transfers:1`；median 不得退化 20% 以上。smoke 只发现明显退化，不形成正式吞吐结论。
- release qualification：覆盖下述每条数值门所需的 50 ms/1 Gbps/0% loss，加 100 ms/100 Mbps/0.1% loss 容错点；后者只要求完成、hash 正确、无死锁、重试/清理符合矩阵，不设置额外吞吐下限。
- nightly/full：下面 RTT × bandwidth × loss × 全数据 × 全模式的完整矩阵。

网络：

- RTT：1、10、50、100 ms；
- 带宽：100 Mbps、1 Gbps、无限制；
- 丢包：0、0.1%；
- direct 和 relay 分开塑形两条腿。

数据：

- 1 × 1 GiB 不可压缩随机文件；
- 1 × 1 GiB 可压缩文件；
- 10,000 × 4 KiB；
- 1,000 × 1 MiB；
- 同尺寸内容改变；
- 只改变 1 GiB 文件中间 1 MiB；
- 深层目录、空目录、Unicode、长文件名和 symlink policy。

模式：

- buffered；
- current fast；
- striped；
- current windowed relay；
- multi-channel relay；
- direct rsync/rclone/tar-ssh；
- archive none/gzip/zstd；
- watcher incremental（push / pull / bidirectional）。

### 8.2 同场相对门槛

统一统计方法：每个 case 先 warm-up 1 次，不计结果；随后运行 5 次。吞吐以 5 次 median 判定，watcher latency 至少收集 100 次稳定写入并计算 p95。断言失败或 hash mismatch 直接失败。coefficient of variation 超过 15% 时整组最多重新调度 2 次并保留全部样本；第三组仍不稳定则 exit 3/`INFRASTRUCTURE_ERROR`，阻止发布但不记为实现断言失败。

- 50 ms/1 Gbps、1 GiB 随机文件：striped download/upload 至少达到 current fast 的 1.8×，或达到整形带宽 70%，满足其一。
- 双腿 50 ms/1 Gbps relay：multi-channel relay 至少达到同场 current windowed relay 的 1.5×，或达到较慢腿整形带宽的 70%，满足其一。
- direct 传 1 GiB：Controller relay data bytes 必须为 0；控制和日志流量小于 1 MiB；目标 SHA-256 相同。
- 单个稳定写入的代码文件，在 10 ms RTT fixture 中，从 watcher stable event 到远端 atomic commit 的 p95 小于 2 秒。
- `pull` 方向的远端变更发现延迟以 `remoteScanInterval` 为上界，不设更严格的吞吐门；只断言在一个 interval 加一次扫描时长内被发现并应用。
- 10,000 个 4 KiB 首次传输：用固定 qualification corpus 离线生成 capability/profile 选择表；auto planner 的 5 次 median 不得慢于同场枚举可用模式中最佳 median 的 20% 以上。planner 本身不得为每次生产传输先完整跑一遍所有模式。
- 未变化目录二次 reconciliation：不得传文件内容；网络只包含 metadata/必要 hash 请求。
- 任意失败/取消：无正式部分文件、无遗留活跃 worker、无未关闭测试连接；temp 按策略清理或标记可恢复。
- RSS：每个 case 在连接建立且 transfer 前采样 5 秒 median 作为 baseline；传输期间每 100 ms 采样 Controller process tree 峰值。`peak - baseline` 不得超过 `maxBufferBytes × 1.25 + 64 MiB`。external engine 的 process tree RSS 单独报告，不混入 builtin engine gate。

### 8.3 报告格式

每次 benchmark 输出机器可读 JSON 和 Markdown：

```text
commit / Node / OS / CPU / cipher
source/destination filesystem
RTT / bandwidth / loss
engine / strategy / actual streams / requests / chunk
connect/stat/hash/list/mkdir/transfer/verify time
bytes / mean / p50 / p95 / peak speed
CPU / RSS / retries / errors
source and destination SHA-256
```

没有以上上下文的单个 MB/s 数字不得写进 README。

## 9. 安全要求

威胁模型：path policy 防配置错误、静态 traversal、静态 symlink/junction/reparse escape 和非授权 Web/API 调用；不声称能抵御已经拥有同一本地或远端 OS 账户文件权限的恶意进程在检查与使用之间持续替换目录。对可检测 race，文件 handle identity 前后不一致即中止并重扫；强敌对多租户环境必须使用服务端 chroot/container/独立账户作为真正隔离边界。

- 所有 local/remote path 在业务 service 内再次验证，不能只依赖 MCP schema。
- WebUI 和 external engine 不得绕过 command policy 或 SFTP path policy。
- 运行 profile 是管理员配置的能力边界；`workspace-run` 不能退化为另一个 unrestricted shell。
- 参数使用 argv/结构化 quoting；无法避免 shell 时使用经过测试的 POSIX/PowerShell quoting helper。
- `pull` 与 `bidirectional` 会修改和删除本地文件，属于新的破坏面：本地删除默认先备份，且与远端删除使用同等的 plan/approval/上限保护。
- direct 必须 pin destination host key。
- agent forwarding 默认关闭并显示风险；禁止把 private key 上传到 source。
- Web token、SSH password/passphrase、private key、env secret 不写日志、数据库 event payload、URL、命令行或浏览器 localStorage。
- SQLite、token、socket/pipe、日志和 run metadata 使用当前用户最小权限。
- 双侧 delete、overwrite、冲突自动解决、cancel 和 direct receiver 均有结构化审计 event。
- localhost HTTP 实现 Host/Origin 校验和 DNS rebinding 防护。
- MCP SDK 升级到安全修复版本后才能启用 Streamable HTTP。
- 外部工具版本和输出均视为不可信输入；解析必须有大小上限和超时。

## 10. 故障恢复与回滚

### 10.1 任务级恢复

- transfer：默认重新规划；只有明确设计了安全 checkpoint 的 striped temp 才允许续传。
- run：从远端 `pid/heartbeat/exit.json` 恢复，不因本地状态缺失重复启动。
- direct：远端命令状态不明时先查询 source/destination temp 和进程，禁止直接重试覆盖。
- sync：重启后 reconciliation，以 manifest 和实际两端状态重新规划；不盲信旧 watcher 队列；`base_*` 未推进的路径重新进入待同步而不是被当作对侧新增。

### 10.2 发布回滚

- 1.x 配置保留；v2 数据库使用独立 schema/version。
- v2 daemon 不可用时可显式 `daemonMode: embedded` 使用兼容 stdio 功能，但 sync/run 持久性降级必须明确提示。
- 数据库 migration 前创建一致性备份；migration 失败时拒绝启动 mutating service，允许只读诊断。
- WebUI 是可选模块；其失败不能阻止 stdio MCP 基础 SSH 功能启动。
- striped/direct capability 失败自动回退 current fast/relay；强制模式除外。
- `bidirectional` 出现无法自动解决的冲突时降级为 `conflict-blocked` 并停止该 profile 的 mutating 操作，而不是继续用某一侧覆盖对侧。

## 11. 风险登记

| 风险 | 影响 | 控制措施 |
|---|---|---|
| 现有工作树有大量未提交 transfer 变更 | 新重构覆盖用户工作 | P0 先建可恢复检查点；小步提取；每步比较 diff |
| 基线测试在 Windows 上已有 5 个失败 | 新功能 RED/GREEN 判定被污染 | P0-01 先修复或正式归因，写入 `artifacts/baseline/` |
| `SSHConnectionManager` 过大 | 覆盖率虚高/低、职责耦合 | 先 characterization，再逐模块抽取，保持 facade |
| Node `node:sqlite` 仍处 release-candidate 稳定级别 | API/行为变化 | 锁定 Node 24 最低小版本，封装 `JobStore` 接口，数据库兼容测试 |
| 多连接随机写不被部分 SFTP server 支持 | 文件损坏 | temp-file capability probe、缓存、auto fallback、最终 hash |
| watcher 漏事件/溢出 | 本地状态漂移 | periodic reconciliation、overflow full scan、restart backoff |
| 远端无 agent，只能周期扫描 | 远端变更发现有延迟，用户误以为实时 | 文档明示语义；plan 携带 `remoteScannedAt`；apply 前强制刷新 |
| `bidirectional` 冲突处理错误 | 用户改动被静默覆盖 | 三态 base 模型、决策表 100% 覆盖、默认 `policy: fail`、全部冲突写审计 |
| `base_*` 在失败传输后被错误推进 | 后续同步方向判断整体错乱 | 只在双侧确认一致后推进；P3-03-A2 专项测试 |
| `pull`/`bidirectional` 删除本地文件 | 用户工作目录数据丢失 | 默认关闭、先备份到 `backupDir`、双侧独立上限、plan + approval |
| 同步删除配置错误 | 大规模数据删除 | 默认关闭、plan、数量/字节上限、先 upsert 后 delete |
| agent forwarding 被源主机滥用 | 凭据签名风险 | 默认关闭、显式 route、host pin、短生命周期、审计 |
| remote run SSH 断开后状态不明 | 重复运行或孤儿进程 | durable remote wrapper、runId、PID/heartbeat/exit 恢复 |
| Phase 2 期间无自动同步屏障 | 用户以为跑的是新代码 | `sync=none` 显式标注、revision 记录 entrypoint hash、文档明示 |
| MCP HTTP 多客户端实例复用 | 响应串线/数据泄漏 | SDK 修复版本、每连接 server/transport、Controller 仅共享业务层 |
| WebUI 泄露凭据或被跨站调用 | 主机控制权泄露 | loopback、token、Host/Origin/CSRF、redaction、禁 localStorage secret |
| 并发过大耗尽 sshd MaxSessions | 全部任务卡死 | per-server channel/connection budget、backpressure、自适应降级 |
| 性能测试环境噪声 | 错误结论和 flaky CI | 同机同场相对 baseline、多次采样、保存环境与原始 JSON |

## 12. Requirements-to-tests 追踪矩阵

每个 canonical RT-ID 的结果写入 `artifacts/results/<rt-id>.json`，至少包含 `commit/instanceId/configRevision/platform/capabilities/command/startedAt/duration/assertions/artifacts/status`。`status` 只能为 PASS/FAIL/NOT_APPLICABLE；NOT_APPLICABLE 必须符合 P0-00 政策。

| 测试 ID | 必测真实场景 | 主要验收/产物 |
|---|---|---|
| RT-PREFLIGHT-01 | A/B/C capability 分类与 exit code | P0-00-A1 |
| RT-BASELINE-01 | 现有 build/test/coverage/pack 基线与 Windows tar 回归归因 | P0-01-A1 |
| RT-CHECKPOINT-01 | 经授权检查点与临时副本 restore drill | P0-01-A2 |
| RT-SSHLAB-01 | 两个真实 OpenSSH/SFTP endpoint 与 SHA-256 | P0-02-A1 |
| RT-CONTRACT-01 | config/IPC/HTTP/tool schema example round-trip | P0-03-A1，schemas/OpenAPI |
| RT-CONTRACT-02 | 三模式决策表穷举与方向写入约束 | P0-03-A2 |
| RT-FACADE-01 | 1.x tool/response/错误兼容与真实 SSH characterization | P0-04-A1 |
| RT-DB-01 | 磁盘 DB reopen、WAL、event cursor | P0-05-A1 |
| RT-DB-02 | migration 中断、磁盘满、future schema、restore | P0-05-A2 |
| RT-IPC-01 | adapter 中断、daemon 存活、重连 catch-up | P0-06-A1 |
| RT-IPC-02 | 两个 instanceId 并存及 fingerprint mismatch | P0-06-A2 |
| RT-METRICS-01 | 真实 transfer 单调 bytes、阶段、失败/取消 metrics | P1-01-A1 |
| RT-PATH-UNIX-01 | Unix symlink/glob/identity change/root escape | P1-02-A1 的 Linux artifact |
| RT-PATH-WINDOWS-01 | Windows junction/reparse/glob/identity change/root escape | P1-02-A1 的 Windows artifact |
| RT-CHECKERS-01 | 10,000 碎文件 checker/walker 性能与 hash | P1-03-A1 |
| RT-STRIPE-DOWNLOAD-01 | netem 多连接 download、RSS、SHA-256 | P1-04-A1 |
| RT-STRIPE-01 | OpenSSH random WriteAt 与不兼容 SFTP gateway | P1-05-A1 |
| RT-RELAY-01 | 双腿 netem、多通道、内存 budget、hash | P1-06-A1 |
| RT-EXTERNAL-01 | external engine probe/secret/exit/timeout/cancel | P1-07-A1 |
| RT-DIRECT-01 | rsync direct、Controller data=0、hash | P1-08-A1 |
| RT-DIRECT-02 | route/auth/host-key fail、Controller crash、unknown outcome | P1-08-A1/A2 |
| RT-XFER-01 | source read error、destination write error、SSH 两腿分别断开 | job state、连接清理、正式文件安全 |
| RT-XFER-02 | cancel 分别发生于 stat/hash/pack/transfer/verify/extract | 每 phase cleanup matrix |
| RT-BATCH-01 | 批量上传 12 文件真实传输、skip、CRLF、逐文件状态 | P1-09-A1（黑盒） |
| RT-BATCH-02 | 真实只读目标造中途失败，abort/continue 两种语义 | P1-09-A2（灰盒） |
| RT-BATCH-03 | basename 冲突/重复/上限穷举，且远端零写入 | P1-09-A3（白盒） |
| RT-RUN-01 | 真实 venv、环境预检、配置热更新不影响 snapshot | P2-01-A1 |
| RT-RUN-PUSH-01 | 一次调用完成推送并运行，revision 与真实 hash 一致 | P2-02-A1（黑盒） |
| RT-RUN-PUSH-02 | 真实 push 失败不启动远端进程；`push:false` 跳过并标注 | P2-02-A2（灰盒） |
| RT-RUN-COLLECT-01 | 产物按 glob 真实拉回、SHA-256 一致、未匹配者不拉 | P2-06-A1（黑盒） |
| RT-RUN-COLLECT-02 | 真实超限失败、exit code 未被改写、cancel 后仍收集 | P2-06-A2（灰盒） |
| RT-RUN-COLLECT-03 | glob 相对化与逃逸拒绝穷举 | P2-06-A3（白盒） |
| RT-RUN-02 | adapter/daemon 重启、远端继续运行、日志 offset | P2-03-A1 |
| RT-RUN-03 | TERM grace、KILL、子孙进程、PID identity mismatch | P2-04-A1/A2 |
| RT-RUN-MCP-01 | 真实 stdio MCP 的 run 全流程与 ID 一致性 | P2-05-A1 |
| RT-SYNCCFG-01 | 三种 direction 配置解析与不相容组合拒绝 | P3-01-A1 |
| RT-WATCH-01 | add/change/atomic rename/delete burst | P3-02-A1 |
| RT-WATCH-02 | watcher 停止窗口、overflow、restart backoff、full scan | P3-02-A1、P3-03-A1 |
| RT-REMOTESCAN-01 | 远端第三方修改在一个 interval 内被发现 | P3-03-A1 |
| RT-BASE-01 | 传输失败/取消后 base 未推进，重跑判定正确 | P3-03-A2 |
| RT-SYNC-01 | source read error、变化中源文件、destination write error | 正式文件保持旧完整内容 |
| RT-SYNC-02 | hash mismatch、rename failure、metadata failure | temp/backup cleanup 与结构化错误 |
| RT-SYNC-PULL-01 | `pull` 方向本地原子写与本地半文件检查 | P3-04-A2 |
| RT-SYNC-MODE-01 | 决策表全组合真实文件回放，三方向最终态一致 | P3-05-A1 |
| RT-SYNC-03 | 任一侧 root 消失、权限拒绝、volume identity 改变、异常空扫 | P3-05-A2，两侧零删除 |
| RT-SYNC-BIDI-01 | 双侧同时修改、delete-vs-modify、both-created、类型变更 | P3-05-A3 |
| RT-SYNC-DELETE-LOCAL-01 | 本地删除的备份、上限、approval 与 epoch 累积 | P3-05-A2/A3 |
| RT-SYNC-04 | daemon 强杀、重启、reconciliation | P3-06-A1，最终 tree hash |
| RT-RUN-SYNC-01 | 同步屏障生效、flush 失败不启动、generation 记录 | P3-07-A1 |
| RT-SDK-01 | 修复版 SDK、stdio 兼容和 dependency audit | P4-01-A1 |
| RT-HTTP-01 | duplicate request ID、并发、取消、session close | P4-02-A1 |
| RT-WEBSEC-01 | bootstrap replay/expiry、Host/Origin/CSRF/SSE auth | P4-03-A1 |
| RT-WEB-STATE-01 | snapshot、SSE catch-up、cursor expiry | P4-04-A1 |
| RT-WEB-PAGES-01 | 页面操作与 Controller/API 状态一致，含冲突三态 | P4-05-A1 |
| RT-WEB-01 | production UI + real Controller/SSH full workflow | P4-06-A1 |
| RT-DOCS-01 | README/README_CN schema/example/link validation | P5-01-A1 |
| RT-PACKAGE-WINDOWS-01 | Windows tarball manifest/install smoke | P5-02-A1 的 Windows artifact |
| RT-PACKAGE-LINUX-01 | Linux tarball manifest/install smoke | P5-02-A1 的 Linux artifact |
| RT-RELEASE-01 | 同 commit artifact verification 与可选 registry verify | P5-03-A1 |
| RT-GPU-01 | 指定 GPU runner 上 CUDA probe、visible device、禁止 CPU fallback | C 类 qualification artifact，仅发布 GPU adapter 时必需 |
| RT-SLURM-01 | 指定 Slurm runner 上 submit/status/log/cancel | C 类 qualification artifact，仅发布 Slurm adapter 时必需 |

P*-A* 是任务内验收标签，RT-* 是唯一 canonical 测试结果 ID；每个 P*-A* 必须映射至少一个 RT-*，`scripts/validate-traceability.mjs` 从计划/manifest 验证双向映射且拒绝孤儿 ID。PHASE-*-GATE 是聚合门，不单独生成测试结果，它要求该 phase 映射的 RT-* 满足下述规则。

新增故障模式必须先在此矩阵增加 test ID，再修改实现。不能用“已检查所有错误路径”这类无限范围描述代替封闭矩阵。

## 13. Definition of Done

一个 phase 只有同时满足以下条件才可标记完成：

- [ ] 本 phase 所有任务与验收项勾选，并链接对应 commit、测试日志或 artifact。
- [ ] 适用的行为变更有 RED 目标断言证据，GREEN 后通过；refactor/fixture/doc/release 按 7.1 的对应证据类型验收。
- [ ] 新功能至少有一条真实黑盒路径，不依赖 mock。
- [ ] 追踪矩阵中属于本 phase 的 test ID 全部 PASS；真实数据按表中 SHA-256/tree manifest/exit identity 核验。
- [ ] 新模块达到覆盖率门槛，未覆盖行经过逐项审查。
- [ ] 现有 1.x regression 全部通过。
- [ ] 追踪矩阵列出的失败、取消、超时、重启和清理注入点均实际执行。
- [ ] 文档、help、schema、README/README_CN 与实际行为一致。
- [ ] `git diff --check` 无错误。
- [ ] `npm pack --dry-run` 无秘密、测试数据、临时文件或调研 clone。
- [ ] 未经授权不执行 Git commit/push/tag、npm publish、远端部署或系统服务安装。

项目最终完成条件：

1. 高 RTT 大文件和碎文件通过 8.2 的固定统计方法与数值门，不使用“感觉更快”作为结论。
2. 两远端满足条件时 direct 数据不经过 Controller；不满足时 auto 明确回退 relay。
3. `workspace-run` 能使用真实远端 venv 启动，并在本地重启后继续查询和取消；GPU/Slurm 等已发布 adapter 分别有绑定同一 commit 的专用 qualification artifact。
4. 修改文件后能由 daemon 在 `push`、`pull`、`bidirectional` 三种模式下自动、原子、增量同步；`bidirectional` 的冲突可被发现、记录并按配置解决；任一侧都不会在未经 plan 与授权的情况下删除文件。
5. `workspace-run` 的同步屏障生效：flush 失败不启动，run revision 可追溯到确切的 manifest generation。
6. WebUI 和 MCP 对同一 job 显示一致状态，实时事件可断线续传。
7. `npm run test:release` 完成本平台 gate，`npm run test:release:verify-artifacts` 验证同 commit 的跨平台、release benchmark 和已启用 C 类 qualification。

## 14. 实施检查清单总览

本轮（Rev.3）交付：

- [ ] Phase 0：preflight、基线修复（Windows tar）、真实 SSH lab、契约、模块化、JobStore/EventBus、Controller daemon。
- [ ] Phase 1：TransferMetrics、路径身份基座、批量上传、checker/walker、striped upload/download、multi-channel relay、external engines、direct planner。
- [ ] Phase 2：workspace-run 全流水线 `push → preflight → launching → remote-running → collect`、持久 runner、logs/cancel/retry。
- [ ] Phase 5（部分）：已交付功能的文档、打包、跨平台 smoke、经授权发布。

暂缓（设计保留，不在本轮实施）：

- [ ] Phase 3：三模式同步（push/pull/bidirectional）、双端 manifest、watcher、冲突解决、双侧删除保护、同步屏障回填。
- [ ] Phase 4：SDK 安全升级、Web API、React/shadcn/Tailwind、Playwright E2E。

建议从 `P0-00` 开始，不跨 phase 并行修改同一核心文件。允许并行的工作只有已经拥有稳定接口的独立任务，例如真实 SSH fixture；Phase 2 与 P3-01..P3-06 可在 PHASE-1-GATE 之后由不同工作树并行；WebUI 视觉骨架必须等 P0-03 contracts 稳定后开始。任何会改变 Controller、Job、Transfer 接口的工作必须先完成其前置阶段。
