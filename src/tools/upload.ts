import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SSHConnectionManager } from "../services/ssh-connection-manager.js";
import { Logger } from "../utils/logger.js";
import { formatToolErrorResponse, toToolError } from "../utils/tool-error.js";

/**
 * Register file upload tool
 */
export function registerUploadTool(server: McpServer): void {
  const sshManager = SSHConnectionManager.getInstance();

  server.tool(
    "upload",
    "Upload a local file from the MCP host to the remote server over SFTP. Use this when the file already exists locally and must be copied to the selected SSH server. By default any absolute remote path is allowed; if the server configures allowedRemoteDirectories, the destination must live inside one of those entries — call show-whitelist to check. " +
      "Shell scripts (.sh / .bash / .zsh) with CRLF line endings are auto-converted to LF before upload (the response notes when this happens). " +
      "By default the upload is skipped if the remote file is already identical to the local one (byte-compare for files \u2264 256 MiB, MD5 otherwise; shell scripts are compared in a line-ending-agnostic way so CRLF\u2194LF differences alone do not trigger a re-upload) \u2014 pass skipIfIdentical=false to force a re-upload.",
    {
      localPath: z.string().describe("Path to a local file on the MCP host. Must be inside the MCP working directory or one of the server's allowedLocalDirectories."),
      remotePath: z.string().describe("Destination path on the remote server. Must be an absolute POSIX path (e.g. /home/user/uploads/file.txt); restricted to allowedRemoteDirectories only if the server configures that list."),
      connectionName: z.string().optional().describe("Target server name from list-servers. Required when multiple servers are enabled; optional when only one server is enabled."),
      skipIfIdentical: z.boolean().optional().describe("When true (default), skip the upload if the remote file is already identical (byte-compare for files \u2264 256 MiB, MD5 otherwise; shell scripts ignore CRLF\u2194LF differences). Set to false to force re-upload."),
      reuseConnection: z.boolean().optional().describe("Default true. Reuse the cached SSH connection for SFTP. Set false after a timeout or suspected stale cached SSH connection to force a fresh TCP/SSH connection for this transfer; the fresh connection closes afterwards."),
      timeout: z.number().positive().optional().describe("Timeout in ms for SSH setup and SFTP channel opening. Transfer stream duration itself is not forcibly interrupted by this option."),
      vvv: z.boolean().optional().describe("Default false. Append bounded SSH/SFTP debug output. For fresh ssh2 handshake logs, also set reuseConnection=false."),
      fast: z.boolean().optional().describe("Default false. When true, use ssh2 fastPut for a single-file upload, which performs parallel SFTP reads/writes for better throughput. If a shell script needs CRLF-to-LF conversion, the upload falls back to the normal safe path."),
      sftpConcurrency: z.number().int().positive().optional().describe("Only used when fast=true. Number of concurrent SFTP chunks for ssh2 fastPut; omitted uses ssh2's default."),
      chunkSize: z.number().int().positive().optional().describe("Only used when fast=true. Chunk size in bytes for ssh2 fastPut; omitted uses ssh2's default."),
    },
    async ({ localPath, remotePath, connectionName, skipIfIdentical, reuseConnection, timeout, vvv, fast, sftpConcurrency, chunkSize }) => {
      try {
        const resolvedName = sshManager.resolveServer(connectionName);
        const result = await sshManager.upload(localPath, remotePath, resolvedName, {
          skipIfIdentical: skipIfIdentical !== false,
          reuseConnection,
          timeout,
          vvv,
          fast,
          sftpConcurrency,
          chunkSize,
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
