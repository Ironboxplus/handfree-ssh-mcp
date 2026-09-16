import { makeErrorObject } from "../contracts/error.js";
import { RunServiceError } from "../run/run-errors.js";

/**
 * PLAN.MD §5.2: the unified response envelope, shared by workspace-run,
 * run-status, run-logs, run-list, and run-cancel -- these are all NEW tools,
 * so (unlike upload/download/execute-command/etc.) they use this envelope
 * from day one rather than the legacy plain-text/legacy-error shape.
 */
export function runErrorEnvelope(error: unknown): { ok: false; error: ReturnType<typeof makeErrorObject> } {
  if (error instanceof RunServiceError) {
    return { ok: false, error: makeErrorObject(error.code, error.message, { retryable: error.retryable }) };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { ok: false, error: makeErrorObject("UNKNOWN_ERROR", message) };
}

export function toToolResult(envelope: unknown, isError = false): { content: Array<{ type: "text"; text: string }>; isError?: true } {
  const result: { content: Array<{ type: "text"; text: string }>; isError?: true } = {
    content: [{ type: "text", text: JSON.stringify(envelope) }],
  };
  if (isError) result.isError = true;
  return result;
}
