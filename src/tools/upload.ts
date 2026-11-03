import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SSHConnectionManager } from "../services/ssh-connection-manager.js";
import { Logger } from "../utils/logger.js";
import { formatToolErrorResponse, ToolError, toToolError } from "../utils/tool-error.js";
import { rejectUnknownArguments } from "./strict-arguments.js";

/**
 * Register file upload tool
 */
export function registerUploadTool(server: McpServer): void {
  const sshManager = SSHConnectionManager.getInstance();
  const transferService = sshManager.getTransferService();

  rejectUnknownArguments(server.tool(
    "upload",
    "Upload a file or batch of files from the MCP host over SFTP. Batch localPath requires a destination directory and returns per-file results. Shell scripts with CRLF are converted to LF. A file is skipped only when the remote file already has the MD5 of the bytes that would be written (computed on the server); with no remote md5sum it is uploaded. Path policy is available through show-whitelist.",
    {
      localPath: z.union([
        z.string(),
        z.array(z.string()),
      ]).describe("Local file or file array, within the MCP working directory/allowedLocalDirectories unless path policy is disabled. Batch: 1-1000 files; duplicate targets are rejected."),
      remotePath: z.string().describe("Absolute remote POSIX destination, subject to path policy. Batch requires a directory; files land at <basename>."),
      connectionName: z.string().optional().describe("Server name from list-servers. Required with multiple enabled servers; optional with one."),
      skipIfIdentical: z.boolean().optional().describe("Default true. Skip when the remote file has the same size and the same MD5 (computed on the server with md5sum, md5 -r or rclone md5sum) as the bytes that would be written, i.e. after the shell-script CRLF to LF fix. No remote hash command means upload. False forces upload."),
      reuseConnection: z.boolean().optional().describe("Default true. Set false to use a fresh SSH connection after a suspected stale connection."),
      timeout: z.number().positive().optional().describe("Timeout in ms for SSH setup and SFTP channel opening. Transfer stream duration itself is not forcibly interrupted by this option."),
      vvv: z.boolean().optional().describe("Default false. Include bounded SSH debug output; fresh handshake logs also require reuseConnection=false."),
      fast: z.boolean().optional().describe("Default true: pipelined SFTP chunks via fastPut. False is a serial compatibility mode and is much slower. CRLF conversion uses the buffered path."),
      sftpConcurrency: z.number().int().positive().optional().describe("Concurrent SFTP chunks when fast=true; default ssh2 setting."),
      chunkSize: z.number().int().positive().optional().describe("Bytes per SFTP chunk when fast=true; default ssh2 setting."),
      onError: z.enum(["abort", "continue"]).optional().describe("Batch only: abort (default) stops scheduling after failure; continue attempts all files. In-flight files finish; results report each outcome."),
      fileConcurrency: z.number().int().positive().optional().describe("Batch upload: files in flight at once, default 32, maximum 64. They share at most 4 SFTP channels on one SSH connection."),
      connections: z.number().int().positive().optional().describe("Single file only: 1-8 independent SSH/TCP connections, default 1. Splits byte ranges into a remote temp file before replacement. Above 1 ignores fast/sftpConcurrency/chunkSize. Helps high-latency links; see help for limits."),
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
  ));
}
