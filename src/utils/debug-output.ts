/**
 * PLAN.MD P0-04: shared, stateless SSH/SFTP debug-output helpers.
 *
 * These four functions were originally private SSHConnectionManager methods.
 * They never touched instance state -- only their parameters and one
 * constant -- so they are shared, unchanged, as plain functions between
 * SSHConnectionManager (command execution: executeCommand and friends) and
 * TransferService (upload/download/transfer). This is a pure mechanical
 * de-classing, not a behavior change.
 */
import { OutputCollector } from "./output-collector.js";
import { ToolError } from "./tool-error.js";
import type { SshDebugSink } from "../connection/ssh-connection-pool.js";

const DEFAULT_DEBUG_BYTES = 64 * 1024;

export function createDebugCollector(enabled: boolean): {
  collector: OutputCollector | null;
  debug?: SshDebugSink;
} {
  if (!enabled) {
    return { collector: null };
  }

  const collector = new OutputCollector(DEFAULT_DEBUG_BYTES);
  return {
    collector,
    debug: (line: string) => {
      collector.push(`${line}\n`);
    },
  };
}

export function appendDebugOutput(result: string, collector: OutputCollector | null): string {
  const debugBlock = formatDebugBlock(collector);
  if (!debugBlock) {
    return result;
  }

  return `${result}\n\n${debugBlock}`;
}

export function appendDebugToError(error: Error, collector: OutputCollector | null): Error {
  const debugBlock = formatDebugBlock(collector);
  if (!debugBlock) {
    return error;
  }

  const message = `${error.message}\n\n${debugBlock}`;

  if (error instanceof ToolError) {
    return new ToolError(error.code, message, error.retriable);
  }

  const wrapped = new Error(message);
  wrapped.name = error.name;
  return wrapped;
}

export function formatDebugBlock(collector: OutputCollector | null): string | null {
  if (!collector || collector.getTotalBytes() === 0) {
    return null;
  }

  const snapshot = collector.getSnapshot();
  const header = snapshot.truncated
    ? `[SSH DEBUG TRUNCATED: dropped ${snapshot.droppedBytes} bytes]\n`
    : "[SSH DEBUG]\n";
  return `${header}${snapshot.tail.toString("utf8").trimEnd()}`;
}

