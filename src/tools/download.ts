import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SSHConnectionManager } from "../services/ssh-connection-manager.js";
import { Logger } from "../utils/logger.js";
import { formatToolErrorResponse, toToolError } from "../utils/tool-error.js";
import { rejectUnknownArguments } from "./strict-arguments.js";

/**
 * Register file download tool
 */
export function registerDownloadTool(server: McpServer): void {
  const sshManager = SSHConnectionManager.getInstance();
  const transferService = sshManager.getTransferService();

  rejectUnknownArguments(server.tool(
    "download",
    "Download one remote file to the MCP host over SFTP. Use transfer with recursive=true for directories. Path policy is available through show-whitelist.",
    {
      remotePath: z.string().describe("Absolute remote POSIX file path, subject to SFTP path policy."),
      localPath: z.string().describe("Local destination within the MCP working directory/allowedLocalDirectories unless path policy is disabled."),
      connectionName: z.string().optional().describe("Server name from list-servers. Required with multiple enabled servers; optional with one."),
      reuseConnection: z.boolean().optional().describe("Default true. Set false to use a fresh SSH connection after a suspected stale connection."),
      timeout: z.number().positive().optional().describe("Timeout in ms for SSH setup and SFTP channel opening. Transfer stream duration itself is not forcibly interrupted by this option."),
      vvv: z.boolean().optional().describe("Default false. Include bounded SSH debug output; fresh handshake logs also require reuseConnection=false."),
      fast: z.boolean().optional().describe("Default true: parallel SFTP chunks via fastGet. False uses buffered download."),
      sftpConcurrency: z.number().int().positive().optional().describe("Concurrent SFTP chunks when fast=true; default ssh2 setting."),
      chunkSize: z.number().int().positive().optional().describe("Bytes per SFTP chunk when fast=true; default mode setting."),
      connections: z.number().int().positive().optional().describe(
        "Independent SSH/TCP connections for one file: default 1, maximum 8. Above 1 splits byte ranges and ignores fast/sftpConcurrency/chunkSize. Helps high-latency links; see help for limits.",
      ),
    },
    async ({ remotePath, localPath, connectionName, reuseConnection, timeout, vvv, fast, sftpConcurrency, chunkSize, connections }) => {
      try {
        const resolvedName = sshManager.resolveServer(connectionName);
        const result = await transferService.download(remotePath, localPath, resolvedName, {
          reuseConnection,
          timeout,
          vvv,
          fast: fast !== false,
          sftpConcurrency,
          chunkSize,
          connections,
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
  ));
}
