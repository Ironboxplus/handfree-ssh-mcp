import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SSHConnectionManager } from "../services/ssh-connection-manager.js";
import { Logger } from "../utils/logger.js";
import { formatToolErrorResponse, ToolError, toToolError } from "../utils/tool-error.js";
import { transferStrategySchema } from "../contracts/transfer-contract.js";
import { rejectUnknownArguments } from "./strict-arguments.js";

const endpointSchema = (role: string) => z.object({
  server: z.string().describe(`${role} server name from list-servers.`),
  path: z.string().describe(`Absolute ${role.toLowerCase()} path (POSIX or Windows drive path), subject to that server's path policy.`),
}).strict();

/**
 * Register copy: remote to remote. The bytes travel through this MCP host by
 * default (bounded parallel SFTP read-ahead); a same-server copy is done by
 * the server itself when its SFTP advertises copy-data.
 */
export function registerCopyTool(server: McpServer): void {
  const sshManager = SSHConnectionManager.getInstance();
  const transferService = sshManager.getTransferService();

  rejectUnknownArguments(server.tool(
    "copy",
    "Copy a file between two remote servers, or within one: from { server, path } to { server, path }. strategy selects relay (via this MCP host, default), direct (the source pushes with its own SSH trust) or auto. archive=true copies a directory as a temporary tar. See help for constraints.",
    {
      from: endpointSchema("Source"),
      to: endpointSchema("Destination"),
      strategy: transferStrategySchema.optional().describe(
        "relay (default) uses this MCP host via SFTP, except that a same-server copy is done by the server itself when its SFTP advertises copy-data (OpenSSH 9.0+; connections is then ignored); direct runs rsync or tar|ssh on the source; auto tries direct then falls back with a reason. Direct requires source-to-destination reachability and existing key/host-key trust; keys are never copied or auto-accepted.",
      ),
      archive: z.boolean().optional().describe(
        "Default false. Pack the source path into a temporary tar, relay it, extract into the destination directory and remove the temporary archives.",
      ),
      archiveCompression: z.enum(["none", "gzip", "bzip2", "xz", "zstd"]).optional().describe(
        "With archive=true: none (default), gzip, bzip2, xz or zstd. Both servers need a compatible tar/compressor.",
      ),
      skipIfIdentical: z.boolean().optional().describe("Default true: skip when the destination already has the same size and MD5 (when the servers can hash)."),
      connections: z.number().int().positive().optional().describe(
        "Single file with strategy=relay only: 1-8 independent SSH/TCP connections per server, default 1. Excludes archive and direct/auto. See help for limits.",
      ),
      sftpConcurrency: z.number().int().positive().optional().describe("Prefetched source chunks, default 64; total window at most 64 MiB."),
      chunkSize: z.number().int().positive().optional().describe("Bytes per relayed chunk, default 32768; total window at most 64 MiB."),
      reuseConnection: z.boolean().optional().describe("Default true. Set false to use fresh SSH connections after a suspected stale connection."),
      timeout: z.number().positive().optional().describe("Milliseconds for SSH setup and SFTP channel opening; does not cap transfer duration."),
      vvv: z.boolean().optional().describe("Default false. Include bounded SSH debug output; fresh handshake logs also require reuseConnection=false."),
    },
    async ({ from, to, strategy, archive, archiveCompression, skipIfIdentical, connections, sftpConcurrency, chunkSize, reuseConnection, timeout, vvv }) => {
      try {
        if (!archive && archiveCompression !== undefined) {
          throw new ToolError("INVALID_CONFIGURATION", "archiveCompression requires archive=true", false);
        }
        if (archive && connections !== undefined) {
          throw new ToolError("INVALID_CONFIGURATION", "connections is not supported with archive=true", false);
        }
        const options = {
          reuseConnection, timeout, vvv, sftpConcurrency, chunkSize,
          ...(strategy === undefined ? {} : { strategy }),
          ...(connections === undefined ? {} : { connections }),
        };
        const text = archive
          ? await transferService.transferArchiveBetweenServers(from.server, from.path, to.server, to.path, archiveCompression ?? "none", options)
          : await transferService.transferBetweenServers(from.server, from.path, to.server, to.path, { skipIfIdentical: skipIfIdentical !== false, ...options });
        return { content: [{ type: "text", text }] };
      } catch (error: unknown) {
        const toolError = toToolError(error, "SFTP_ERROR");
        Logger.handleError(toolError, "copy failed");
        return { content: [{ type: "text", text: formatToolErrorResponse(toolError) }], isError: true };
      }
    },
  ));
}
