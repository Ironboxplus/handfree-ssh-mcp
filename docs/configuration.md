[← Back to README](../README.md)

# Configuration

## YAML config reference

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

## Security note: command policy

`execute-command` defaults to `commandMode: blacklist`. In that mode commands are allowed unless they match built-in destructive guards, the built-in dangerous-command blacklist, or a server's configured `blacklist:` patterns. Built-in blocked operations include system power commands (`reboot`, `shutdown`, `halt`, `poweroff`, `init 0/6`, `Restart-Computer`/`Stop-Computer`), recursive force delete (`rm -rf`, recursive-force `Remove-Item`, recursive Windows `del`/`rd`), dangerous `rmdir` targets, recursive world-writable `chmod -R 777`, and recursive `chown -R` on `/`. (Output redirection to absolute/home paths is NOT blocked — it's normal logging/`nohup` usage.) Set `commandMode: whitelist` to require every command to match `whitelist:` after blacklist checks. For compatibility, a YAML server that contains `whitelist:` without `commandMode:` is treated as whitelist mode. Set `disableBuiltinGuards: true` and/or `disableBuiltinBlacklist: true` to turn off the built-in guards/blacklist for a server (your own `blacklist:`/`whitelist:` still apply).

## SFTP path policy

| Field | Scope | Default behavior |
|---|---|---|
| `allowedRemoteDirectories` | `upload` / `download` / `transfer` only | **Unset/empty = open.** Any absolute POSIX path is allowed. Configuring this list opts into restricting SFTP to those directories. |
| `allowedLocalDirectories` | `upload` / `download` only | Unset = only the MCP working directory is allowed. |
| `disableSftpPathPolicy` | all SFTP tools | When `true`, bypasses both checks above entirely — any remote path, any local path. |

Path matching (when an allowlist is configured) is exact-equal or `dir + separator` prefix. `..` segments and null bytes are always rejected regardless of policy. Use `show-whitelist` to inspect a server's current SFTP policy.

## Jump host (ProxyJump-style)

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

## Connection lifecycle (connect / reconnect)

- **Lazy by default.** A server's SSH client is created on its first tool call via `ensureConnected()`. Set `preConnect: true` (or pass `--pre-connect`) to open all enabled servers at startup in parallel; failures are logged but don't block startup.
- **Cached clients stay open while reused.** With the default `reuseConnection: true`, `execute-command` does not close the SSH client after each command. If a cached client must be opened first, SSH setup, jump, SOCKS, and channel-open waits are bounded by the call's `timeout`. The cached client is closed on explicit disconnect/server shutdown, config hot-reload for changed connection fields, underlying SSH close/error cleanup, or reconnect after a connection-shaped command failure.
- **Manual cached-client close.** Use `close-connection { connectionName: "name" }` to drop a cached SSH client on demand. If the named server is a jump host, cached targets that jump through it are closed too.
- **Auto-reconnect on `execute-command`.** Every command runs inside a retry loop (default 3 attempts: 1 initial + 2 retries) with exponential backoff. If the underlying error matches a connection-shaped pattern (`econnreset`, `epipe`, `socket`, `closed`, `channel`, `end of stream`, or a `SSH_CONNECTION_FAILED` ToolError), the manager closes the dead client, reconnects, and retries the command. Non-connection errors (permission denied, validation, command-not-found) are returned immediately without retry.
- **Optional fresh command/SFTP connections.** `execute-command`, `upload`, `download`, `transfer`, and the whole `workspace-run`/`run-status`/`run-logs`/`run-list`/`run-cancel`/`run-retry` family reuse cached SSH clients by default (`reuseConnection: true`). If a call times out or you suspect the cached `ssh2.Client` is stale while native `ssh` works, retry with `reuseConnection: false`; that one operation opens a fresh SSH connection and closes it afterwards. SFTP still opens a new SFTP channel/session per operation.
- **Optional SSH debug output.** Set `vvv: true` on `execute-command` to append bounded SSH/channel debug output to the result or error. For full ssh2 handshake logs, combine it with `reuseConnection: false`; an already-open cached client cannot retroactively emit handshake debug.
- **Optional SFTP debug output.** Set `vvv: true` on `upload`, `download`, or `transfer` to append bounded SSH/SFTP debug where the result is textual. Recursive `transfer` success keeps its structured `{ summary, files }` JSON response, so recursive debug is surfaced on errors rather than appended to successful summaries.
- **SFTP transfers do NOT auto-retry.** `upload` / `download` / `transfer` lazy-connect via the same acquisition path and close stale cached clients on connection-shaped SFTP/channel errors, but a mid-transfer disconnect surfaces as a single failure — re-issue the call manually, preferably with `reuseConnection: false` if you suspect the cached SSH client.
- **No background keepalive or health probe.** Dead connections are only discovered on the next tool call. If you idle for hours through a NATed network, expect the first call after the gap to fail-then-reconnect on its own (you'll see one retry in the logs).

## `execute-command` output capping & full logs

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

## CLI options

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

## OpenSSH config support

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
