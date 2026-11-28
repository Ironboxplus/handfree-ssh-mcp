import { z } from "zod";
import { ToolError } from "../utils/tool-error.js";

/**
 * Parameters push and pull share, with one wording each. The shape checks
 * that depend on what the path turned out to be (array, directory, file) are
 * below, so both tools reject the same combinations with the same message.
 */
export const sftpTuningSchema = {
  connectionName: z.string().optional().describe("Server name from list-servers. Required with multiple enabled servers; optional with one."),
  reuseConnection: z.boolean().optional().describe("Default true. Set false to use a fresh SSH connection after a suspected stale connection."),
  timeout: z.number().positive().optional().describe("Milliseconds for SSH setup and SFTP channel opening; does not cap transfer duration."),
  vvv: z.boolean().optional().describe("Default false. Include bounded SSH debug output; fresh handshake logs also require reuseConnection=false."),
  fast: z.boolean().optional().describe("Default true: pipelined SFTP chunks. False is a serial compatibility mode and is much slower."),
  sftpConcurrency: z.number().int().positive().optional().describe("Concurrent SFTP chunks per file when fast=true; default ssh2 setting."),
  chunkSize: z.number().int().positive().optional().describe("Bytes per SFTP chunk when fast=true; default ssh2 setting."),
  fileConcurrency: z.number().int().positive().optional().describe(
    "Directory or array only: files in flight at once, default 32, maximum 64. They share at most 4 SFTP channels on one SSH connection.",
  ),
  connections: z.number().int().positive().optional().describe(
    "Single file only: 1-8 independent SSH/TCP connections, default 1. Splits byte ranges; above 1 ignores fast/sftpConcurrency/chunkSize. Helps high-latency links; see help for limits.",
  ),
  archive: z.boolean().optional().describe(
    "Default false. Pack into a temporary tar, transfer one file, extract into the destination directory and remove the temporary archives. Suits many small files.",
  ),
  archiveCompression: z.enum(["none", "gzip", "bzip2", "xz", "zstd"]).optional().describe(
    "With archive=true: none (default), gzip, bzip2, xz or zstd. Both ends need a compatible tar/compressor.",
  ),
  onError: z.enum(["abort", "continue"]).optional().describe(
    "Array only: abort (default) stops scheduling after a failure; continue attempts every file. In-flight files finish and every outcome is reported.",
  ),
};

export type TransferShape = "array" | "archive" | "directory" | "file";

function invalid(message: string): ToolError {
  return new ToolError("INVALID_CONFIGURATION", message, false);
}

/** Checks that need only the arguments, run before any connection opens. */
export function checkTransferArgs(args: {
  archive?: boolean;
  archiveCompression?: string;
  isArray: boolean;
  connections?: number;
}): void {
  if (!args.archive && args.archiveCompression !== undefined) {
    throw invalid("archiveCompression requires archive=true");
  }
  if (args.isArray && args.archive) {
    throw invalid("archive=true takes one path, not an array");
  }
  if (args.isArray && args.connections !== undefined) {
    throw invalid("connections applies to a single file, not an array");
  }
  if (args.archive && args.connections !== undefined) {
    throw invalid("connections is not supported with archive=true");
  }
}

/**
 * Checks that depend on what the path is; run once the shape is known.
 * fileConcurrency is not checked: pull learns that a path is a directory only
 * from the download itself, so for a single file it is simply unused.
 */
export function checkShapeArgs(shape: TransferShape, args: {
  connections?: number;
  onError?: string;
}): void {
  if (shape === "directory" && args.connections !== undefined) {
    throw invalid("connections applies to a single file; this path is a directory (use fileConcurrency)");
  }
  if (shape !== "array" && args.onError !== undefined) {
    throw invalid("onError applies to an array of paths only");
  }
}
