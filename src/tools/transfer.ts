import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SSHConnectionManager } from "../services/ssh-connection-manager.js";
import { Logger } from "../utils/logger.js";
import { formatToolErrorResponse, ToolError, toToolError } from "../utils/tool-error.js";
import { transferStrategySchema } from "../contracts/transfer-contract.js";

/**
 * Register unified file transfer tool
 * 
 * Supports three modes:
 *   upload   — push a local file or directory to a remote server
 *   download — pull a remote file or directory to the MCP host
 *   relay    — relay a file between two remote servers through the MCP host
 *              with a bounded parallel SFTP read-ahead window
 */
export function registerTransferTool(server: McpServer): void {
  const sshManager = SSHConnectionManager.getInstance();
  const transferService = sshManager.getTransferService();

  server.tool(
    "transfer",
    `Transfer files between the MCP host and remote servers, or between two remote servers.

Modes:
  upload   — push a local file or directory to a remote server.
  download — pull a remote file or directory to the MCP host.
  relay    — copy a file from one remote server to another. Default strategy
             ("relay") streams it via a bounded parallel SFTP read-ahead
             window through this MCP host; no temp file touches the MCP host
             disk, and no SCP or authorized-key exchange between the two
             servers is needed. strategy="direct" instead runs the copy ON
             the source server (rsync, else tar piped over ssh) so this MCP
             host never reads or writes the file's bytes at all; it requires
             the source server to already be able to reach the destination
             directly (no NAT traversal) with its own pre-existing SSH trust
             (host key + non-interactive key auth already set up on the
             source — this tool never transfers a private key). strategy="auto"
             uses direct when possible and otherwise falls back to relay,
             reporting the real reason it fell back.

Set recursive=true when transferring a directory (upload/download only).
Set archive=true to package a file or directory into one temporary tar before
transfer and extract it into the destination directory. Archive mode does not
require recursive=true.
For relay mode, specify sourceServer, sourceRemotePath, destServer, destRemotePath.`,
    {
      mode: z.enum(["upload", "download", "relay"]).describe(
        "'upload' pushes local → remote. 'download' pulls remote → local. 'relay' copies remote-A → remote-B through the MCP host.",
      ),
      localPath: z.union([
        z.string(),
        z.array(z.string()),
      ]).optional().describe(
        "(upload/download only) Path on the MCP host. Upload only: an array batch-uploads multiple independent files to the same remotePath directory, each landing at remotePath/<basename> (basename collisions or repeated paths fail the whole call before anything is written remotely; max 1000 entries; not combinable with archive=true; returns structured JSON instead of the plain-text single-file result). Must be inside the MCP working directory or one of the server's allowedLocalDirectories.",
      ),
      remotePath: z.string().optional().describe(
        "(upload/download only) Absolute POSIX path on the remote server. Any path is allowed by default; restricted to allowedRemoteDirectories only if the server configures that list — call show-whitelist to check.",
      ),
      connectionName: z.string().optional().describe(
        "(upload/download only) Target server name from list-servers. Required when multiple servers are enabled.",
      ),
      sourceServer: z.string().optional().describe(
        "(relay only) Server name to download the file from.",
      ),
      sourceRemotePath: z.string().optional().describe(
        "(relay only) Absolute POSIX file path on the source server. Any path is allowed by default unless the source server configures allowedRemoteDirectories.",
      ),
      destServer: z.string().optional().describe(
        "(relay only) Server name to upload the file to.",
      ),
      destRemotePath: z.string().optional().describe(
        "(relay only) Absolute POSIX destination path on the target server. Any path is allowed by default unless the destination server configures allowedRemoteDirectories.",
      ),
      strategy: transferStrategySchema.optional().describe(
        "(relay only) 'relay' (default) — unchanged behavior, streams through this MCP host via SFTP. " +
          "'direct' — run the copy on the source server (rsync, else tar|ssh; never rclone) so this MCP host " +
          "relays zero file-data bytes; fails explicitly with the precise reason if not possible (source cannot " +
          "reach the destination directly, destination host key not pinned on the source, non-interactive " +
          "existing-remote-key auth unavailable, or no backend installed on the source). " +
          "'auto' — probes the same conditions and uses direct when possible, otherwise falls back to relay " +
          "and reports the real reason it fell back. Never auto-accepts an unknown destination host key and " +
          "never transfers a private key; auth relies entirely on keys/trust already present on the source server.",
      ),
      recursive: z.boolean().optional().describe(
        "(upload/download only) When true, transfers an entire directory tree recursively. Default false.",
      ),
      skipIfIdentical: z.boolean().optional().describe(
        "When true (default), skip the transfer if the destination already matches the source. " +
          "Upload: byte-compare for files \u2264 256 MiB, MD5 otherwise; shell scripts (.sh / .bash / .zsh) ignore CRLF\u2194LF differences. " +
          "Relay: size match + md5sum match on both servers (when available); falls back to transferring if md5sum is missing on either side. " +
          "Download is never skipped. Set to false to force the transfer.",
      ),
      reuseConnection: z.boolean().optional().describe(
        "Default true. Reuse cached SSH connection(s) for SFTP. Set false after a timeout or suspected stale cached connection to force fresh TCP/SSH connection(s) for this transfer; fresh connections close afterwards.",
      ),
      timeout: z.number().positive().optional().describe(
        "Timeout in ms for SSH setup and SFTP channel opening. Transfer stream duration itself is not forcibly interrupted by this option.",
      ),
      vvv: z.boolean().optional().describe(
        "Default false. Append bounded SSH/SFTP debug output for single-file and relay results, and for recursive errors. For fresh ssh2 handshake logs, also set reuseConnection=false.",
      ),
      fast: z.boolean().optional().describe(
        "Default true. Upload/download use ssh2 fastPut/fastGet with parallel SFTP chunks for better throughput. Set false for the buffered compatibility path. Relay mode always uses its bounded parallel read-ahead path.",
      ),
      sftpConcurrency: z.number().int().positive().optional().describe(
        "Upload/download: only used when fast=true. Relay: number of concurrent prefetched source chunks, default 64. The relay window is bounded to 64 MiB.",
      ),
      chunkSize: z.number().int().positive().optional().describe(
        "Upload/download: only used when fast=true. Relay: bytes per prefetched source chunk, default 32768. The relay window is bounded to 64 MiB.",
      ),
      fileConcurrency: z.number().int().positive().optional().describe(
        "Recursive upload/download only: maximum independent files transferred in parallel. Default 4, maximum 8. Each file transferred in parallel opens its own SFTP channel on the same SSH connection, and the cap is kept under OpenSSH's common default MaxSessions=10 so it does not reliably fail against a default-configured remote sshd. This improves directory trees with many small files without creating an archive.",
      ),
      connections: z.number().int().positive().optional().describe(
        "Single file only, in every mode (not recursive, not archive, not batch); for mode=\"relay\" only with strategy=\"relay\" (the default), since direct/auto copy on the source server. Default 1 (today's single-connection behavior, unchanged). A value above 1 moves the file over that many independent SSH/TCP connections, each carrying its own non-overlapping byte range; maximum 8. Relay opens that many connections on EACH server (one per server for a self-relay), one byte range per source/destination pair. Upload and relay write one remote temp file that then replaces the destination path (atomically where the server supports posix-rename@openssh.com, as OpenSSH does; otherwise the old file is removed first), and a failure leaves remotePath untouched. Each connection is a separate TCP+SSH handshake, not an extra channel on one connection, and all N handshakes happen concurrently -- so the relevant remote limit is sshd's MaxStartups (concurrent unauthenticated connections; OpenSSH's default 10:30:100 starts dropping at 10), not MaxSessions. Download measured on a 50ms/1Gbps link against 17.5 MiB/s for one connection: 2 -> 28.5, 4 -> 45.7, 8 -> 53.9 MiB/s, i.e. diminishing returns past 4. Upload of 128 MiB at 50ms RTT against 29.8 MiB/s for one connection: 2 -> 35.2, 4 -> 43.5, 8 -> 44.9 MiB/s. Relay of 128 MiB with a 50ms/1Gbps source leg against 16.4 MiB/s for one connection: 2 -> 23.7, 4 -> 33.6, 8 -> 31.7 MiB/s (8 no better than 4). Gains depend on your link's RTT and bandwidth; none on a fast LAN. Ignores fast/sftpConcurrency/chunkSize and reuseConnection when above 1.",
      ),
      archive: z.boolean().optional().describe(
        "When true, package the source file/directory into one temporary tar, transfer it, extract it into the destination directory, then clean both temporary archives. Default false.",
      ),
      archiveCompression: z.enum(["none", "gzip", "bzip2", "xz", "zstd"]).optional().describe(
        "Only used when archive=true. Compression for the temporary tar; default none. Requires compatible tar/compressor support on every remote endpoint that packs or extracts the archive.",
      ),
      onError: z.enum(["abort", "continue"]).optional().describe(
        "Batch upload only (mode=upload with array localPath). Default 'abort': stop scheduling new files once one fails, drain in-flight ones, then report. 'continue': attempt every file regardless of earlier failures. Both modes report a per-file uploaded/skipped/failed status.",
      ),
    },
    async (params) => {
      try {
        const { mode, archive, archiveCompression, localPath, onError, connections } = params;
        if (!archive && archiveCompression !== undefined) {
          throw new ToolError(
            "INVALID_CONFIGURATION",
            "archiveCompression requires archive=true",
            false,
          );
        }
        if (archive && Array.isArray(localPath)) {
          throw new ToolError(
            "INVALID_CONFIGURATION",
            "archive=true is not supported with a batch (array) localPath",
            false,
          );
        }
        // connections is single-file only (download, upload, and relay with
        // strategy="relay") -- reject it up front for every other shape
        // rather than silently ignoring it.
        if (connections !== undefined) {
          if (mode === "relay" && params.strategy !== undefined && params.strategy !== "relay") {
            throw new ToolError(
              "INVALID_CONFIGURATION",
              `connections is only supported with strategy="relay", not strategy="${params.strategy}"`,
              false,
            );
          }
          if (Array.isArray(localPath)) {
            throw new ToolError("INVALID_CONFIGURATION", "connections is not supported with a batch (array) localPath", false);
          }
          if (archive) {
            throw new ToolError("INVALID_CONFIGURATION", "connections is not supported with archive=true", false);
          }
          if (params.recursive) {
            throw new ToolError("INVALID_CONFIGURATION", "connections is not supported with recursive=true", false);
          }
        }
        const compression = archiveCompression ?? "none";

        if (mode === "relay") {
          const { sourceServer, sourceRemotePath, destServer, destRemotePath, skipIfIdentical, reuseConnection, timeout, vvv, sftpConcurrency, chunkSize, strategy } = params;
          if (!sourceServer || !sourceRemotePath || !destServer || !destRemotePath) {
            return {
              content: [{ type: "text", text: "relay mode requires: sourceServer, sourceRemotePath, destServer, destRemotePath" }],
              isError: true,
            };
          }
          const relayOptions = {
            reuseConnection, timeout, vvv, sftpConcurrency, chunkSize,
            ...(strategy === undefined ? {} : { strategy }),
            ...(connections === undefined ? {} : { connections }),
          };
          const result = archive
            ? await transferService.transferArchiveBetweenServers(
                sourceServer,
                sourceRemotePath,
                destServer,
                destRemotePath,
                compression,
                relayOptions,
              )
            : await transferService.transferBetweenServers(
                sourceServer,
                sourceRemotePath,
                destServer,
                destRemotePath,
                { skipIfIdentical: skipIfIdentical !== false, ...relayOptions },
              );
          return { content: [{ type: "text", text: result }] };
        }

        // upload or download
        const { remotePath, connectionName, recursive, skipIfIdentical, reuseConnection, timeout, vvv, fast, sftpConcurrency, chunkSize, fileConcurrency } = params;
        if (!localPath || !remotePath) {
          return {
            content: [{ type: "text", text: `${mode} mode requires: localPath, remotePath` }],
            isError: true,
          };
        }

        if (Array.isArray(localPath)) {
          // §5.7: batch (array localPath) is upload-only this round; download
          // and relay array forms are explicitly out of scope.
          if (mode !== "upload") {
            throw new ToolError(
              "INVALID_CONFIGURATION",
              `Batch (array) localPath is only supported for mode="upload", not mode="${mode}"`,
              false,
            );
          }
          if (recursive) {
            throw new ToolError(
              "INVALID_CONFIGURATION",
              "recursive=true is not supported with a batch (array) localPath",
              false,
            );
          }
        }

        const resolvedName = sshManager.resolveServer(connectionName);
        const sftpOptions = {
          reuseConnection,
          timeout,
          vvv,
          fast: fast !== false,
          sftpConcurrency,
          chunkSize,
          ...(fileConcurrency === undefined ? {} : { fileConcurrency }),
          ...(connections === undefined ? {} : { connections }),
        };
        const uploadOptions = { skipIfIdentical: skipIfIdentical !== false, ...sftpOptions };

        if (Array.isArray(localPath)) {
          const batchResult = await transferService.uploadBatch(localPath, remotePath, resolvedName, {
            ...uploadOptions,
            onError,
          });
          return { content: [{ type: "text", text: JSON.stringify(batchResult) }] };
        }

        if (archive) {
          const result = mode === "upload"
            ? await transferService.uploadArchive(localPath, remotePath, resolvedName, compression, sftpOptions)
            : await transferService.downloadArchive(remotePath, localPath, resolvedName, compression, sftpOptions);
          return { content: [{ type: "text", text: result }] };
        }

        if (recursive) {
          let files: string[];
          if (mode === "upload") {
            files = await transferService.uploadDirectory(localPath, remotePath, resolvedName, uploadOptions);
          } else {
            files = await transferService.downloadDirectory(remotePath, localPath, resolvedName, sftpOptions);
          }
          const summary = `Recursive ${mode} complete. ${files.length} file(s) transferred.`;
          return {
            content: [{ type: "text", text: JSON.stringify({ summary, files }) }],
          };
        }

        // Single file
        if (mode === "upload") {
          const result = await transferService.upload(localPath, remotePath, resolvedName, uploadOptions);
          return { content: [{ type: "text", text: result }] };
        } else {
          const result = await transferService.download(remotePath, localPath, resolvedName, sftpOptions);
          return { content: [{ type: "text", text: result }] };
        }
      } catch (error: unknown) {
        const toolError = toToolError(error, "SFTP_ERROR");
        Logger.handleError(toolError, "File transfer failed");
        return {
          content: [{ type: "text", text: formatToolErrorResponse(toolError) }],
          isError: true,
        };
      }
    },
  );
}
