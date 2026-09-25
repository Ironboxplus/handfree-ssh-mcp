# 🤖 handfree-ssh-mcp

**Configure once. Let the LLM handle the rest.**

> 🧪 99.9% AI-coded [Include this Readme]. No artisanal hand-crafted code here.

A hands-free SSH automation tool via MCP. Fork of [ssh-mcp-server](https://github.com/classfang/ssh-mcp-server) designed for autonomous AI agent operations.

## 🎯 Philosophy

The original ssh-mcp-server requires passing credentials and options via CLI arguments every time. That's tedious.

**handfree-ssh-mcp** takes a different approach:

1. **Reuse your existing `~/.ssh/config`** automatically, or configure servers once in YAML
2. **Set command policies** per server through a YAML overlay
3. **Let the LLM call whatever it needs** - hands-free

Less manual interventions. Just autonomous SSH execution with safeguards.

## ✨ What's New

| Feature | Original | handfree-ssh-mcp |
|---------|----------|------------------|
| Configuration | CLI args | **OpenSSH `~/.ssh/config` + optional YAML overlay** |
| Multi-server | Messy `--ssh` flags | **Clean YAML structure** |
| Command policy | Single comma-separated whitelist | **Blacklist mode by default, optional whitelist mode** |
| Streaming | Not supported | **Real-time output with `stream` param** |
| Discoverability | None | **`show-whitelist` tool for LLM** |

## 🚀 Quick Start

### 1. Use your existing `~/.ssh/config`

If you already have:

```sshconfig
Host dev
  HostName 192.168.1.100
  User root
  IdentityFile ~/.ssh/id_ed25519
```

you can start the MCP without a YAML file:

```json
{
  "mcpServers": {
    "ssh": {
      "command": "npx",
      "args": ["-y", "@aaarc/handfree-ssh-mcp", "--enable-servers", "dev"]
    }
  }
}
```

`--enable-servers` is optional. If you omit it, every concrete `Host` entry loaded from `~/.ssh/config` (plus YAML entries, if any) is enabled.

### 2. Optional: create `servers.yaml` for policies or overrides

```yaml
sshConfig: true  # default; loads ~/.ssh/config before applying this YAML

servers:
  dev:  # Server name - use this in --enable-servers
    # host / port / username / privateKey can be omitted when dev exists in ~/.ssh/config.
    # Values here override the OpenSSH config entry when present.
    # commandMode defaults to blacklist: commands are allowed unless they
    # match the built-in dangerous blacklist or a pattern below.
    blacklist:
      - "^docker system prune.*$"

  prod:
    host: XXXXX
    port: 22
    username: deploy
    privateKey: ~/.ssh/id_rsa
    commandMode: whitelist
    whitelist:
      - "^ls.*$"        # Read only
      - "^cat.*$"
      - "^tail.*$"
    blacklist:
      - "^rm.*$"        # Never allow delete
      - "^shutdown.*$"
      - "^reboot.*$"
```

### 3. Add to MCP Config

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

### 4. Done. Let the LLM Work.

The AI can now execute commands on your servers. All within your defined security boundaries.

---

## 🛠️ Available Tools

| Tool | Description |
|------|-------------|
| `execute-command` | Run SSH command (with optional `stream` for real-time output) |
| `show-whitelist` | Show active command policy + SFTP policy + output-log path for a server |
| `close-connection` | Close a cached SSH connection for a server |
| `upload` | Upload local file(s) to a remote server (CRLF-fix for shell scripts, skip-if-identical, optional `reuseConnection`, `vvv`, `fast`; `localPath` accepts an array for batch upload — see [Upload behaviors](#upload-behaviors)) |
| `download` | Download remote file to local disk (optional `reuseConnection`, `vvv`, `fast`, or `connections` for a multi-connection ranged download — see [Multi-connection download](#multi-connection-download)) |
| `transfer` | Unified upload / download / server-to-server relay. Supports recursive small-file concurrency (`fileConcurrency`), batch upload (array `localPath`), temporary tar packing (`archive`, `archiveCompression`), fast SFTP by default, a bounded relay read-ahead window, and relay `strategy: "relay" \| "direct" \| "auto"` for a source-to-destination direct copy that bypasses this host — see [Upload behaviors](#upload-behaviors). |
| `list-servers` | List configured (enabled) servers. Lean by default; `verbose:true` adds cached system status, `refresh:true` re-collects it (implies verbose). |
| `workspace-run` | Launch an entrypoint on a remote server — **no YAML config needed**: pass `remoteRoot` + `venv`/`executable` inline, or use a saved `runProfiles.<name>` preset. `[push] → preflight → launching → remote-running → [collect]`. Durable: survives SSH disconnect and MCP adapter restart because all state lives on the remote filesystem, not locally — see [workspace-run (remote runner)](#workspace-run-remote-runner). |
| `run-status` | Query a `workspace-run` run's current status by `runId` (reads the remote state directory over SFTP; no local cache). |
| `run-logs` | Read a byte-offset window of a run's stdout/stderr, UTF-8-boundary-safe across sequential calls. |
| `run-list` | List runs on a server, newest first. |
| `run-cancel` | Cancel a run: TERM to its process group, then KILL after `graceMs`; re-verifies process identity before signalling. |
| `run-retry` | Launch a fresh run from an earlier run's own stored (non-secret) config snapshot, not the live config; records `parentRunId`. |
| `help` | Self-describing help text for the MCP client |

### show-whitelist

**Use this first!** Let the LLM inspect the active command policy:

```json
{
  "tool": "show-whitelist",
  "params": {
    "connectionName": "dev"
  }
}
```

Returns command mode, built-in command guards, configured whitelist/blacklist patterns, and examples when whitelist mode is active.

### execute-command

```json
{
  "tool": "execute-command",
  "params": {
    "cmdString": "docker ps",
    "connectionName": "dev",
    "timeout": 300000,
    "stream": true,
    "reuseConnection": true,
    "vvv": false
  }
}
```

| Param | Required | Default | Description |
|-------|----------|---------|-------------|
| `cmdString` | ✅ | - | Command to execute |
| `connectionName` | ❌ | First in `--enable-servers` | Which server to run on |
| `timeout` | ❌ | 300000ms (stream) / 30000ms (no stream) | Per-attempt phase timeout in ms. SSH setup, exec-channel opening, and remote command execution each use this cap. |
| `stream` | ❌ | `true` | Real-time streaming output |
| `reuseConnection` | ❌ | `true` | Reuse the cached SSH connection. Set `false` after a timeout or suspected stale cached connection to force a fresh TCP/SSH connection for this command. |
| `vvv` | ❌ | `false` | Append bounded SSH/channel debug output. Use with `reuseConnection: false` when you need fresh ssh2 handshake logs. |

**When to use `stream: false`:**
- Simple, fast commands (ls, pwd, cat)
- When you don't need real-time feedback

### close-connection

```json
{
  "tool": "close-connection",
  "params": {
    "connectionName": "dev"
  }
}
```

Closes the cached SSH client for a configured server. This is useful after a timeout or suspected stale reused connection when you want the next default `reuseConnection: true` command to reconnect cleanly. Closing a jump host also closes cached targets whose jump chain uses that host. `reuseConnection: false` commands do not need this because their one-shot SSH clients close after each command.

### workspace-run (remote runner)

Launches an entrypoint on a remote server. **No YAML configuration is required** — pass `remoteRoot` plus `venv` (or `executable`) inline and it runs against any enabled server, including ones that come from `~/.ssh/config`:

```json
{ "tool": "workspace-run", "params": {
  "server": "gpu-box", "remoteRoot": "/data/proj", "venv": "/data/envs/proj",
  "entrypoint": "train.py", "args": ["--epochs", "3"]
} }
```

Inline runs allow any safe relative `entrypoint` under `remoteRoot` (`..`, absolute paths and drive letters are still rejected), accept any `env` keys, default `push` to **false** (the code is assumed to already be under `remoteRoot`; pass `pushPaths` to upload it), and take `collectLocalDir` as the local destination for `collect`.

A `runProfiles.<name>` entry declared in your YAML config (see [YAML Config Reference](#-yaml-config-reference)) is an optional **saved preset** for those same fields — worth configuring when you launch the same job repeatedly, or when you want to *narrow* what may run (`allowedEntrypoints`) or which `env` keys may be overridden. It is not a prerequisite.

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

## 📄 YAML Config Reference

```yaml
# OpenSSH config loading is enabled by default.
# true = load ~/.ssh/config, false = use YAML only.
# You can also provide explicit paths:
sshConfig:
  enabled: true
  paths:
    - ~/.ssh/config
    - ~/.ssh/config.d/work

# Eagerly connect to all enabled servers on startup.
# false (default) = lazy connect on first tool call.
preConnect: false

# Optional: root dir for execute-command full-output logs.
# Per-call logs land under <outputLogDir>/<server>/<user>/<ts>-<pid>-<rand>.log.
# Defaults to <cwd>/.handfree-output when unset. Supports ~ and relative paths.
outputLogDir: ~/handfree-logs

servers:
  # NOTE: there is NO per-server `enabled` field. Which servers are active is
  # controlled ONLY by the `--enable-servers` launch flag; omit it to enable
  # every loaded server. Adding `enabled: true` under a server does nothing —
  # it is silently ignored. (The `enabled:` above lives under `sshConfig:` and
  # only toggles loading ~/.ssh/config; it is not a per-server switch.)
  server_name:
    # Required only for YAML-only servers. If a same-named Host exists in
    # ~/.ssh/config, these fields are optional overrides.
    host: 192.168.1.1
    port: 22
    username: root
    
    # Auth: use ONE of these. Omit agent to use SSH_AUTH_SOCK when present;
    # set agent only when you need a specific socket path.
    password: xxx
    privateKey: ~/.ssh/id_rsa
    agent: /path/to/ssh-agent.sock
    passphrase: key_password    # If privateKey is encrypted
    
    # Network — at most ONE of `socksProxy` or `jumpHost`. See "Jump host" below.
    # socksProxy: socks5://host:port
    # jumpHost: bastion

    
    # Command policy (regex patterns)
    # Default is blacklist. Set commandMode: whitelist to require a whitelist.
    commandMode: blacklist
    whitelist:                  # Active only in whitelist mode
      - "^ls.*$"
      - "^cat.*$"
    blacklist:                  # Block matching commands
      - "^docker system prune.*$"
    
    # Safe directory for destructive commands (rm, etc.)
    safeDirectory: /home/user   # rm allowed only within this path

    # SFTP path policy — applies ONLY to upload / download / transfer.
    # execute-command is NOT affected by these lists.
    # Default is OPEN: with `allowedRemoteDirectories` unset/empty, any absolute
    # POSIX remote path is allowed. Configure it to opt into an allowlist instead.
    allowedRemoteDirectories:
      - /home/user
      - /tmp
    # Extra local dirs allowed as SFTP source/target.
    # The MCP working directory is always permitted implicitly.
    allowedLocalDirectories:
      - /path/to/extra/local/dir
    # Bypasses both the remote allowlist and the local directory check entirely.
    # disableSftpPathPolicy: true

# Optional: workspace-run profiles (PLAN.MD Phase 2). See "workspace-run
# (remote runner)" above for exact push/collect semantics.
runProfiles:
  qwen-dev:
    server: server_name          # must match a servers: entry above
    remoteRoot: /data/arc/qwen   # working directory the entrypoint runs from
    environment:
      type: venv                 # venv | executable (conda/module/slurm parse but are rejected at launch)
      path: /data/arc/venvs/qwen # invokes /data/arc/venvs/qwen/bin/python directly
    allowedEntrypoints:
      - train.py
      - benchmarks/*.py
    env:
      PYTHONUNBUFFERED: "1"      # caller-supplied env overrides may only use keys declared here
    # defaultPush: true          # overrides workspace-run's own push default for this profile
    push:
      paths:                     # local sources (files and/or directories) uploaded to remoteRoot
        - E:/projects/qwen       # a directory's CONTENTS land directly under remoteRoot (flattened,
                                  # not nested under "qwen/") -- remoteRoot IS the pushed project root
    collect:
      paths:                     # globs relative to remoteRoot; never defaults to the whole tree
        - outputs/*.json
      localDir: E:/collected/qwen # required whenever paths above is non-empty
      maxBytes: 104857600         # optional, default 209715200 (200 MiB)
      maxFiles: 200                # optional, default 1000
```

### Security note: command policy

`execute-command` defaults to `commandMode: blacklist`. In that mode commands are allowed unless they match built-in destructive guards, the built-in dangerous-command blacklist, or a server's configured `blacklist:` patterns. Built-in blocked operations include system power commands (`reboot`, `shutdown`, `halt`, `poweroff`, `init 0/6`, `Restart-Computer`/`Stop-Computer`), recursive force delete (`rm -rf`, recursive-force `Remove-Item`, recursive Windows `del`/`rd`), dangerous `rmdir` targets, recursive world-writable `chmod -R 777`, and recursive `chown -R` on `/`. (Output redirection to absolute/home paths is NOT blocked — it's normal logging/`nohup` usage.) Set `commandMode: whitelist` to require every command to match `whitelist:` after blacklist checks. For compatibility, a YAML server that contains `whitelist:` without `commandMode:` is treated as whitelist mode. Set `disableBuiltinGuards: true` and/or `disableBuiltinBlacklist: true` to turn off the built-in guards/blacklist for a server (your own `blacklist:`/`whitelist:` still apply).

### SFTP path policy

| Field | Scope | Default behavior |
|---|---|---|
| `allowedRemoteDirectories` | `upload` / `download` / `transfer` only | **Unset/empty = open.** Any absolute POSIX path is allowed. Configuring this list opts into restricting SFTP to those directories. |
| `allowedLocalDirectories` | `upload` / `download` only | Unset = only the MCP working directory is allowed. |
| `disableSftpPathPolicy` | all SFTP tools | When `true`, bypasses both checks above entirely — any remote path, any local path. |

Path matching (when an allowlist is configured) is exact-equal or `dir + separator` prefix. `..` segments and null bytes are always rejected regardless of policy. Use `show-whitelist` to inspect a server's current SFTP policy.

### Jump host (ProxyJump-style)

Tunnel a target's SSH connection through another server defined in the same YAML. Useful when the target isn't directly reachable from your machine but a bastion is.

```yaml
servers:
  bastion:
    host: 1.2.3.4
    username: gate
    privateKey: ~/.ssh/id_rsa

  target:                       # NOT directly reachable
    host: 10.0.0.5
    username: app
    password: <target-password>
    jumpHost: bastion           # <- tunnel through `bastion`
    whitelist:                  # target's own policy
      - "^ls( .*)?$"
      - "^pwd$"
```

Rules (enforced at config load — bad configs fail fast):

- **Chaining to any depth.** The referenced jump host may itself set `jumpHost`, forming a chain `target -> J1 -> J2 -> ...`. The chain is built innermost-first (the deepest, directly-reachable hop connects first). Only **cycles** are rejected.
- **Mutually exclusive with `socksProxy`** on the same target.
- **Self-reference is rejected.** `target.jumpHost: target` is invalid.
- **Independent policy.** The target authenticates with its OWN `username` / `password` / `privateKey`, and its own `whitelist` / `blacklist` / `safeDirectory` / `allowed*Directories` apply. The jump host is purely transport.
- **Jump host is still a normal server.** You can run tools against `bastion` directly; its connection is separate from the tunneling one.

**Hot-reload note:** `jumpHost` is a connection-level field, so it hot-reloads. Editing a server's `jumpHost` (or any hop's connection fields) in `servers.yaml` resets the affected connection on the fly — the change takes effect on the next tool call, no restart needed. This is chain-aware: if an intermediate hop's host / port / credentials change, every target that tunnels through it is reset too.

### Connection lifecycle (connect / reconnect)

- **Lazy by default.** A server's SSH client is created on its first tool call via `ensureConnected()`. Set `preConnect: true` (or pass `--pre-connect`) to open all enabled servers at startup in parallel; failures are logged but don't block startup.
- **Cached clients stay open while reused.** With the default `reuseConnection: true`, `execute-command` does not close the SSH client after each command. If a cached client must be opened first, SSH setup, jump, SOCKS, and channel-open waits are bounded by the call's `timeout`. The cached client is closed on explicit disconnect/server shutdown, config hot-reload for changed connection fields, underlying SSH close/error cleanup, or reconnect after a connection-shaped command failure.
- **Manual cached-client close.** Use `close-connection { connectionName: "name" }` to drop a cached SSH client on demand. If the named server is a jump host, cached targets that jump through it are closed too.
- **Auto-reconnect on `execute-command`.** Every command runs inside a retry loop (default 3 attempts: 1 initial + 2 retries) with exponential backoff. If the underlying error matches a connection-shaped pattern (`econnreset`, `epipe`, `socket`, `closed`, `channel`, `end of stream`, or a `SSH_CONNECTION_FAILED` ToolError), the manager closes the dead client, reconnects, and retries the command. Non-connection errors (permission denied, validation, command-not-found) are returned immediately without retry.
- **Optional fresh command/SFTP connections.** `execute-command`, `upload`, `download`, `transfer`, and the whole `workspace-run`/`run-status`/`run-logs`/`run-list`/`run-cancel`/`run-retry` family reuse cached SSH clients by default (`reuseConnection: true`). If a call times out or you suspect the cached `ssh2.Client` is stale while native `ssh` works, retry with `reuseConnection: false`; that one operation opens a fresh SSH connection and closes it afterwards. SFTP still opens a new SFTP channel/session per operation.
- **Optional SSH debug output.** Set `vvv: true` on `execute-command` to append bounded SSH/channel debug output to the result or error. For full ssh2 handshake logs, combine it with `reuseConnection: false`; an already-open cached client cannot retroactively emit handshake debug.
- **Optional SFTP debug output.** Set `vvv: true` on `upload`, `download`, or `transfer` to append bounded SSH/SFTP debug where the result is textual. Recursive `transfer` success keeps its structured `{ summary, files }` JSON response, so recursive debug is surfaced on errors rather than appended to successful summaries.
- **SFTP transfers do NOT auto-retry.** `upload` / `download` / `transfer` lazy-connect via the same acquisition path and close stale cached clients on connection-shaped SFTP/channel errors, but a mid-transfer disconnect surfaces as a single failure — re-issue the call manually, preferably with `reuseConnection: false` if you suspect the cached SSH client.
- **No background keepalive or health probe.** Dead connections are only discovered on the next tool call. If you idle for hours through a NATed network, expect the first call after the gap to fail-then-reconnect on its own (you'll see one retry in the logs).

### Upload behaviors

- **CRLF auto-fix for shell scripts.** When uploading a `.sh`, `.bash`, or `.zsh` file, any `\r\n` line endings are automatically converted to `\n` before the bytes are sent. The response notes when this happens and how many line endings were rewritten. The local file on disk is left untouched.
- **Skip-if-identical (default on).** Before transferring, `upload` checks whether the remote file already matches the local payload. Files ≤ 256 MiB are compared byte-for-byte; larger files are compared via MD5 (using `md5sum` on the remote host). **Shell scripts (`.sh` / `.bash` / `.zsh`) are compared in a line-ending-agnostic way — both sides are LF-normalized before the comparison, so a CRLF-only diff is treated as identical and the upload is still skipped.** If they match, the upload is skipped and the response says so. Pass `skipIfIdentical: false` to force a re-upload. Recursive `transfer` (`mode: upload`, `recursive: true`) applies the same check per file.
- **Fast single-file SFTP (default on).** `upload`, `download`, and `transfer` upload/download mode use ssh2 `fastPut` / `fastGet` unless `fast: false` is set. Optional `sftpConcurrency` and `chunkSize` tune ssh2's parallel chunks; omitted values use ssh2 defaults. Fast uploads do not preload the local file: when skip-if-identical is enabled, they first compare remote size and only stream SHA-256 digests when sizes match. If a shell-script upload needs CRLF-to-LF conversion, it falls back to the normal safe upload path.
- **Recursive small-file concurrency.** Non-archive recursive upload/download transfers independent files through a bounded worker pool. `fileConcurrency` defaults to 4 and is capped at 8, because each concurrent file opens its own SFTP channel on the same SSH connection and the cap must stay under the remote's `MaxSessions` (OpenSSH's common default is 10) to avoid channel-open failures. The directory tree is created first, so parallel file writes never race their parent directories.
- **Tar-before-transfer archive mode.** Set `archive: true` on `transfer` to package one source file or directory into a temporary tar, transfer that single archive, extract it into the destination directory, and clean temporary archives on the MCP host and remote endpoints. The source basename is preserved. `archiveCompression` accepts `none` (default), `gzip`, `bzip2`, `xz`, or `zstd`; every endpoint that packs or extracts must provide compatible `tar`/compressor support. Archive mode works for upload, download, and relay and does not require `recursive: true`.
- **Windowed relay SFTP (default on).** `transfer mode=relay` reads and writes explicit file ranges rather than serially piping one stream. It keeps a bounded source read-ahead window in MCP-host memory while destination writes are pending, so one source/destination RTT pair does not serialize the whole transfer. The default is `sftpConcurrency: 64` and `chunkSize: 32768` (at most 2 MiB of application chunk buffers); tune either parameter for the link, up to a 64 MiB window. No relay payload is written to local disk. Destination ranges may finish out of order, then the existing size and best-effort MD5 checks verify the final file.
- **Relay skip-if-identical (default on).** `transfer mode=relay` does the same check between two remote servers: matching size on both sides plus matching `md5sum` skips the transfer. If `md5sum` is missing on either server, the check falls back to a normal transfer.
- **Relay `strategy` (direct transfer).** `transfer mode=relay` accepts `strategy: "relay" | "direct" | "auto"`. `"relay"` (default) is the windowed-SFTP behavior above, unchanged. `"direct"` runs the copy **on the source server** (`rsync`, else `tar` piped over `ssh`; never `rclone`) so this MCP host never reads or writes the file's bytes — it fails explicitly, with the precise reason, if the source cannot reach the destination directly, the destination host key is not already pinned on the source, non-interactive `existing-remote-key` auth is unavailable, or neither backend is installed on the source. Auth relies entirely on trust already present on the source server (its own default SSH identity/`known_hosts`); this tool never reads, constructs, or transfers a private key, and never passes `StrictHostKeyChecking=no` or an equivalent auto-accept flag. Direct transfer cannot traverse NAT — point it at a reachable pair, use a jump host/overlay network, or fall back to `strategy: "relay"`. `"auto"` probes the same conditions (route, host key, backend availability, auth, and the destination's path policy) with a real timeout and uses direct when possible; otherwise it falls back to relay and reports the accurate reason it did so.
- **Batch upload (array `localPath`).** Both `upload` and `transfer mode=upload` accept `localPath` as either a single string (unchanged 1.x behavior, plain-text response) or an array of local file paths for a batch upload. In batch mode, `remotePath` must be a directory and every source lands at `remotePath/<basename>`. Basename collisions across sources, or the exact same path repeated in the array, fail the whole call with `BATCH_TARGET_COLLISION` (listing the conflicts) **before any remote write happens** — collisions are never silently deduplicated. An empty array returns `INVALID_CONFIGURATION`; more than 1000 entries returns `BATCH_TOO_LARGE`. Concurrency reuses the same `fileConcurrency` (default 4, capped at 8) as recursive transfers. `onError` controls failure handling: `"abort"` (default) stops scheduling new files once one fails and drains in-flight ones; `"continue"` attempts every file regardless of earlier failures. Both modes return a per-file `uploaded` / `skipped` / `failed` status with failure reasons. Every file still goes through the normal single-file rules (skip-if-identical, CRLF→LF fix, `fast`, path policy) — nothing is reimplemented for batch mode. The response is structured JSON (`{ results, total, uploadedCount, skippedCount, failedCount, crlfFixedCount }`) instead of the plain-text single-file result. `archive: true` is not supported together with a batch `localPath` in this release; `download`/`relay` do not accept an array `localPath`.

### Multi-connection download

`download` and `transfer mode=download` accept `connections` (default `1`, maximum `8`). At `1` the behavior is exactly as before. Above `1`, the file is split into that many non-overlapping byte ranges, each pulled over its **own independent SSH/TCP connection**, written by positional writes into a preallocated local temp file, then size-verified and atomically renamed into place. A failure on any connection cancels the rest, deletes the temp file, and never touches the destination path.

Independent *connections* is the point, and it is not the same as opening more SFTP channels: every channel on one SSH connection shares that connection's flow-control window (ssh2 hardcodes it at 2 MiB), so extra channels buy nothing. A second connection brings a second window.

This helps on **high-latency** links, where one connection's window bounds throughput to roughly window/RTT. It does nothing useful on a fast LAN. Each connection is a separate SSH handshake, and all of them are made concurrently (so the cost is about one handshake, not N), which makes sshd's `MaxStartups` the remote limit that matters, not `MaxSessions` — OpenSSH's default `10:30:100` starts dropping unauthenticated connections at 10.

Measured on a real `tc netem` lab link at 50 ms / 1 Gbps (128 MiB file, median of 3 runs, SHA-256 verified every run):

| setting | throughput |
|---|---|
| default single connection | 17.54 MiB/s |
| `connections: 2` | 28.54 MiB/s |
| `connections: 4` | 45.71 MiB/s |
| `connections: 8` | 53.86 MiB/s |

Those numbers describe that one shaped link only; your own gain depends on RTT and bandwidth. Returns diminish past `4`. (Releases before 2.1.4 opened the connections one after another, which cost ~0.7 s per connection on that link and made `8` no faster than a single connection; the data path itself was never the bottleneck.) `connections` applies to single files only and is rejected for relay, a batch (array) `localPath`, `recursive: true`, and `archive: true`.

### Multi-connection upload

`upload` and `transfer mode=upload` accept the same `connections` (default `1`, maximum `8`). Above `1`, each byte range is written over its own independent SSH/TCP connection into **one remote temp file** next to the target. Only connection 0 creates/truncates it; the others open it without truncating. After every range succeeds and the temp file's size is verified, it replaces `remotePath` — as one atomic rename where the server advertises `posix-rename@openssh.com` (every OpenSSH does; verified against a real OpenSSH), otherwise by removing the old file and then renaming, which leaves a brief window where `remotePath` does not exist. If any connection fails, the temp file is deleted and `remotePath` keeps its previous contents. Skip-if-identical and the shell-script CRLF→LF fix still apply.

Measured uploading a 128 MiB file at 50 ms RTT (SHA-256 verified inside the container every run, the same remote path overwritten each time):

| setting | throughput |
|---|---|
| default single connection (`fastPut`) | 29.84 MiB/s |
| `connections: 2` | 35.18 MiB/s |
| `connections: 4` | 43.48 MiB/s |
| `connections: 8` | 44.92 MiB/s |

The gains are smaller than for download. Those figures include about 0.7 s of connection setup per call, which a larger file amortizes. In that lab only the server-to-client direction is bandwidth-shaped, so the upload numbers reflect the 50 ms RTT but no 1 Gbps ceiling.

### `execute-command` output capping & full logs

`execute-command` always persists the FULL stdout and stderr of every invocation to a local plain-text log file, then returns only a tail-truncated view to the caller. This keeps the LLM-visible payload small without losing any data.

- **Default cap:** 65536 bytes (64 KiB) per stream, tail-only. Set `maxOutputBytes` on the tool call to raise/lower the cap.
- **Streaming is unaffected.** When `stream: true`, every chunk still reaches the progress channel live; only the final aggregated return value is capped.
- **Log path:** `<outputLogDir>/<server-name>/<username>/<timestamp>-<pid>-<rand>.log`. Default `outputLogDir` is `<cwd>/.handfree-output`. Override with a top-level `outputLogDir:` entry in `servers.yaml` (supports `~` and relative paths).
- **Log format:** plain UTF-8 text with `=== META ===` / `=== STDOUT ===` / `=== STDERR ===` / `=== END ===` separators. Tail with `tail -f` while a command is running? Not yet — the file is finalized on close.
- **Truncation marker:** when output is trimmed, the returned text starts with an `[OUTPUT TRUNCATED]` header that lists total bytes, bytes dropped, and the on-disk log path. When output fits within the cap, no header is added and no log path is reported (the file is still written).
- **Retention:** none. Manage cleanup yourself (e.g. `find .handfree-output -mtime +7 -delete`).
- **Failures are non-fatal.** If the log file cannot be written, the command still completes and the failure is logged as an MCP-side warning.

```yaml
# servers.yaml
outputLogDir: ~/handfree-logs  # optional; defaults to <cwd>/.handfree-output
servers:
  dev: { ... }
```

## ⚙️ CLI Options

```text
--config          Optional path to YAML config/policy overlay
--ssh-config      Optional OpenSSH config path(s), comma-separated or repeated
--no-ssh-config   Disable automatic ~/.ssh/config loading
--enable-servers  Optional comma-separated list of servers to enable
--pre-connect     Eagerly connect to all enabled servers on startup
                  (overrides `preConnect` in YAML). Default: lazy connect.
```

> **Note**: `--enable-servers` controls which servers are available. The first server listed becomes the default when `connectionName` is not specified.
> If `--enable-servers` is omitted, all loaded servers are enabled; when more than one server is enabled, tools require `connectionName`.

### OpenSSH config support

The loader understands concrete `Host` entries and applies normal OpenSSH-style first-value matching against wildcard defaults. It supports `HostName`, `User`, `Port`, `IdentityFile`, `IdentityAgent`, `Include`, and common tokens such as `%h`, `%n`, `%p`, `%r`, `%u`, `%d`, and `%%`. Wildcard-only `Host *` blocks are used as defaults but are not exposed as runnable server names. `Match` blocks are ignored.

Connection settings are hot-reloaded when the loaded YAML/OpenSSH config files change. If host, user, port, identity, agent, passphrase, or proxy settings change, the existing SSH client for that server is closed and the next tool call reconnects with the new values. Whitelist, blacklist, SFTP policy, and output log settings also update live.

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

- **Pick the right command policy**: use default blacklist mode for flexible automation, or `commandMode: whitelist` for locked-down hosts
- **Keep secrets safe**: Add `servers.yaml` to `.gitignore`
- **Per-server control**: Prod can be locked down, dev can be permissive

## 📋 TODO & PLAN

### High Priority
- [x] **Complete test coverage**: Add tests for `list-servers`, `upload`, `download`, `show-whitelist`, streaming mode, timeout/kill
- [ ] **Session support**: Add tools to list/create/resume/close persistent SSH sessions (for multi-command workflows)
- [ ] **LLM-based whitelist**: Allow LLM to propose commands, with human approval adding to dynamic whitelist

### Nice to Have
- [x] **Command history / output archive**: full stdout/stderr of every `execute-command` is persisted under `<outputLogDir>/<server>/<user>/*.log`
- [x] **Multi-command execution**: Execute multiple commands in sequence with `&&` or `;` safely (fixed: `2>/dev/null` now allowed)
- [x] **Connection auto-recovery**: `execute-command` retries with exponential backoff and forced reconnect on connection-shaped errors
- [x] **SFTP connection reuse controls**: `upload` / `download` / `transfer` support `reuseConnection`, `vvv`, and explicit fresh one-shot SSH clients
- [x] **Fast, concurrent, and archive transfer**: default-on ssh2 `fastPut` / `fastGet`, bounded recursive `fileConcurrency`, tar-before-transfer compression, and bounded relay read-ahead chunks
- [ ] **SFTP retry parity**: extend the retry-with-reconnect loop to `upload` / `download` / `transfer`
- [x] **SSH keepalive**: cached and jump SSH clients use `keepaliveInterval` / `keepaliveCountMax` (defaults: 5000 ms / 2 unanswered probes) to detect half-open connections
- [ ] **Server health check**: optional periodic ping to detect drops proactively

## 📄 License

ISC License

- Original work: © 2025 junki.cn ([ssh-mcp-server](https://github.com/classfang/ssh-mcp-server))
- Modifications: © 2026 woqucc (handfree-ssh-mcp)
