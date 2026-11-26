import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SSHConnectionManager } from "../services/ssh-connection-manager.js";
import { Logger } from "../utils/logger.js";
import { formatToolErrorResponse, toToolError, ToolError } from "../utils/tool-error.js";
import { rejectUnknownArguments } from "./strict-arguments.js";

/**
 * Register file download tool
 */
export function registerDownloadTool(server: McpServer): void {
  const sshManager = SSHConnectionManager.getInstance();
  const transferService = sshManager.getTransferService();

  rejectUnknownArguments(server.tool(
    "download",
    "Download a remote file, or an array of remote files, to the MCP host over SFTP. Use transfer with recursive=true for directories. Path policy is available through show-whitelist.",
    {
      remotePath: z.union([z.string(), z.array(z.string())]).describe(
        "Absolute remote file path: /home/me/file on Linux/macOS, C:\\Users\\me\\file or C:/Users/me/file on Windows. An array (up to 1000) downloads each file into the localPath directory as <basename>; duplicate basenames are rejected.",
      ),
      localPath: z.string().describe(
        "Local file path, or a directory (an existing one, or a path ending with / or \\) that receives the file under its remote name. Missing parent directories are created. Any local path is allowed unless allowedLocalDirectories is configured.",
      ),
      connectionName: z.string().optional().describe("Server name from list-servers. Required with multiple enabled servers; optional with one."),
      reuseConnection: z.boolean().optional().describe("Default true. Set false to use a fresh SSH connection after a suspected stale connection."),
      timeout: z.number().positive().optional().describe("Timeout in ms for SSH setup and SFTP channel opening. Transfer stream duration itself is not forcibly interrupted by this option."),
      vvv: z.boolean().optional().describe("Default false. Include bounded SSH debug output; fresh handshake logs also require reuseConnection=false."),
      fast: z.boolean().optional().describe("Default true: parallel SFTP chunks via fastGet. False uses buffered download."),
      sftpConcurrency: z.number().int().positive().optional().describe("Concurrent SFTP chunks when fast=true; default ssh2 setting."),
      chunkSize: z.number().int().positive().optional().describe("Bytes per SFTP chunk when fast=true; default mode setting."),
      connections: z.number().int().positive().optional().describe(
        "Independent SSH/TCP connections for one file: default 1, maximum 8. Above 1 splits byte ranges and ignores fast/sftpConcurrency/chunkSize. Not with a remotePath array. Helps high-latency links; see help for limits.",
      ),
      fileConcurrency: z.number().int().positive().optional().describe(
        "remotePath array only: files in flight at once, default 32, maximum 64.",
      ),
      onError: z.enum(["abort", "continue"]).optional().describe(
        "remotePath array only: abort (default) stops scheduling after a failure; continue attempts every file. Every file's outcome is reported.",
      ),
    },
    async ({ remotePath, localPath, connectionName, reuseConnection, timeout, vvv, fast, sftpConcurrency, chunkSize, connections, fileConcurrency, onError }) => {
      try {
        const resolvedName = sshManager.resolveServer(connectionName);
        const sftpOptions = { reuseConnection, timeout, vvv, fast: fast !== false, sftpConcurrency, chunkSize };
        if (Array.isArray(remotePath)) {
          if (connections !== undefined) {
            throw new ToolError("INVALID_CONFIGURATION", "connections is not supported with a remotePath array", false);
          }
          const batch = await transferService.downloadBatch(remotePath, localPath, resolvedName, {
            ...sftpOptions,
            ...(fileConcurrency === undefined ? {} : { fileConcurrency }),
            onError,
          });
          return { content: [{ type: "text", text: JSON.stringify(batch) }] };
        }
        if (fileConcurrency !== undefined || onError !== undefined) {
          throw new ToolError("INVALID_CONFIGURATION", "fileConcurrency and onError apply only to a remotePath array", false);
        }
        const result = await transferService.download(remotePath, localPath, resolvedName, { ...sftpOptions, connections });
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
  ));
}
