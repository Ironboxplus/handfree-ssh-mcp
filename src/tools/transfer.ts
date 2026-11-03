import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SSHConnectionManager } from "../services/ssh-connection-manager.js";
import { Logger } from "../utils/logger.js";
import { formatToolErrorResponse, ToolError, toToolError } from "../utils/tool-error.js";
import { transferStrategySchema } from "../contracts/transfer-contract.js";
import { rejectUnknownArguments } from "./strict-arguments.js";

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

  rejectUnknownArguments(server.tool(
    "transfer",
    "Transfer files or directories between the MCP host and remote servers, or between two remotes. Upload/download take connectionName, localPath and remotePath; mode=relay selects remote-to-remote copying and takes sourceServer, sourceRemotePath, destServer and destRemotePath; strategy selects relay/direct/auto. Use recursive for directory upload/download, archive for tar packing, and array localPath for batch upload. See help for mode-specific constraints.",
    {
      mode: z.enum(["upload", "download", "relay"]).describe(
        "upload: local to remote; download: remote to local; relay: remote to remote (sourceServer/sourceRemotePath to destServer/destRemotePath), with transport selected by strategy.",
      ),
      localPath: z.union([
        z.string(),
        z.array(z.string()),
      ]).optional().describe(
        "Upload/download: local path within the MCP working directory/allowedLocalDirectories unless path policy is disabled. Upload arrays batch up to 1000 files into remotePath/<basename>; duplicate targets are rejected. Batch excludes recursive/archive.",
      ),
      remotePath: z.string().optional().describe(
        "Upload/download: absolute remote POSIX path, subject to SFTP path policy.",
      ),
      connectionName: z.string().optional().describe(
        "Upload/download: Server name from list-servers. Required with multiple enabled servers; optional with one.",
      ),
      sourceServer: z.string().optional().describe(
        "Remote-to-remote: source server name.",
      ),
      sourceRemotePath: z.string().optional().describe(
        "Remote-to-remote: absolute source POSIX path, subject to source path policy.",
      ),
      destServer: z.string().optional().describe(
        "Remote-to-remote: destination server name.",
      ),
      destRemotePath: z.string().optional().describe(
        "Remote-to-remote: absolute destination POSIX path, subject to destination path policy.",
      ),
      strategy: transferStrategySchema.optional().describe(
        "Remote-to-remote only: relay (default) uses this MCP host via SFTP, except that a same-server copy is done by the server itself when its SFTP advertises copy-data (OpenSSH 9.0+; connections is then ignored); direct runs rsync or tar|ssh on the source; auto tries direct then falls back with a reason. Direct requires source-to-destination reachability and existing key/host-key trust; keys are never copied or auto-accepted.",
      ),
      recursive: z.boolean().optional().describe(
        "Upload/download directory tree, default false. Not combinable with batch.",
      ),
      skipIfIdentical: z.boolean().optional().describe(
        "Default true: skip matching uploads or relays. Upload skips only when the remote MD5 (computed on the server) equals the MD5 of the bytes to be written, after the shell-script CRLF to LF fix; no remote hash command means upload. Relay checks size+MD5 when available. Downloads are never skipped.",
      ),
      reuseConnection: z.boolean().optional().describe(
        "Default true. Set false to use a fresh SSH connection after a suspected stale connection.",
      ),
      timeout: z.number().positive().optional().describe(
        "Milliseconds for SSH setup and SFTP channel opening; does not cap transfer duration.",
      ),
      vvv: z.boolean().optional().describe(
        "Default false. Include bounded SSH debug output; fresh handshake logs also require reuseConnection=false.",
      ),
      fast: z.boolean().optional().describe(
        "Default true for upload/download: pipelined SFTP chunks. False is a serial compatibility mode and is much slower. Relay uses bounded parallel read-ahead independently of fast.",
      ),
      sftpConcurrency: z.number().int().positive().optional().describe(
        "Upload/download with fast=true: concurrent SFTP chunks. Relay: prefetched chunks, default 64; total window at most 64 MiB.",
      ),
      chunkSize: z.number().int().positive().optional().describe(
        "Upload/download with fast=true: bytes per chunk. Relay: default 32768; total window at most 64 MiB.",
      ),
      fileConcurrency: z.number().int().positive().optional().describe(
        "Recursive upload/download or batch upload: files in flight at once, default 32, maximum 64. They share at most 4 SFTP channels on one SSH connection.",
      ),
      connections: z.number().int().positive().optional().describe(
        "Single file only: 1-8 independent SSH/TCP connections, default 1. Relay opens N per server and requires strategy=relay. Excludes batch/recursive/archive/direct/auto. Above 1 ignores fast/sftpConcurrency/chunkSize; see help for limits.",
      ),
      archive: z.boolean().optional().describe(
        "Default false. Pack into a temporary tar, transfer, extract into the destination directory and clean temporary archives. Does not require recursive=true.",
      ),
      archiveCompression: z.enum(["none", "gzip", "bzip2", "xz", "zstd"]).optional().describe(
        "With archive=true: none (default), gzip, bzip2, xz or zstd. Packing/extracting endpoints need compatible tar/compressor support.",
      ),
      onError: z.enum(["abort", "continue"]).optional().describe(
        "Batch upload only: abort (default) stops scheduling after failure; continue attempts all files. In-flight files finish and all outcomes are reported.",
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
  ));
}
