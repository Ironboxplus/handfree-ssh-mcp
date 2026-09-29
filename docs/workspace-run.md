[← Back to README](../README.md)

# workspace-run (remote runner)

Launches an entrypoint on a remote server. **No YAML configuration is required** — pass `remoteRoot` plus `venv` (or `executable`) inline and it runs against any enabled server, including ones that come from `~/.ssh/config`:

```json
{ "tool": "workspace-run", "params": {
  "server": "gpu-box", "remoteRoot": "/data/proj", "venv": "/data/envs/proj",
  "entrypoint": "train.py", "args": ["--epochs", "3"]
} }
```

Inline runs allow any safe relative `entrypoint` under `remoteRoot` (`..`, absolute paths and drive letters are still rejected), accept any `env` keys, default `push` to **false** (the code is assumed to already be under `remoteRoot`; pass `pushPaths` to upload it), and take `collectLocalDir` as the local destination for `collect`.

A `runProfiles.<name>` entry declared in your YAML config (see [YAML Config Reference](configuration.md#yaml-config-reference)) is an optional **saved preset** for those same fields — worth configuring when you launch the same job repeatedly, or when you want to *narrow* what may run (`allowedEntrypoints`) or which `env` keys may be overridden. It is not a prerequisite.

The launched process is detached from the SSH session (its own process group, `setsid`) and writes its own state atomically to `~/.handfree-runs/<runId>/meta.json` / `stdout.log` / `stderr.log` / `pid` / `heartbeat` / `exit.json` on the remote filesystem. There is **no local job store or daemon** — an MCP adapter restart loses nothing because it held nothing, but this also means status/logs/cancel require the remote server to be reachable; there is no offline/cached view of run state.

The full pipeline is `[push] → preflight → launching → remote-running → [collect]`:

```json
{ "tool": "workspace-run", "params": {
  "profile": "qwen-dev", "entrypoint": "train.py", "args": ["--epochs", "3"]
} }
{ "tool": "run-status", "params": { "runId": "run_20260915T120000Z_ab12cd34" } }
{ "tool": "run-logs", "params": { "runId": "run_20260915T120000Z_ab12cd34", "offset": 0 } }
{ "tool": "run-list", "params": { "profile": "qwen-dev" } }
{ "tool": "run-cancel", "params": { "runId": "run_20260915T120000Z_ab12cd34" } }
{ "tool": "run-retry", "params": { "runId": "run_20260915T120000Z_ab12cd34" } }
```

- **`push`** uploads the push sources (files and/or directories) to `remoteRoot` before launch, over the same batch/recursive upload used by `upload`/`transfer` — skip-if-identical, so an unchanged file is not re-transferred. Sources are `runProfiles.<name>.push.paths` for a saved profile, or `pushPaths` inline. It defaults to `true` for a profile that declares `push.paths` (or its `defaultPush`) and to `false` for an inline run with no `pushPaths`. Turning push on with no sources fails with `INVALID_CONFIGURATION` before touching the network. Pass `push: false` to skip it and use code already present under `remoteRoot`. A push failure never reaches the launching phase; the error names the failing file/directory and the phase. After push (or when skipped), the entrypoint is stat'd and content-hashed on the remote and recorded, together with a digest of the pushed file list, as the run's `revision` — so you can tell afterwards which code actually ran.
- **`collect`** (default the profile's `collect.paths`) pulls artifacts back by explicit glob (relative to `remoteRoot`) after the run finishes, into `runProfiles.<name>.collect.localDir` (or `collectLocalDir` inline) — it **never** defaults to pulling the whole `remoteRoot`. A local destination is required whenever `collect.paths`/the `collect` param is non-empty. Requesting collect (whether via the profile default or explicitly) makes the `workspace-run` call **block** (bounded by `timeout`, default the profile's `timeout` or 10 minutes) until the run reaches a terminal state, then collects — a plain launch with no collect requested still returns immediately once the process is confirmed started, unchanged. Enforces a total byte cap and file-count cap (`collect.maxBytes`/`collect.maxFiles`); exceeding either fails the collect phase and reports exactly what was already pulled — no silent truncation. Collect still runs by default even when the run failed or was cancelled (logs/partial artifacts are diagnostic material); a collect failure never rewrites the run's own exit code, it is reported separately (`details.collect`). Pass `collect: []` to disable collect for a call. Glob matching rejects `..`, absolute paths, and never traverses a symlink.
- `sync: "flush"` — the persistent sync barrier (Phase 3, not this round). Only `"none"`/omitted works; `"flush"` returns `SYNC_NOT_AVAILABLE`.
- `environment.type: conda | module | slurm`, `gpu.required`, and `secretEnv` — parse successfully in config but are rejected at launch time with `ENVIRONMENT_ADAPTER_NOT_AVAILABLE` / `GPU_VALIDATION_NOT_AVAILABLE` / `SECRET_ENV_NOT_AVAILABLE`. Only `environment.type: venv` (invokes `<path>/bin/python` directly, never `source activate`) and `environment.type: executable` are supported.

`run-cancel` sends `TERM` to the run's whole remote process group, waits `graceMs` (default 5000), then `KILL` if it's still alive. Before signalling anything it re-verifies the recorded process identity (remote boot id, pid, pgid, `/proc` start ticks, and a wrapper token read back from the live process's own environment) against what is actually running right now; a mismatch (pid reuse, host reboot) moves the run to `orphaned` instead of risking a signal to an unrelated process.

`run-retry` launches a fresh run from an **earlier run's own stored config snapshot** (its `meta.json`, read over SFTP) rather than the live `runProfiles` config — so a config hot-reload or a since-deleted profile cannot change what actually gets retried. It gets its own new `runId` and records `parentRunId`; the original run is untouched. Returns `RETRY_SNAPSHOT_UNAVAILABLE` for a run launched before this snapshot feature existed, and `SECRET_REQUIRED` if the snapshot declares `secretEnv` (not re-resolvable this delivery round).
