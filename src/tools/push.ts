import * as fs from "node:fs";
import * as path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SSHConnectionManager } from "../services/ssh-connection-manager.js";
import { Logger } from "../utils/logger.js";
import { formatToolErrorResponse, toToolError } from "../utils/tool-error.js";
import { rejectUnknownArguments } from "./strict-arguments.js";
import { checkShapeArgs, checkTransferArgs, sftpTuningSchema, type TransferShape } from "./transfer-args.js";

/**
 * Register push: MCP host to remote, like adb push. A local directory is
 * detected and copied with its whole tree; there is no recursive flag.
 */
export function registerPushTool(server: McpServer): void {
  const sshManager = SSHConnectionManager.getInstance();
  const transferService = sshManager.getTransferService();

  rejectUnknownArguments(server.tool(
    "push",
    "Copy a local file, directory or file array from the MCP host to a remote server over SFTP (like adb push). A directory is detected and its whole tree lands in remotePath. A file pushed to an existing remote directory or a path ending with / keeps its name. Matching remote files are skipped by MD5. Shell scripts with CRLF are converted to LF. Path policy is available through show-whitelist.",
    {
      localPath: z.union([z.string(), z.array(z.string())]).describe(
        "Local file, directory, or file array (1-1000; each lands at remotePath/<basename>, duplicate targets are rejected). Any local path is allowed unless allowedLocalDirectories is configured.",
      ),
      remotePath: z.string().describe(
        "Absolute remote destination: /home/me/x on Linux/macOS, C:\\Users\\me\\x or C:/Users/me/x on Windows; subject to path policy. For a directory or an array this is the destination directory.",
      ),
      skipIfIdentical: z.boolean().optional().describe(
        "Default true. Skip a file when the remote file has the same size and MD5 (computed on the server with md5sum, md5 -r or rclone md5sum) as the bytes that would be written, after the shell-script CRLF to LF fix. No remote hash command means upload. False forces upload.",
      ),
      ...sftpTuningSchema,
    },
    async (params) => {
      try {
        const { localPath, remotePath, connectionName, skipIfIdentical, reuseConnection, timeout, vvv, fast, sftpConcurrency, chunkSize, fileConcurrency, connections, archive, archiveCompression, onError } = params;
        checkTransferArgs({ archive, archiveCompression, isArray: Array.isArray(localPath), connections });
        const resolvedName = sshManager.resolveServer(connectionName);
        const shape: TransferShape = Array.isArray(localPath)
          ? "array"
          : archive
            ? "archive"
            : fs.statSync(path.resolve(localPath), { throwIfNoEntry: false })?.isDirectory() ? "directory" : "file";
        checkShapeArgs(shape, { connections, fileConcurrency, onError });

        const sftpOptions = {
          reuseConnection, timeout, vvv, fast: fast !== false, sftpConcurrency, chunkSize,
          ...(fileConcurrency === undefined ? {} : { fileConcurrency }),
        };
        const uploadOptions = { skipIfIdentical: skipIfIdentical !== false, ...sftpOptions };

        let text: string;
        if (Array.isArray(localPath)) {
          text = JSON.stringify(await transferService.uploadBatch(localPath, remotePath, resolvedName, { ...uploadOptions, onError }));
        } else if (shape === "archive") {
          text = await transferService.uploadArchive(localPath, remotePath, resolvedName, archiveCompression ?? "none", sftpOptions);
        } else if (shape === "directory") {
          const files = await transferService.uploadDirectory(localPath, remotePath, resolvedName, uploadOptions);
          text = JSON.stringify({ summary: `Directory push complete. ${files.length} file(s) transferred.`, files });
        } else {
          text = await transferService.upload(localPath, remotePath, resolvedName, {
            ...uploadOptions,
            ...(connections === undefined ? {} : { connections }),
          });
        }
        return { content: [{ type: "text", text }] };
      } catch (error: unknown) {
        const toolError = toToolError(error, "SFTP_ERROR");
        Logger.handleError(toolError, "push failed");
        return { content: [{ type: "text", text: formatToolErrorResponse(toolError) }], isError: true };
      }
    },
  ));
}
