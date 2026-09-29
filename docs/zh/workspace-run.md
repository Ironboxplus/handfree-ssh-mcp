[← 返回 README](../../README_CN.md)

# workspace-run（远程运行）

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
