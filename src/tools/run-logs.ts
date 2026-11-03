import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { RunService, DEFAULT_LOG_MAX_BYTES } from "../run/run-service.js";
import { runErrorEnvelope, toToolResult } from "./run-envelope.js";
import { rejectUnknownArguments } from "./strict-arguments.js";

export function registerRunLogsTool(server: McpServer): void {
  const runService = RunService.getInstance();

  rejectUnknownArguments(server.tool(
    "run-logs",
    "Read stdout or stderr of a workspace-run task from the remote file. Continue with offset=nextOffset; hasMore means additional bytes are already available.",
    {
      runId: z.string().min(1).describe("runId from workspace-run or run-retry."),
      connectionName: z.string().optional().describe("Server name from list-servers. Required with multiple enabled servers; optional with one."),
      stream: z.enum(["stdout", "stderr"]).optional().describe("Log to read: stdout (default) or stderr."),
      offset: z.number().int().nonnegative().optional().describe("Starting byte offset, default 0. Continue using the returned nextOffset."),
      maxOutputBytes: z.number().int().positive().optional().describe("Maximum bytes to read, default 65536."),
      reuseConnection: z.boolean().optional().describe("Default true. Set false to use a fresh SSH connection after a suspected stale connection."),
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
  ));
}
