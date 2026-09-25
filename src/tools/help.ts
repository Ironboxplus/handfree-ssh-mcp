import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const TOOL_HELP: Record<string, string> = {
  "list-servers": `list-servers — Discover available SSH servers.

Parameters:
  verbose  (boolean, optional)  Include the cached system status block
           (hostname, CPU, memory, disk, GPUs). Off by default.
  refresh  (boolean, optional)  Re-collect live system status from all
           enabled servers before returning. Implies verbose=true.
           Connect + probe are time-bounded (~15s each); a stuck remote
           returns reachable:false instead of hanging the tool call.

Returns: JSON array of server objects with name, host, port, username,
         connected, enabled, and optional status.

Example:
  list-servers                      → lean identity + connected state
  list-servers { verbose: true }    → include cached status if available
  list-servers { refresh: true }    → fresh system status (bounded)`,

  "execute-command": `execute-command — Run a shell command on a remote server.

Parameters:
  cmdString       (string, required)   The shell command to execute.
  connectionName  (string, see below)  Target server name from list-servers.
  stream          (boolean, optional)  Default true. Starts the command in
                  the background and returns runId/logPath immediately.
                  Poll with command-status. Set false for short commands
                  when you need the final output in the same tool call.
  reuseConnection (boolean, optional)  Default true. Set false after a timeout
                  or suspected stale cached SSH connection to force a fresh
                  TCP/SSH connection for this command.
  vvv             (boolean, optional)  Default false. Append bounded
                  SSH/channel debug output. Use with reuseConnection=false
                  when you need fresh handshake logs.
  timeout         (number, optional)   Per-attempt phase timeout in ms:
                                      SSH setup, exec-channel open, and
                                      remote command execution each use this
                                      cap.
                  Defaults: 300000 (stream) / 30000 (non-stream).

connectionName rule:
  • If only one server is enabled → optional (auto-selected).
  • If multiple servers are enabled → REQUIRED.

Examples:
  execute-command { cmdString: "pwd" }
  execute-command { cmdString: "docker ps -a", connectionName: "prod", stream: false }
  execute-command { cmdString: "tail -f /var/log/syslog", stream: true, timeout: 600000 }
  command-status { runId: "cmd_20260712T120000Z_ab12cd34" }
  execute-command { cmdString: "hostname", connectionName: "scnet", stream: false, reuseConnection: false }
  execute-command { cmdString: "hostname", connectionName: "scnet", stream: false, reuseConnection: false, vvv: true }`,

  "command-status": `command-status — Poll a background command.

Parameters:
  runId           (string, required)   runId returned by execute-command
                                      when stream=true.
  maxOutputBytes  (number, optional)   Live output bytes per chunk or tail.
                                      Defaults to 65536.
  incremental     (boolean, optional)  Default true. Repeated calls return only
                                      new outputChunk data and advance a stored
                                      cursor. False returns outputTail and still
                                      advances the cursor to the current file end.
  offset          (number, optional)   Override the stored byte cursor. The
                                      returned nextOffset becomes the new cursor.

Returns: JSON with runId, status (running/completed/failed), logPath,
         timestamps, error when failed, outputChunk in incremental mode or
         outputTail when incremental=false, nextOffset, fileSize, and hasMore.
         Poll again while hasMore=true to drain backlog. Status and cursor are
         process-local;
         after MCP server restart, read the returned logPath directly.

Example:
  command-status { runId: "cmd_20260712T120000Z_ab12cd34", maxOutputBytes: 50000 }
  command-status { runId: "cmd_20260712T120000Z_ab12cd34", incremental: false }
  command-status { runId: "cmd_20260712T120000Z_ab12cd34", offset: 12345 }`,

  "show-whitelist": `show-whitelist — Show the active command policy for a server.

Parameters:
  connectionName  (string, see below)  Target server name from list-servers.

connectionName rule:
  • If only one server is enabled → optional (auto-selected).
  • If multiple servers are enabled → REQUIRED.

Returns: Command mode, built-in blacklist, configured whitelist/blacklist patterns, and example commands when whitelist mode is active.`,

  "close-connection": `close-connection — Close a cached SSH connection.

Parameters:
  connectionName  (string, see below)  Target server name from list-servers.

connectionName rule:
  • If only one server is enabled → optional (auto-selected).
  • If multiple servers are enabled → REQUIRED.

Behavior:
  • Closes the cached/reused SSH client for the target server.
  • Closing a jump host also closes cached targets whose jump chain uses it.
  • Does not affect reuseConnection=false commands, because those one-shot
    connections already close after each command.

Examples:
  close-connection { connectionName: "scnet" }
  close-connection { connectionName: "dcu" }`,

  "upload": `upload — Upload a local file, or a batch of local files, to a remote server over SFTP.

Parameters:
  localPath       (string | string[], required)  File path on the MCP host,
                  or an array of paths for batch upload. Must be inside the
                  MCP working directory.
  remotePath      (string, required)   Destination path on the remote server.
                  Batch mode (array localPath): this must be a directory;
                  each source lands at remotePath/<basename>.
  connectionName  (string, see below)  Target server name from list-servers.
  skipIfIdentical (boolean, optional)  Default true. Skip when remote matches.
  reuseConnection (boolean, optional)  Default true. Set false after timeout
                  or suspected stale cached SSH connection.
  timeout         (number, optional)   SSH setup and SFTP channel-open timeout.
  vvv             (boolean, optional)  Default false. Append bounded SSH/SFTP debug.
                  Recursive success returns structured JSON; debug is surfaced
                  for single-file results, relay results, and recursive errors.
  fast            (boolean, optional)  Default false. Use ssh2 fastPut for
                  single-file upload throughput. Not multi-file concurrency.
  sftpConcurrency (number, optional)   Only with fast=true. Concurrent SFTP chunks.
  chunkSize       (number, optional)   Only with fast=true. SFTP chunk bytes.
  onError         (string, optional)   Batch mode only. "abort" (default): stop
                  scheduling new files once one fails, drain in-flight ones.
                  "continue": attempt every file regardless of earlier failures.
                  Both report a per-file uploaded/skipped/failed status.
  fileConcurrency (number, optional)   Batch mode only. Independent files
                  uploaded in parallel. Default 4, maximum 8.

connectionName rule:
  • If only one server is enabled → optional (auto-selected).
  • If multiple servers are enabled → REQUIRED.

Batch mode (array localPath):
  • remotePath must be a directory; each source lands at remotePath/<basename>.
  • Basename collisions across sources, or the same path repeated in the
    array, fail the whole call with BATCH_TARGET_COLLISION before anything
    is written remotely — never silently deduplicated.
  • Empty array → INVALID_CONFIGURATION. Over 1000 entries → BATCH_TOO_LARGE.
  • Every file still goes through the normal single-file rules: skip-if-
    identical, CRLF→LF fix for .sh/.bash/.zsh, fast, and path policy.
  • Returns structured JSON: { results: [...], total, uploadedCount,
    skippedCount, failedCount, crlfFixedCount }. A single string localPath
    keeps the original plain-text response, unchanged.
  • archive is not available for batch mode in this delivery round.

Example:
  upload { localPath: "data.csv", remotePath: "/tmp/data.csv" }
  upload { localPath: "big.bin", remotePath: "/tmp/big.bin", fast: true,
           sftpConcurrency: 32, chunkSize: 131072 }
  upload { localPath: ["a/config.yaml", "b/settings.json"], remotePath: "/etc/app" }
  upload { localPath: ["1.csv", "2.csv", "3.csv"], remotePath: "/data", onError: "continue" }`,

  "download": `download — Download a single file from a remote server over SFTP.

Parameters:
  remotePath      (string, required)   File path on the remote server.
  localPath       (string, required)   Destination on the MCP host.
                  Must be inside the MCP working directory.
  connectionName  (string, see below)  Target server name from list-servers.
  reuseConnection (boolean, optional)  Default true. Set false after timeout
                  or suspected stale cached SSH connection.
  timeout         (number, optional)   SSH setup and SFTP channel-open timeout.
  vvv             (boolean, optional)  Default false. Append bounded SSH/SFTP debug.
  fast            (boolean, optional)  Default false. Use ssh2 fastGet for
                  single-file download throughput. Not multi-file concurrency.
  sftpConcurrency (number, optional)   Only with fast=true. Concurrent SFTP chunks.
  chunkSize       (number, optional)   Only with fast=true. Bytes per SFTP request.
  connections     (number, optional)   Default 1 (unchanged behavior). Above 1,
                  split the file into that many non-overlapping byte ranges and
                  pull each over its OWN independent SSH/TCP connection, then
                  reassemble, verify and atomically rename. Maximum 8.
                  Helps on high-latency links, where one connection is capped by
                  the SSH channel's flow-control window; pointless on a fast LAN.
                  Each connection is a separate SSH handshake and they all run
                  concurrently, so the remote limit that matters is sshd's
                  MaxStartups (OpenSSH default 10:30:100 starts dropping at 10),
                  not MaxSessions. Measured on a 50 ms / 1 Gbps link against
                  17.5 MiB/s for one connection: 2 -> 28.5, 4 -> 45.7,
                  8 -> 53.9 MiB/s. Diminishing returns past 4; the gain depends
                  on your link's RTT and bandwidth.

connectionName rule:
  • If only one server is enabled → optional (auto-selected).
  • If multiple servers are enabled → REQUIRED.

Example:
  download { remotePath: "/var/log/app.log", localPath: "app.log" }
  download { remotePath: "/tmp/big.bin", localPath: "big.bin", fast: true,
             sftpConcurrency: 32, chunkSize: 131072 }
  download { remotePath: "/tmp/huge.bin", localPath: "huge.bin", connections: 4 }`,

  "transfer": `transfer — Move files between hosts (single/recursive/cross-server).

Modes:
  upload    Push local → remote (single file or recursive directory).
  download  Pull remote → local (single file or recursive directory).
  relay     Copy a file from remote-A → remote-B. strategy="relay" (default,
            unchanged) streams it via SFTP piping through this MCP host; no
            temp file on the MCP host, no SCP, no authorized-key exchange
            between the two servers. strategy="direct" instead runs the copy
            ON server-A (rsync, else tar piped over ssh) so this MCP host
            never reads or writes the file's bytes; requires server-A to
            already reach server-B directly with its own pre-existing
            non-interactive SSH trust (never transfers a private key, never
            auto-accepts an unknown host key). strategy="auto" uses direct
            when possible, else falls back to relay and reports why.

Parameters for upload / download:
  mode            (string, required)   "upload" or "download"
  localPath       (string | string[], required)  Path on the MCP host. Upload
                  only: an array batch-uploads multiple independent files to
                  the same remotePath directory (see "Batch upload" below).
  remotePath      (string, required)   Path on the remote server.
  connectionName  (string, see below)  Target server name.
  recursive       (boolean, optional)  True to transfer a whole directory tree.
                  Not combinable with an array localPath.
  skipIfIdentical (boolean, optional)  Default true. Skip the transfer when the
                  destination already matches the source. Upload: byte-compare
                  for files <= 256 MiB, MD5 otherwise; shell scripts
                  (.sh/.bash/.zsh) ignore CRLF<->LF differences. Relay: size +
                  md5sum on both servers when available, falling back to
                  transferring. Download is never skipped. Set false to force.
  archiveCompression (string, optional) Only with archive=true. One of "none"
                  (default), "gzip", "bzip2", "xz", "zstd". The remote must
                  have the matching tool available for the chosen codec.
  reuseConnection (boolean, optional)  Default true. Set false after timeout.
  timeout         (number, optional)   SSH setup and SFTP channel-open timeout.
  vvv             (boolean, optional)  Default false. Append bounded SSH/SFTP debug.
  fast            (boolean, optional)  Default false. upload/download only:
                  use ssh2 fastPut/fastGet for each single file. Directory
                  recursion stays sequential; no multi-file concurrency.
  sftpConcurrency (number, optional)   Only with fast=true. Concurrent SFTP chunks.
  chunkSize       (number, optional)   Only with fast=true. Bytes per SFTP request.
  connections     (number, optional)   mode="download", single file only.
                  Default 1 (unchanged). Above 1, split the file into that many
                  non-overlapping byte ranges pulled over that many INDEPENDENT
                  SSH/TCP connections, reassembled, verified, atomically
                  renamed. Maximum 8. Helps on high-latency links; pointless on
                  a fast LAN. Separate, concurrent handshakes, so sshd's
                  MaxStartups is the limit that matters, not MaxSessions.
                  Measured on 50 ms / 1 Gbps (one connection 17.5 MiB/s):
                  2 -> 28.5, 4 -> 45.7, 8 -> 53.9 MiB/s. Rejected for
                  upload, recursive=true and archive=true.
  fileConcurrency (number, optional)   Recursive or batch upload only: independent
                  files transferred in parallel. Default 4, maximum 8. Each
                  parallel file opens its own SFTP channel on the same SSH
                  connection; capped under OpenSSH's common default
                  MaxSessions=10 so it does not reliably fail channel-open
                  against a default-configured remote.
  onError         (string, optional)   Batch upload only (array localPath).
                  "abort" (default): stop scheduling new files once one fails,
                  drain in-flight ones. "continue": attempt every file
                  regardless of earlier failures. Both report a per-file
                  uploaded/skipped/failed status.

Batch upload (mode="upload" with an array localPath):
  • remotePath must be a directory; each source lands at remotePath/<basename>.
  • Basename collisions across sources, or the same path repeated in the
    array, fail the whole call with BATCH_TARGET_COLLISION before anything
    is written remotely — never silently deduplicated.
  • Empty array → INVALID_CONFIGURATION. Over 1000 entries → BATCH_TOO_LARGE.
  • Every file still goes through the normal single-file rules: skip-if-
    identical, CRLF→LF fix for .sh/.bash/.zsh, fast, and path policy.
  • Returns structured JSON: { results: [...], total, uploadedCount,
    skippedCount, failedCount, crlfFixedCount }. A single string localPath
    keeps the original plain-text response, unchanged.
  • Not combinable with archive=true or recursive=true in this delivery round.
  • download/relay do not support an array localPath in this delivery round.

Parameters for relay:
  mode              (string, required)   "relay"
  sourceServer      (string, required)   Server name to read from.
  sourceRemotePath  (string, required)   File path on source server.
  destServer        (string, required)   Server name to write to.
  destRemotePath    (string, required)   File path on dest server.
  reuseConnection   (boolean, optional)  Default true. Set false after timeout.
  timeout           (number, optional)   SSH setup and SFTP channel-open timeout.
  vvv               (boolean, optional)  Default false. Append bounded SSH/SFTP debug.
  fast              (boolean, optional)  Accepted but relay keeps the streaming
                    SFTP pipe path; fastGet/fastPut apply to host<->remote only.
  strategy          (string, optional)   "relay" (default) | "direct" | "auto".
                    "direct": run the copy on the source server (rsync, else
                    tar|ssh; never rclone) so this MCP host relays zero
                    file-data bytes; fails explicitly with the precise reason
                    if not possible (source cannot reach the destination
                    directly, destination host key not pinned on the source,
                    non-interactive existing-remote-key auth unavailable, or
                    no backend installed on the source). Direct transfer
                    cannot traverse NAT — use a jump host, an overlay
                    network, or strategy="relay" instead. "auto": probe the
                    same conditions and use direct when possible, else fall
                    back to relay and report the real reason.

connectionName rule (upload/download):
  • If only one server is enabled → optional.
  • If multiple servers are enabled → REQUIRED.

Examples:
  transfer { mode: "upload", localPath: "dist/", remotePath: "/opt/app/dist", recursive: true }
  transfer { mode: "upload", localPath: ["a/config.yaml", "b/settings.json"], remotePath: "/etc/app" }
  transfer { mode: "download", localPath: "huge.bin", remotePath: "/data/huge.bin",
  transfer { mode: "relay", sourceServer: "prod", sourceRemotePath: "/var/log/app.log",
             destServer: "backup", destRemotePath: "/backup/app.log" }
  transfer { mode: "relay", sourceServer: "prod", sourceRemotePath: "/data/dump.tar",
             destServer: "backup", destRemotePath: "/backup/dump.tar", strategy: "auto" }`,

  "workspace-run": `workspace-run — Launch an entrypoint on a remote server, durably. No YAML config required.

The launched process survives SSH disconnect and MCP adapter restart: all
state (meta.json/stdout.log/stderr.log/pid/heartbeat/exit.json) lives under
~/.handfree-runs/<runId>/ on the remote filesystem, not locally. There is no
local cache of run state — status/logs/cancel require the remote server to
be reachable.

Two ways to describe a run; a saved profile is a preset, NOT a prerequisite:
  • Inline (zero config, works with servers from ~/.ssh/config):
      remoteRoot + one of venv / executable
  • Saved: profile: "<name>" — a runProfiles.<name> entry in YAML. Worth
    configuring when you launch the same job repeatedly, or when you want to
    NARROW what may run (allowedEntrypoints) or which env keys may be
    overridden. Inline runs allow any safe relative entrypoint under
    remoteRoot ('..', absolute paths and drive letters are still rejected).

Full pipeline (PLAN.MD Phase 2): [push] → preflight → launching →
remote-running → [collect].
  • push uploads the push sources to remoteRoot before launch — batch upload
    for individual files, recursive upload for directories, both
    skip-if-identical. Sources are runProfiles.<name>.push.paths for a saved
    profile, or pushPaths inline. It defaults to true for a profile that
    declares push.paths (or its defaultPush) and to false for an inline run
    with no pushPaths, since remoteRoot is assumed to already hold the code.
    Pass push:false to skip it explicitly.
  • collect (default the profile's collect.paths) pulls artifacts back by
    explicit glob (relative to remoteRoot) after the run finishes, into
    collect.localDir (saved) or collectLocalDir (inline) — never defaults to
    pulling the whole remoteRoot. Requesting collect (non-empty, by default or
    explicitly) makes this call BLOCK, bounded by timeout, until the run
    reaches a terminal state, then collects; a plain launch (no collect)
    still returns immediately once the process is confirmed started, exactly
    as before. Pass collect:[] to disable collect for this call. Enforces a
    total byte cap and file-count cap (profile collect.maxBytes/maxFiles) —
    exceeding either fails the collect phase and reports what was already
    pulled, no silent truncation. Collect still runs by default even if the
    run failed or was cancelled (logs/partial artifacts are diagnostic
    material); a collect failure never rewrites the run's own exit code —
    it is reported separately in details.collect.
  • sync only accepts "none"/omitted; "flush" returns SYNC_NOT_AVAILABLE
    (Phase 3).
  • Only environment.type venv/executable is supported (inline venv/
    executable always is); a saved profile using conda/module/slurm or
    gpu.required/secretEnv returns a *_NOT_AVAILABLE error.

Parameters:
  profile         (string, optional)   Saved runProfiles.<name> from YAML.
                  Omit it and use remoteRoot + venv/executable instead.
  remoteRoot      (string, inline)     Absolute remote directory holding the
                  entrypoint. Also the process's working directory and the
                  root entrypoint/collect globs resolve against.
  venv            (string, inline)     Absolute path to a remote virtualenv.
                  Runs <venv>/bin/python directly — no "source activate".
  executable      (string, inline)     Interpreter/program, e.g. "bash",
                  "python3", "/usr/bin/node". With venv, names the binary
                  inside <venv>/bin instead. One of venv/executable required
                  when running inline.
  pushPaths       (string[], inline)   Local files/dirs to upload into
                  remoteRoot before launch. Supplying it turns push on.
  collectLocalDir (string, inline)     Local directory collected artifacts
                  are written into. Needed if collect is non-empty.
  entrypoint      (string, required)   Path relative to remoteRoot. Always a
                  plain relative path (no "..", not absolute); with a saved
                  profile it must also match its allowedEntrypoints globs.
  args            (string[], optional) Positional arguments. Each is quoted
                  individually on the remote shell — never interpreted,
                  safe for arbitrary strings.
  env             (object, optional)   Environment for the process. With a
                  saved profile every key must already be declared in that
                  profile's env map (allowlist), else ENV_KEY_NOT_ALLOWED;
                  inline, any key is accepted.
  server          (string, optional)   With a profile, defaults to the
                  profile's configured server. Inline, the server to run on
                  — omittable only when exactly one server is enabled.
  push            (boolean, optional)  Default true for a profile with
                  push.paths, false for an inline run without pushPaths.
                  See above.
  collect         (string[], optional) Default the profile's collect.paths.
                  See above.
  sync            (string, optional)   "none" (default) or "flush" (rejected
                  with SYNC_NOT_AVAILABLE).
  timeout         (number, optional)   Only meaningful when collect actually
                  runs: ms to wait for a terminal state before giving up on
                  collect. Default the profile's timeout, else 600000 (10m).
  reuseConnection (boolean, optional)  Default true. Applies to every remote
                  call this launch makes (push upload, entrypoint stat/hash,
                  the launch exec, and collect if requested). Set false
                  after a timeout or suspected stale/bad cached connection
                  to force fresh ones for this call.

Returns: { ok, jobId, state, message, next, details } — jobId equals the
returned runId. details.status is the same shape run-status returns.
details.collect (when collect ran) is { status, reason?, files, totalBytes }.

Example (inline — nothing configured anywhere):
  workspace-run { server: "gpu-box", remoteRoot: "/data/proj",
                  venv: "/data/envs/proj", entrypoint: "train.py",
                  args: ["--epochs", "3"] }
  workspace-run { server: "gpu-box", remoteRoot: "/data/proj",
                  executable: "bash", entrypoint: "scripts/eval.sh" }
  workspace-run { server: "gpu-box", remoteRoot: "/data/proj",
                  venv: "/data/envs/proj", entrypoint: "train.py",
                  pushPaths: ["./src"], collect: ["outputs/*.json"],
                  collectLocalDir: "./artifacts", timeout: 1800000 }

Example (saved profile):
  workspace-run { profile: "qwen-dev", entrypoint: "train.py",
                  args: ["--epochs", "3"] }
  workspace-run { profile: "qwen-dev", entrypoint: "train.py", push: false }
  workspace-run { profile: "qwen-dev", entrypoint: "train.py",
                  collect: ["outputs/*.json"], timeout: 1800000 }`,

  "run-status": `run-status — Query a workspace-run's current status by runId.

Reads directly from the remote state directory over SFTP every call — no
local cache, so the remote server must be reachable, and an MCP adapter
that just restarted can query exactly as well as one that never stopped.

Parameters:
  runId           (string, required)   runId returned by workspace-run.
  connectionName  (string, see below)  Server the run was launched on.
  reuseConnection (boolean, optional)  Default true. Set false after a
                  timeout or suspected stale/bad cached connection to force
                  a fresh one for this call.

connectionName rule:
  • If only one server is enabled → optional (auto-selected).
  • If multiple servers are enabled → REQUIRED.

Returns: { ok, jobId, state, message, details } where details is
{ runId, server, profile, state, phase, createdAt, exitCode, signal,
  cancelled, heartbeatAt, orphaned? }. state is one of running, completed,
failed, cancelled, recovering (heartbeat stale/missing — ambiguous until
confirmed), orphaned.

Example:
  run-status { runId: "run_20260915T120000Z_ab12cd34" }`,

  "run-logs": `run-logs — Read a byte-offset window of a run's stdout/stderr.

Fetched over SFTP directly from the remote log file. Correctly handles a
multi-byte UTF-8 character split across the window boundary — sequential
calls chained via nextOffset never duplicate or drop bytes.

Parameters:
  runId           (string, required)   runId returned by workspace-run.
  connectionName  (string, see below)  Server the run was launched on.
  stream          (string, optional)   "stdout" (default) or "stderr".
  offset          (number, optional)   Byte offset to start from. Default 0.
                  Use the previous response's nextOffset to continue.
  maxOutputBytes  (number, optional)   Max bytes this call returns.
                  Default 65536.
  reuseConnection (boolean, optional)  Default true. Set false after a
                  timeout or suspected stale/bad cached connection to force
                  a fresh one for this call.

connectionName rule:
  • If only one server is enabled → optional (auto-selected).
  • If multiple servers are enabled → REQUIRED.

Returns: { ok, jobId, state, message, details } where details is
{ runId, stream, text, startOffset, nextOffset, fileSize, hasMore }.
Poll again with offset=nextOffset while hasMore=true.

Example:
  run-logs { runId: "run_20260915T120000Z_ab12cd34", offset: 0 }
  run-logs { runId: "run_20260915T120000Z_ab12cd34", stream: "stderr" }`,

  "run-list": `run-list — List workspace-run runs on a server, newest first.

Reads ~/.handfree-runs/ over SFTP (no local cache). Bounded to 200 entries
max regardless of the requested limit. A run whose state directory is
corrupt or mid-write is silently omitted (query it directly with run-status
for the detailed error).

Parameters:
  connectionName  (string, see below)  Target server.
  profile         (string, optional)   Only runs launched under this profile.
                  Inline runs (no profile — remoteRoot + venv/executable
                  passed straight to workspace-run) are all recorded under
                  the literal label "(ad-hoc)"; pass that to list them.
  state           (string, optional)   running/completed/failed/cancelled/
                  recovering/orphaned.
  limit           (number, optional)   Default 50, max 200.
  reuseConnection (boolean, optional)  Default true. Set false after a
                  timeout or suspected stale/bad cached connection to force
                  a fresh one for this call.

connectionName rule:
  • If only one server is enabled → optional (auto-selected).
  • If multiple servers are enabled → REQUIRED.

Returns: { ok, jobId: "run-list", state: "completed", message, details }
where details.runs is an array of the same shape run-status returns.

Example:
  run-list { profile: "qwen-dev", state: "running" }
  run-list { profile: "(ad-hoc)" }`,

  "run-cancel": `run-cancel — Cancel a workspace-run.

Sends TERM to the run's whole remote process group, waits graceMs, then
KILL if it is still alive. Re-verifies the recorded process identity (boot
id, pid, pgid, /proc start ticks, wrapper token read back from the live
process's own environment) against what is actually running right now
before sending any signal — on a mismatch (pid reuse, host reboot) the run
moves to "orphaned" instead, and nothing is signalled. Idempotent:
cancelling an already-finished or already-orphaned run just reports that
outcome again without sending anything.

Parameters:
  runId           (string, required)   runId returned by workspace-run.
  connectionName  (string, see below)  Server the run was launched on.
  graceMs         (number, optional)   Wait after TERM before KILL.
                  Default 5000.
  reuseConnection (boolean, optional)  Default true. Set false after a
                  timeout or suspected stale/bad cached connection to force
                  a fresh one for this call.

connectionName rule:
  • If only one server is enabled → optional (auto-selected).
  • If multiple servers are enabled → REQUIRED.

Returns: { ok, jobId, state, message, details } where details is
{ runId, outcome, reason? }. outcome is one of terminated, killed,
already-exited, orphaned. state is "cancelling" for terminated/killed
(poll run-status for the final exit record), "orphaned" for orphaned, or
the run's real final state for already-exited.

Example:
  run-cancel { runId: "run_20260915T120000Z_ab12cd34" }
  run-cancel { runId: "run_20260915T120000Z_ab12cd34", graceMs: 10000 }`,

  "run-retry": `run-retry — Launch a fresh run from an earlier run's stored config snapshot.

Reads the ORIGINAL run's own recorded non-secret config snapshot (profile,
entrypoint, args, env, push/collect settings) rather than the live
runProfiles config, so a config hot-reload or a since-deleted profile cannot
change what actually gets retried. Creates a brand-new runId recording
parentRunId; the original run is untouched and still independently
queryable. Requires the original run to have been launched by a build that
recorded a config snapshot — RETRY_SNAPSHOT_UNAVAILABLE otherwise. Returns
SECRET_REQUIRED if the snapshot declares secretEnv (not re-resolvable this
delivery round).

Parameters:
  runId           (string, required)   runId of the run to retry.
  connectionName  (string, see below)  Server the original run was launched
                  on.
  push            (boolean, optional)  Default the snapshot's own default:
                  true for a profile-backed run that declared push.paths,
                  FALSE for a run launched inline without pushPaths (it
                  never pushed, so its retry does not either). Pass true to
                  force a re-push — only meaningful if the snapshot has push
                  sources, else INVALID_CONFIGURATION — or false to reuse
                  code already on remoteRoot.
  reuseConnection (boolean, optional)  Default true. Set false after a
                  timeout or suspected stale/bad cached connection to force
                  a fresh one for this call.

connectionName rule:
  • If only one server is enabled → optional (auto-selected).
  • If multiple servers are enabled → REQUIRED.

Returns: { ok, jobId, state, message, next, details } — jobId is the NEW
runId. details.parentRunId is the original runId.

Example:
  run-retry { runId: "run_20260915T120000Z_ab12cd34" }
  run-retry { runId: "run_20260915T120000Z_ab12cd34", push: false }`,

  "help": `help — Show detailed usage for one or all tools.

Parameters:
  tool  (string, optional)  Tool name to get help for.
        If omitted, shows a summary of all available tools.

Example:
  help                           → overview of all tools
  help { tool: "execute-command" } → detailed usage for execute-command`,
};

const TOOL_OVERVIEW = `Available tools (use help { tool: "<name>" } for details):

  list-servers      Discover available SSH servers and their status.
  execute-command   Run a shell command on a remote server.
  show-whitelist    Show the active command policy.
  close-connection  Close a cached SSH connection for a server.
  command-status    Poll background status and incremental live output.
  upload            Upload a single file, or a batch of files, to a remote server.
  download          Download a single file from a remote server.
  transfer          Move files: single, recursive, batch upload, or cross-server relay.
  workspace-run     Launch an entrypoint on a remote server -- no YAML config needed (remoteRoot + venv/executable inline, or a saved runProfiles.<name> preset). [push] -> preflight -> launching -> remote-running -> [collect].
  run-status        Query a workspace-run's current status by runId.
  run-logs          Read a byte-offset window of a run's stdout/stderr.
  run-list          List runs on a server, newest first.
  run-cancel        Cancel a run (TERM, then KILL after graceMs; identity-verified).
  run-retry         Launch a fresh run from an earlier run's stored config snapshot.
  help              Show this help or detailed per-tool usage.

Quick start:
  1. list-servers → discover server names
  2. show-whitelist { connectionName: "<name>" } → inspect command policy
  3. execute-command { cmdString: "pwd", connectionName: "<name>" }
  4. command-status { runId: "<runId>" } → poll stream=true background commands
  5. close-connection { connectionName: "<name>" } → drop a stale cached SSH client`;

/**
 * Register help tool
 */
/**
 * The same help table this tool serves, exposed for the documentation
 * coverage guard in src/tests/doc-coverage.test.ts. Read-only by convention;
 * exported rather than duplicated so the test can never drift from what
 * clients actually receive.
 */
export const TOOL_HELP_FOR_TEST: Readonly<Record<string, string>> = TOOL_HELP;
/** The bare `help` (no tool argument) index — the first and often only
 * description of a tool a client ever reads. Exported so doc-coverage can
 * assert it, after it was missed: the per-tool help said workspace-run needs
 * no YAML while this one-liner still said "under a runProfiles.<name> entry". */
export const TOOL_OVERVIEW_FOR_TEST: string = TOOL_OVERVIEW;

export function registerHelpTool(server: McpServer): void {
  server.tool(
    "help",
    "Show detailed usage instructions for one or all tools. Call with no arguments for an overview, or specify a tool name for full parameter docs and examples.",
    {
      tool: z.string().optional().describe("Tool name to get detailed help for. Omit to see an overview of all tools."),
    },
    async ({ tool }) => {
      if (tool) {
        const text = TOOL_HELP[tool];
        if (!text) {
          return {
            content: [{ type: "text", text: `Unknown tool: "${tool}". ${TOOL_OVERVIEW}` }],
            isError: true,
          };
        }
        return { content: [{ type: "text", text }] };
      }

      return { content: [{ type: "text", text: TOOL_OVERVIEW }] };
    },
  );
}
