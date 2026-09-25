import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SSHConnectionManager } from "../services/ssh-connection-manager.js";
import { Logger } from "../utils/logger.js";
import { formatToolErrorResponse, ToolError, toToolError } from "../utils/tool-error.js";

/**
 * Register file upload tool
 */
export function registerUploadTool(server: McpServer): void {
  const sshManager = SSHConnectionManager.getInstance();
  const transferService = sshManager.getTransferService();

  server.tool(
    "upload",
    "Upload a local file (or, with an array localPath, a batch of local files) from the MCP host to the remote server over SFTP. Use this when the file(s) already exist locally and must be copied to the selected SSH server. By default any absolute remote path is allowed; if the server configures allowedRemoteDirectories, the destination must live inside one of those entries — call show-whitelist to check. " +
      "Batch mode (array localPath): remotePath must be a directory; each source lands at remotePath/<basename>, and the response is structured JSON (not the plain-text single-file result) with a per-file uploaded/skipped/failed status. " +
      "Shell scripts (.sh / .bash / .zsh) with CRLF line endings are auto-converted to LF before upload (the response notes when this happens). " +
      "By default the upload is skipped if the remote file is already identical to the local one (byte-compare for files \u2264 256 MiB, MD5 otherwise; shell scripts are compared in a line-ending-agnostic way so CRLF\u2194LF differences alone do not trigger a re-upload) \u2014 pass skipIfIdentical=false to force a re-upload.",
    {
      localPath: z.union([
        z.string(),
        z.array(z.string()),
      ]).describe("Path to a local file on the MCP host, or an array of paths for batch upload. Batch mode: each source lands at remotePath/<basename>; basename collisions across sources, or the same path repeated, fail the whole call before anything is written remotely. Max 1000 entries (INVALID_CONFIGURATION if empty, BATCH_TOO_LARGE if over 1000). Must be inside the MCP working directory or one of the server's allowedLocalDirectories."),
      remotePath: z.string().describe("Destination path on the remote server. Must be an absolute POSIX path (e.g. /home/user/uploads/file.txt); restricted to allowedRemoteDirectories only if the server configures that list. For batch upload (array localPath) this must be a directory."),
      connectionName: z.string().optional().describe("Target server name from list-servers. Required when multiple servers are enabled; optional when only one server is enabled."),
      skipIfIdentical: z.boolean().optional().describe("When true (default), skip the upload if the remote file is already identical (byte-compare for files \u2264 256 MiB, MD5 otherwise; shell scripts ignore CRLF\u2194LF differences). Set to false to force re-upload."),
      reuseConnection: z.boolean().optional().describe("Default true. Reuse the cached SSH connection for SFTP. Set false after a timeout or suspected stale cached SSH connection to force a fresh TCP/SSH connection for this transfer; the fresh connection closes afterwards."),
      timeout: z.number().positive().optional().describe("Timeout in ms for SSH setup and SFTP channel opening. Transfer stream duration itself is not forcibly interrupted by this option."),
      vvv: z.boolean().optional().describe("Default false. Append bounded SSH/SFTP debug output. For fresh ssh2 handshake logs, also set reuseConnection=false."),
      fast: z.boolean().optional().describe("Default true. Use ssh2 fastPut for a single-file upload, which performs parallel SFTP reads/writes for better throughput. Set false for the buffered compatibility path. If a shell script needs CRLF-to-LF conversion, the upload still falls back to the normal safe path."),
      sftpConcurrency: z.number().int().positive().optional().describe("Only used when fast=true. Number of concurrent SFTP chunks for ssh2 fastPut; omitted uses ssh2's default."),
      chunkSize: z.number().int().positive().optional().describe("Only used when fast=true. Chunk size in bytes for ssh2 fastPut; omitted uses ssh2's default."),
      onError: z.enum(["abort", "continue"]).optional().describe("Batch mode only (array localPath). Default 'abort': stop scheduling new files once one fails, drain in-flight ones, then report. 'continue': attempt every file regardless of earlier failures. Both modes report a per-file uploaded/skipped/failed status."),
      fileConcurrency: z.number().int().positive().optional().describe("Batch mode only (array localPath). Maximum independent files uploaded in parallel. Default 4, maximum 8; each parallel file opens its own SFTP channel on the same SSH connection, kept under OpenSSH's common default MaxSessions=10."),
      connections: z.number().int().positive().optional().describe("Single file only (not a batch/array localPath). Default 1 (today's single-connection behavior, unchanged). A value above 1 writes the file over that many independent SSH/TCP connections, each carrying its own non-overlapping byte range into one remote temp file that then replaces remotePath (atomically when the server supports posix-rename@openssh.com, as OpenSSH does; otherwise the old file is removed first); a failure on any connection leaves remotePath untouched. Maximum 8. Each connection is a separate TCP+SSH handshake, not an extra channel on one connection, and all N happen concurrently -- so the relevant remote limit is sshd's MaxStartups (OpenSSH's default 10:30:100 starts dropping at 10), not MaxSessions. Helps on high-latency links; pointless on a fast LAN. Measured uploading 128 MiB at 50ms RTT against 29.8 MiB/s for one connection: 2 -> 35.2, 4 -> 43.5, 8 -> 44.9 MiB/s -- smaller gains than download, and those figures include ~0.7s of connection setup that a larger file amortizes. Ignores fast/sftpConcurrency/chunkSize when above 1; reuseConnection=false bypasses the pool (fresh connections, closed afterwards). The connections are pooled per server (at most 8 per server; a transfer needing more waits; idle ones close after 60 s), so a repeated transfer reuses them and skips the handshakes."),
    },
    async ({ localPath, remotePath, connectionName, skipIfIdentical, reuseConnection, timeout, vvv, fast, sftpConcurrency, chunkSize, onError, fileConcurrency, connections }) => {
      try {
        if (connections !== undefined && Array.isArray(localPath)) {
          throw new ToolError(
            "INVALID_CONFIGURATION",
            "connections is not supported with a batch (array) localPath",
            false,
          );
        }
        const resolvedName = sshManager.resolveServer(connectionName);
        const sftpOptions = {
          skipIfIdentical: skipIfIdentical !== false,
          reuseConnection,
          timeout,
          vvv,
          fast: fast !== false,
          sftpConcurrency,
          chunkSize,
        };

        if (Array.isArray(localPath)) {
          const batchResult = await transferService.uploadBatch(localPath, remotePath, resolvedName, {
            ...sftpOptions,
            onError,
            ...(fileConcurrency === undefined ? {} : { fileConcurrency }),
          });
          return {
            content: [{ type: "text", text: JSON.stringify(batchResult) }],
          };
        }

        const result = await transferService.upload(localPath, remotePath, resolvedName, {
          ...sftpOptions,
          ...(connections === undefined ? {} : { connections }),
        });
        return {
          content: [{ type: "text", text: result }],
        };
      } catch (error: unknown) {
        const toolError = toToolError(error, "SFTP_ERROR");
        Logger.handleError(toolError, "Failed to upload file");
        return {
          content: [{ type: "text", text: formatToolErrorResponse(toolError) }],
          isError: true,
        };
      }
    }
  );
}
