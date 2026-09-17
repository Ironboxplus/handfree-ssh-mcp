import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { RunService, DEFAULT_LOG_MAX_BYTES } from "../run/run-service.js";
import { runErrorEnvelope, toToolResult } from "./run-envelope.js";

export function registerRunLogsTool(server: McpServer): void {
  const runService = RunService.getInstance();

  server.tool(
    "run-logs",
    "Read a byte-offset window of a workspace-run's stdout or stderr log, fetched over SFTP directly from the remote file. Correctly handles a multi-byte UTF-8 character split across the window boundary (never duplicates or drops bytes across sequential calls at the returned nextOffset). Pass the previous response's nextOffset as the next call's offset to page through new output; hasMore indicates more bytes are already available beyond nextOffset.",
    {
      runId: z.string().min(1).describe("runId returned by workspace-run."),
      connectionName: z.string().optional().describe("Target server name from list-servers (the server the run was launched on). Required when multiple servers are enabled; optional when only one server is enabled."),
      stream: z.enum(["stdout", "stderr"]).optional().describe("Default stdout."),
      offset: z.number().int().nonnegative().optional().describe("Byte offset to start reading from. Default 0 (from the start of the file). Use the previous response's nextOffset to continue."),
      maxOutputBytes: z.number().int().positive().optional().describe(`Maximum bytes to return in this call. Default ${DEFAULT_LOG_MAX_BYTES}.`),
      reuseConnection: z.boolean().optional().describe("Whether to reuse the cached SSH connection for this server. Default true. Set false after a timeout or suspected stale/bad cached connection to force a fresh one for this call."),
    },
    async ({ runId, connectionName, stream, offset, maxOutputBytes, reuseConnection }) => {
      try {
        const [chunk, status] = await Promise.all([
          runService.getLogs(connectionName, runId, stream, offset, maxOutputBytes, reuseConnection),
          runService.getStatus(connectionName, runId, reuseConnection),
        ]);
        return toToolResult({
          ok: true,
          jobId: runId,
          state: status.state,
          message: `read ${chunk.text.length > 0 ? "some" : "no new"} ${stream ?? "stdout"} output for run '${runId}'.`,
          details: { runId, stream: stream ?? "stdout", ...chunk },
        });
      } catch (error) {
        return toToolResult(runErrorEnvelope(error), true);
      }
    },
  );
}
