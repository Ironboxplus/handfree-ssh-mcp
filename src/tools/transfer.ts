import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SSHConnectionManager } from "../services/ssh-connection-manager.js";
import { Logger } from "../utils/logger.js";
import { formatToolErrorResponse, ToolError, toToolError } from "../utils/tool-error.js";

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
  relay    — stream a file from one remote server to another via a bounded
             parallel SFTP read-ahead window. No temp file touches the MCP host
             disk. No SCP or authorized-key
             exchange between the two servers is needed — each side uses its
             own existing SSH session.

Set recursive=true when transferring a directory (upload/download only).
Set archive=true to package a file or directory into one temporary tar before
transfer and extract it into the destination directory. Archive mode does not
require recursive=true.
For relay mode, specify sourceServer, sourceRemotePath, destServer, destRemotePath.`,
    {
      mode: z.enum(["upload", "download", "relay"]).describe(
        "'upload' pushes local → remote. 'download' pulls remote → local. 'relay' copies remote-A → remote-B through the MCP host.",
      ),
      localPath: z.string().optional().describe(
        "(upload/download only) Path on the MCP host. Must be inside the MCP working directory or one of the server's allowedLocalDirectories.",
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
      archive: z.boolean().optional().describe(
        "When true, package the source file/directory into one temporary tar, transfer it, extract it into the destination directory, then clean both temporary archives. Default false.",
      ),
      archiveCompression: z.enum(["none", "gzip", "bzip2", "xz", "zstd"]).optional().describe(
        "Only used when archive=true. Compression for the temporary tar; default none. Requires compatible tar/compressor support on every remote endpoint that packs or extracts the archive.",
      ),
    },
    async (params) => {
      try {
        const { mode, archive, archiveCompression } = params;
        if (!archive && archiveCompression !== undefined) {
          throw new ToolError(
            "INVALID_CONFIGURATION",
            "archiveCompression requires archive=true",
            false,
          );
        }
        const compression = archiveCompression ?? "none";

        if (mode === "relay") {
          const { sourceServer, sourceRemotePath, destServer, destRemotePath, skipIfIdentical, reuseConnection, timeout, vvv, sftpConcurrency, chunkSize } = params;
          if (!sourceServer || !sourceRemotePath || !destServer || !destRemotePath) {
            return {
              content: [{ type: "text", text: "relay mode requires: sourceServer, sourceRemotePath, destServer, destRemotePath" }],
              isError: true,
            };
          }
          const relayOptions = { reuseConnection, timeout, vvv, sftpConcurrency, chunkSize };
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
        const { localPath, remotePath, connectionName, recursive, skipIfIdentical, reuseConnection, timeout, vvv, fast, sftpConcurrency, chunkSize, fileConcurrency } = params;
        if (!localPath || !remotePath) {
          return {
            content: [{ type: "text", text: `${mode} mode requires: localPath, remotePath` }],
            isError: true,
          };
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
        };
        const uploadOptions = { skipIfIdentical: skipIfIdentical !== false, ...sftpOptions };

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
