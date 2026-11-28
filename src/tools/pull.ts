import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SSHConnectionManager } from "../services/ssh-connection-manager.js";
import { Logger } from "../utils/logger.js";
import { formatToolErrorResponse, toToolError } from "../utils/tool-error.js";
import { rejectUnknownArguments } from "./strict-arguments.js";
import { checkShapeArgs, checkTransferArgs, sftpTuningSchema, type TransferShape } from "./transfer-args.js";

/**
 * Register pull: remote to the MCP host, like adb pull. A remote directory is
 * detected by one STAT and copied with its whole tree; there is no recursive
 * flag.
 */
export function registerPullTool(server: McpServer): void {
  const sshManager = SSHConnectionManager.getInstance();
  const transferService = sshManager.getTransferService();

  rejectUnknownArguments(server.tool(
    "pull",
    "Copy a remote file, directory or file array from a remote server to the MCP host over SFTP (like adb pull). A directory is detected and its whole tree lands in localPath. A file pulled into a local directory keeps its remote name. Path policy is available through show-whitelist.",
    {
      remotePath: z.union([z.string(), z.array(z.string())]).describe(
        "Absolute remote file or directory: /home/me/x on Linux/macOS, C:\\Users\\me\\x or C:/Users/me/x on Windows. An array (up to 1000 files) lands in the localPath directory as <basename>; duplicate basenames are rejected.",
      ),
      localPath: z.string().describe(
        "Local destination. For a file: a file path, or a directory (an existing one, or a path ending with / or \\) that receives the file under its remote name. For a directory or an array: the destination directory. Missing parents are created. Any local path is allowed unless allowedLocalDirectories is configured.",
      ),
      ...sftpTuningSchema,
    },
    async (params) => {
      try {
        const { remotePath, localPath, connectionName, reuseConnection, timeout, vvv, fast, sftpConcurrency, chunkSize, fileConcurrency, connections, archive, archiveCompression, onError } = params;
        checkTransferArgs({ archive, archiveCompression, isArray: Array.isArray(remotePath), connections });
        const resolvedName = sshManager.resolveServer(connectionName);
        const sftpOptions = {
          reuseConnection, timeout, vvv, fast: fast !== false, sftpConcurrency, chunkSize,
          ...(fileConcurrency === undefined ? {} : { fileConcurrency }),
        };
        const shape: TransferShape = Array.isArray(remotePath)
          ? "array"
          : archive
            ? "archive"
            : await transferService.remoteIsDirectoryPath(remotePath, resolvedName, sftpOptions) ? "directory" : "file";
        checkShapeArgs(shape, { connections, fileConcurrency, onError });

        let text: string;
        if (Array.isArray(remotePath)) {
          text = JSON.stringify(await transferService.downloadBatch(remotePath, localPath, resolvedName, { ...sftpOptions, onError }));
        } else if (shape === "archive") {
          text = await transferService.downloadArchive(remotePath, localPath, resolvedName, archiveCompression ?? "none", sftpOptions);
        } else if (shape === "directory") {
          const files = await transferService.downloadDirectory(remotePath, localPath, resolvedName, sftpOptions);
          text = JSON.stringify({ summary: `Directory pull complete. ${files.length} file(s) transferred.`, files });
        } else {
          text = await transferService.download(remotePath, localPath, resolvedName, {
            ...sftpOptions,
            ...(connections === undefined ? {} : { connections }),
          });
        }
        return { content: [{ type: "text", text }] };
      } catch (error: unknown) {
        const toolError = toToolError(error, "SFTP_ERROR");
        Logger.handleError(toolError, "pull failed");
        return { content: [{ type: "text", text: formatToolErrorResponse(toolError) }], isError: true };
      }
    },
  ));
}
