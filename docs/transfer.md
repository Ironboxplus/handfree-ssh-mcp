[← Back to README](../README.md)

# Transfers

## Upload behaviors

- **CRLF auto-fix for shell scripts.** When uploading a `.sh`, `.bash`, or `.zsh` file, any `\r\n` line endings are automatically converted to `\n` before the bytes are sent. The response notes when this happens and how many line endings were rewritten. The local file on disk is left untouched.
- **Skip-if-identical (default on).** Before transferring, `upload` checks whether the remote file already holds exactly the bytes it would write. It stats the remote file first (missing or different size means upload). For a same-size file it computes the MD5 on both sides in parallel: the remote one by a command **on the server** (so no file content crosses the network), the local one with Node `crypto`. The remote command is detected once per server, the way rclone does it: `md5sum`, `md5 -r` and `rclone md5sum` are tried in that order and the first whose output for empty input is the MD5 of empty input (`d41d8cd98f00b204e9800998ecf8427e`) is used; the result, including "none", is cached per server. **If the server has no usable hash command the file is uploaded** — the remote file is never read back over SFTP just to compare it. A match skips the upload and the response says so. Pass `skipIfIdentical: false` to force a re-upload. Recursive and batch uploads apply the same check per file.
- **Line endings and skipping.** "Identical" means the remote bytes equal the bytes that would be written, i.e. after the CRLF fix above. A local shell script with CRLF whose remote copy is already LF is skipped; a remote copy with CRLF and a local script with LF is re-uploaded, which turns the remote copy into LF. Other file types are never rewritten, so a CRLF-only difference there is a real difference.
- **Fast single-file SFTP (default on).** `upload`, `download`, and `transfer` upload/download mode use ssh2 `fastPut` / `fastGet` unless `fast: false` is set; this default is the same for every caller, including `workspace-run` push and collect. Optional `sftpConcurrency` and `chunkSize` tune ssh2's parallel chunks; omitted values use ssh2 defaults. Fast uploads do not preload the local file (a skip check on a same-size file streams the local file through MD5). If a shell-script upload needs CRLF-to-LF conversion, it falls back to the buffered upload path. `fast: false` is a serial compatibility mode — one request in flight at a time — and is much slower on any link with latency; leave it unset unless a server misbehaves with pipelined requests.
- **Recursive small-file concurrency.** Non-archive recursive upload/download transfers independent files through a bounded worker pool. `fileConcurrency` is the number of files in flight; it defaults to 32 and is capped at 64. The files share at most `min(fileConcurrency, 4)` SFTP channels (worker `i` uses channel `i mod channels`): an SFTP channel multiplexes requests, and the speed of a small-file tree is files in flight divided by round trips per file, so more files in flight is what helps, not more channels. Four channels also leave room under the remote's `MaxSessions` (OpenSSH's common default is 10). A channel is discarded and reopened only after a connection-level failure or an inactivity stall; a single file's SFTP error (missing file, permission denied, ...) does not touch it. With `reuseConnection: false` the whole call shares one one-shot connection. Directory listing uses the same shared channels. The directory tree is created first, so parallel file writes never race their parent directories.
- **Tar-before-transfer archive mode.** Set `archive: true` on `transfer` to package one source file or directory into a temporary tar, transfer that single archive, extract it into the destination directory, and clean temporary archives on the MCP host and remote endpoints. The source basename is preserved. `archiveCompression` accepts `none` (default), `gzip`, `bzip2`, `xz`, or `zstd`; every endpoint that packs or extracts must provide compatible `tar`/compressor support. Archive mode works for upload, download, and relay and does not require `recursive: true`.
- **Windowed relay SFTP (default on).** `transfer mode=relay` reads and writes explicit file ranges rather than serially piping one stream. It keeps a bounded source read-ahead window in MCP-host memory while destination writes are pending, so one source/destination RTT pair does not serialize the whole transfer. The default is `sftpConcurrency: 64` and `chunkSize: 32768` (at most 2 MiB of application chunk buffers); tune either parameter for the link, up to a 64 MiB window. No relay payload is written to local disk. Destination ranges may finish out of order, then the existing size and best-effort MD5 checks verify the final file.
- **Relay skip-if-identical (default on).** `transfer mode=relay` does the same check between two remote servers: matching size on both sides plus matching MD5 (the same detected remote hash command as for uploads) skips the transfer. If no hash command is usable on either server, the check falls back to a normal transfer.
- **Same-server relay uses the server's own copy (`copy-data`).** When `sourceServer` and `destServer` are the same server, `strategy` is `relay` (default) or `auto`, and the server's SFTP advertises the `copy-data` extension (OpenSSH 9.0 and newer), the server copies the file itself: no bytes travel to this host and back. The copy goes to a new temp file next to the destination in 64 MiB steps (each step feeds the inactivity timeout), is verified by size and MD5, and only then replaces the destination, so a failure leaves the destination untouched. `connections` is ignored on this path. Without `copy-data` the normal relay runs, and with `vvv: true` the response says why. `strategy: "direct"` is unaffected.
- **Relay `strategy` (direct transfer).** `transfer mode=relay` accepts `strategy: "relay" | "direct" | "auto"`. `"relay"` (default) is the windowed-SFTP behavior above, unchanged. `"direct"` runs the copy **on the source server** (`rsync`, else `tar` piped over `ssh`; never `rclone`) so this MCP host never reads or writes the file's bytes — it fails explicitly, with the precise reason, if the source cannot reach the destination directly, the destination host key is not already pinned on the source, non-interactive `existing-remote-key` auth is unavailable, or neither backend is installed on the source. Auth relies entirely on trust already present on the source server (its own default SSH identity/`known_hosts`); this tool never reads, constructs, or transfers a private key, and never passes `StrictHostKeyChecking=no` or an equivalent auto-accept flag. Direct transfer cannot traverse NAT — point it at a reachable pair, use a jump host/overlay network, or fall back to `strategy: "relay"`. `"auto"` probes the same conditions (route, host key, backend availability, auth, and the destination's path policy) with a real timeout and uses direct when possible; otherwise it falls back to relay and reports the accurate reason it did so.
- **Batch upload (array `localPath`).** Both `upload` and `transfer mode=upload` accept `localPath` as either a single string (unchanged 1.x behavior, plain-text response) or an array of local file paths for a batch upload. In batch mode, `remotePath` must be a directory and every source lands at `remotePath/<basename>`. Basename collisions across sources, or the exact same path repeated in the array, fail the whole call with `BATCH_TARGET_COLLISION` (listing the conflicts) **before any remote write happens** — collisions are never silently deduplicated. An empty array returns `INVALID_CONFIGURATION`; more than 1000 entries returns `BATCH_TOO_LARGE`. Concurrency reuses the same `fileConcurrency` (default 32, capped at 64) as recursive transfers. `onError` controls failure handling: `"abort"` (default) stops scheduling new files once one fails and drains in-flight ones; `"continue"` attempts every file regardless of earlier failures. Both modes return a per-file `uploaded` / `skipped` / `failed` status with failure reasons. Every file still goes through the normal single-file rules (skip-if-identical, CRLF→LF fix, `fast`, path policy) — nothing is reimplemented for batch mode. The response is structured JSON (`{ results, total, uploadedCount, skippedCount, failedCount, crlfFixedCount }`) instead of the plain-text single-file result. `archive: true` is not supported together with a batch `localPath` in this release; `download`/`relay` do not accept an array `localPath`.

## Multi-connection download

`download` and `transfer mode=download` accept `connections` (default `1`, maximum `8`). At `1` the behavior is exactly as before. Above `1`, the file is split into that many non-overlapping byte ranges, each pulled over its **own independent SSH/TCP connection**, written by positional writes into a preallocated local temp file, then size-verified and atomically renamed into place. A failure on any connection cancels the rest, deletes the temp file, and never touches the destination path.

Independent *connections* is the point, and it is not the same as opening more SFTP channels: every channel on one SSH connection shares that connection's flow-control window (ssh2 hardcodes it at 2 MiB), so extra channels buy nothing. A second connection brings a second window.

This helps on **high-latency** links, where one connection's window bounds throughput to roughly window/RTT. It does nothing useful on a fast LAN. Each connection is a separate SSH handshake, and all of them are made concurrently (so the cost is about one handshake, not N), which makes sshd's `MaxStartups` the remote limit that matters, not `MaxSessions` — OpenSSH's default `10:30:100` starts dropping unauthenticated connections at 10.

The connections are **pooled per server**: a successful transfer parks them, and the next multi-connection download, upload or relay on that server reuses them without any handshake. At most 8 exist per server — a transfer that needs more than are free waits for them, and a relay reserves both servers in a fixed order so two opposite relays cannot deadlock. Idle connections close after 60 s, and `close-connection` closes them at once. A failed transfer closes its connections rather than pooling them, and a pooled connection found dead is replaced transparently. `reuseConnection=false` bypasses the pool: fresh connections, closed afterwards.

Measured on a real `tc netem` lab link at 50 ms / 1 Gbps (128 MiB file, median of 3 runs, SHA-256 verified every run):

| setting | throughput |
|---|---|
| default single connection | 17.54 MiB/s |
| `connections: 2` | 28.54 MiB/s |
| `connections: 4` | 45.71 MiB/s |
| `connections: 8` | 53.86 MiB/s |

That table is a **first call**, with every handshake inside the timing. A repeated call on the same server reuses the pooled connections and skips them: in the same lab, repeated calls measured 35.2 MiB/s at `2`, 63.2 at `4` and 82.8 at `8` (the 4-connection first call measured 45.6 in that run; the ~0.8 s difference is one concurrent handshake round).

Those numbers describe that one shaped link only; your own gain depends on RTT and bandwidth. Returns diminish past `4`. (Releases before 2.1.4 opened the connections one after another, which cost ~0.7 s per connection on that link and made `8` no faster than a single connection; the data path itself was never the bottleneck.) `connections` applies to single files only and is rejected for relay `strategy: "direct"`/`"auto"`, a batch (array) `localPath`, `recursive: true`, and `archive: true`.

## Multi-connection upload

`upload` and `transfer mode=upload` accept the same `connections` (default `1`, maximum `8`). Above `1`, each byte range is written over its own independent SSH/TCP connection into **one remote temp file** next to the target. Only connection 0 creates/truncates it; the others open it without truncating. After every range succeeds and the temp file's size is verified, it replaces `remotePath` — as one atomic rename where the server advertises `posix-rename@openssh.com` (every OpenSSH does; verified against a real OpenSSH), otherwise by removing the old file and then renaming, which leaves a brief window where `remotePath` does not exist. If any connection fails, the temp file is deleted and `remotePath` keeps its previous contents. Skip-if-identical and the shell-script CRLF→LF fix still apply.

Measured uploading a 128 MiB file at 50 ms RTT (SHA-256 verified inside the container every run, the same remote path overwritten each time):

| setting | throughput |
|---|---|
| default single connection (`fastPut`) | 29.84 MiB/s |
| `connections: 2` | 35.18 MiB/s |
| `connections: 4` | 43.48 MiB/s |
| `connections: 8` | 44.92 MiB/s |

The gains are smaller than for download. Those figures include about 0.7 s of connection setup per call. With the pool, repeated uploads skip it: 38.9 MiB/s at `2`, 53.9 at `4`, 52.7 at `8` against 29.1 for one connection. In that lab only the server-to-client direction is bandwidth-shaped, so the upload numbers reflect the 50 ms RTT but no 1 Gbps ceiling.

## Multi-connection relay

`transfer mode=relay` accepts the same `connections` with the default `strategy: "relay"` (it is rejected with `"direct"`/`"auto"`, which copy on the source server and have no byte ranges to split). Above `1`, the file is split into that many byte ranges, and each range moves over its own **pair** of independent connections — one to the source, one to the destination — so both legs get a window per range. That is `N` connections on each server; a self-relay (same server on both ends) opens `N` connections in total, each carrying one read and one write channel. Unlike the single-connection relay, which writes the destination in place, the destination is written to a temp file, checked for size and md5, and only then renamed over the target (the same replace step as multi-connection upload). If anything fails, the temp file is deleted and the target keeps its previous contents.

Measured relaying a 128 MiB file between two lab containers, with the source → MCP-host leg shaped to 50 ms / 1 Gbps (SHA-256 verified inside the destination container every run):

| setting | throughput |
|---|---|
| default single connection (windowed relay) | 16.36 MiB/s |
| `connections: 2` | 23.74 MiB/s |
| `connections: 4` | 33.64 MiB/s |
| `connections: 8` | 31.71 MiB/s |

`8` was no faster than `4` there; use `4`. Repeated relays on pooled connections measured 26.6 MiB/s at `2`, 37.3 at `4` and 37.0 at `8`.

## Browse a remote directory

Use `sftp-list` before choosing files to transfer. It opens an SFTP channel on the existing SSH connection and needs no remote shell, Python or experiment platform. It respects the configured remote path policy, including the resolved directory target.

```json
{"connectionName":"my-server","remotePath":"/home/user","page":1,"pageSize":50,"showHidden":false,"sort":"name","direction":"asc"}
```

The response includes the canonical `path`, allowed `parent` (or null), `total`, `page`, `pageSize`, and `entries` containing `name`, `type`, `size` in bytes and ISO `modifiedAt`. Directories appear first. `query` filters names case-insensitively; optional `names` inspects exact names including hidden entries. Pages start at 1 and contain at most 200 entries. SFTP still reads the directory listing to sort/filter it; only the requested page is returned. Omit `remotePath` to open the first allowed root or the SFTP home directory. Windows SFTP paths use `/C:/...`. Symlinks are identified separately.

## Rename and delete remote entries

`sftp-manage` uses the same remote directory allowlist, including resolved parent paths, and no shell commands. Pass `action: "rename"`, `remotePath` and a single `newName` to rename within the same directory. Existing targets are never overwritten. Pass `action: "delete"` and `confirm: true` only after the user has confirmed the exact server and full path. Nonempty directories additionally require `recursive: true`. Deletion is permanent; symlinks are unlinked rather than traversed. Filesystem roots cannot be modified. Mutations are not automatically retried after an uncertain connection failure: inspect the current directory state first.
