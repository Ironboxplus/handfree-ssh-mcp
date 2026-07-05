import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SSHConnectionManager } from "../services/ssh-connection-manager.js";
import { Logger } from "../utils/logger.js";
import { formatToolErrorResponse, toToolError } from "../utils/tool-error.js";

/**
 * Register file download tool
 */
export function registerDownloadTool(server: McpServer): void {
  const sshManager = SSHConnectionManager.getInstance();

  server.tool(
    "download",
    "Download a file from the remote server to the MCP host over SFTP. Use this when you need to inspect or save a remote file locally. By default any absolute remote path is allowed; if the server configures allowedRemoteDirectories, the source must live inside one of those entries — call show-whitelist to check.",
    {
      remotePath: z.string().describe("Path to the file on the remote server. Must be an absolute POSIX path (e.g. /var/log/app.log); restricted to allowedRemoteDirectories only if the server configures that list."),
      localPath: z.string().describe("Destination path on the MCP host. Must be inside the MCP working directory or one of the server's allowedLocalDirectories."),
      connectionName: z.string().optional().describe("Target server name from list-servers. Required when multiple servers are enabled; optional when only one server is enabled."),
      reuseConnection: z.boolean().optional().describe("Default true. Reuse the cached SSH connection for SFTP. Set false after a timeout or suspected stale cached SSH connection to force a fresh TCP/SSH connection for this transfer; the fresh connection closes afterwards."),
      timeout: z.number().positive().optional().describe("Timeout in ms for SSH setup and SFTP channel opening. Transfer stream duration itself is not forcibly interrupted by this option."),
      vvv: z.boolean().optional().describe("Default false. Append bounded SSH/SFTP debug output. For fresh ssh2 handshake logs, also set reuseConnection=false."),
      fast: z.boolean().optional().describe("Default false. When true, use ssh2 fastGet for a single-file download, which performs parallel SFTP reads for better throughput."),
      sftpConcurrency: z.number().int().positive().optional().describe("Only used when fast=true. Number of concurrent SFTP chunks for ssh2 fastGet; omitted uses ssh2's default."),
      chunkSize: z.number().int().positive().optional().describe("Only used when fast=true. Chunk size in bytes for ssh2 fastGet; omitted uses ssh2's default."),
    },
    async ({ remotePath, localPath, connectionName, reuseConnection, timeout, vvv, fast, sftpConcurrency, chunkSize }) => {
      try {
        const resolvedName = sshManager.resolveServer(connectionName);
        const result = await sshManager.download(remotePath, localPath, resolvedName, {
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
        Logger.handleError(toolError, "Failed to download file");
        return {
          content: [{ type: "text", text: formatToolErrorResponse(toolError) }],
          isError: true,
        };
      }
    }
  );
}
