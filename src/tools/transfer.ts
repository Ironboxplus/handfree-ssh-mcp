import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SSHConnectionManager } from "../services/ssh-connection-manager.js";
import { Logger } from "../utils/logger.js";
import { formatToolErrorResponse, toToolError } from "../utils/tool-error.js";

/**
 * Register unified file transfer tool
 * 
 * Supports three modes:
 *   upload   — push a local file or directory to a remote server
 *   download — pull a remote file or directory to the MCP host
 *   relay    — relay a file between two remote servers through the MCP host
 */
export function registerTransferTool(server: McpServer): void {
  const sshManager = SSHConnectionManager.getInstance();

  server.tool(
    "transfer",
    `Transfer files between the MCP host and remote servers, or between two remote servers.

Modes:
  upload   — push a local file or directory to a remote server.
  download — pull a remote file or directory to the MCP host.
  relay    — stream a file from one remote server to another via SFTP piping.
             No temp file touches the MCP host disk. No SCP or authorized-key
             exchange between the two servers is needed — each side uses its
             own existing SSH session.

Set recursive=true when transferring a directory (upload/download only).
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
        "Default false. Upload/download only: use ssh2 fastPut/fastGet for single files, with parallel SFTP chunks for better throughput. Relay mode keeps the streaming pipe path.",
      ),
      sftpConcurrency: z.number().int().positive().optional().describe(
        "Only used when fast=true for upload/download. Number of concurrent SFTP chunks; omitted uses ssh2's default.",
      ),
      chunkSize: z.number().int().positive().optional().describe(
        "Only used when fast=true for upload/download. Chunk size in bytes; omitted uses ssh2's default.",
      ),
    },
    async (params) => {
      try {
        const { mode } = params;

        if (mode === "relay") {
          const { sourceServer, sourceRemotePath, destServer, destRemotePath, skipIfIdentical, reuseConnection, timeout, vvv } = params;
          if (!sourceServer || !sourceRemotePath || !destServer || !destRemotePath) {
            return {
              content: [{ type: "text", text: "relay mode requires: sourceServer, sourceRemotePath, destServer, destRemotePath" }],
              isError: true,
            };
          }
          const result = await sshManager.transferBetweenServers(
            sourceServer, sourceRemotePath, destServer, destRemotePath,
            { skipIfIdentical: skipIfIdentical !== false, reuseConnection, timeout, vvv },
          );
          return { content: [{ type: "text", text: result }] };
        }

        // upload or download
        const { localPath, remotePath, connectionName, recursive, skipIfIdentical, reuseConnection, timeout, vvv, fast, sftpConcurrency, chunkSize } = params;
        if (!localPath || !remotePath) {
          return {
            content: [{ type: "text", text: `${mode} mode requires: localPath, remotePath` }],
            isError: true,
          };
        }

        const resolvedName = sshManager.resolveServer(connectionName);
        const sftpOptions = { reuseConnection, timeout, vvv, fast, sftpConcurrency, chunkSize };
        const uploadOptions = { skipIfIdentical: skipIfIdentical !== false, ...sftpOptions };

        if (recursive) {
          let files: string[];
          if (mode === "upload") {
            files = await sshManager.uploadDirectory(localPath, remotePath, resolvedName, uploadOptions);
          } else {
            files = await sshManager.downloadDirectory(remotePath, localPath, resolvedName, sftpOptions);
          }
          const summary = `Recursive ${mode} complete. ${files.length} file(s) transferred.`;
          return {
            content: [{ type: "text", text: JSON.stringify({ summary, files }) }],
          };
        }

        // Single file
        if (mode === "upload") {
          const result = await sshManager.upload(localPath, remotePath, resolvedName, uploadOptions);
          return { content: [{ type: "text", text: result }] };
        } else {
          const result = await sshManager.download(remotePath, localPath, resolvedName, sftpOptions);
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
