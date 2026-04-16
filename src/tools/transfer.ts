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
        "(upload/download only) Path on the MCP host. Must be inside the working directory.",
      ),
      remotePath: z.string().optional().describe(
        "(upload/download only) Path on the remote server.",
      ),
      connectionName: z.string().optional().describe(
        "(upload/download only) Target server name from list-servers. Required when multiple servers are enabled.",
      ),
      sourceServer: z.string().optional().describe(
        "(relay only) Server name to download the file from.",
      ),
      sourceRemotePath: z.string().optional().describe(
        "(relay only) File path on the source server.",
      ),
      destServer: z.string().optional().describe(
        "(relay only) Server name to upload the file to.",
      ),
      destRemotePath: z.string().optional().describe(
        "(relay only) Destination file path on the target server.",
      ),
      recursive: z.boolean().optional().describe(
        "(upload/download only) When true, transfers an entire directory tree recursively. Default false.",
      ),
    },
    async (params) => {
      try {
        const { mode } = params;

        if (mode === "relay") {
          const { sourceServer, sourceRemotePath, destServer, destRemotePath } = params;
          if (!sourceServer || !sourceRemotePath || !destServer || !destRemotePath) {
            return {
              content: [{ type: "text", text: "relay mode requires: sourceServer, sourceRemotePath, destServer, destRemotePath" }],
              isError: true,
            };
          }
          const result = await sshManager.transferBetweenServers(
            sourceServer, sourceRemotePath, destServer, destRemotePath,
          );
          return { content: [{ type: "text", text: result }] };
        }

        // upload or download
        const { localPath, remotePath, connectionName, recursive } = params;
        if (!localPath || !remotePath) {
          return {
            content: [{ type: "text", text: `${mode} mode requires: localPath, remotePath` }],
            isError: true,
          };
        }

        const resolvedName = sshManager.resolveServer(connectionName);

        if (recursive) {
          let files: string[];
          if (mode === "upload") {
            files = await sshManager.uploadDirectory(localPath, remotePath, resolvedName);
          } else {
            files = await sshManager.downloadDirectory(remotePath, localPath, resolvedName);
          }
          const summary = `Recursive ${mode} complete. ${files.length} file(s) transferred.`;
          return {
            content: [{ type: "text", text: JSON.stringify({ summary, files }) }],
          };
        }

        // Single file
        if (mode === "upload") {
          const result = await sshManager.upload(localPath, remotePath, resolvedName);
          return { content: [{ type: "text", text: result }] };
        } else {
          const result = await sshManager.download(remotePath, localPath, resolvedName);
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
