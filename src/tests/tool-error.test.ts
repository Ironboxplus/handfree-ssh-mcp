import { describe, it } from "node:test";
import assert from "node:assert";
import { ToolError, formatToolErrorResponse, toToolError } from "../utils/tool-error.js";

describe("ToolError helpers", () => {
  it("should preserve ToolError instances and codes", () => {
    const original = new ToolError("COMMAND_TIMEOUT", "timed out", false);
    const converted = toToolError(original, "UNKNOWN_ERROR");

    assert.strictEqual(converted, original);
    assert.strictEqual(converted.code, "COMMAND_TIMEOUT");
  });

  it("should format structured tool errors as JSON", () => {
    const formatted = formatToolErrorResponse(
      new ToolError("LOCAL_PATH_NOT_ALLOWED", "blocked path", false),
    );

    const parsed = JSON.parse(formatted);
    assert.deepStrictEqual(parsed, {
      code: "LOCAL_PATH_NOT_ALLOWED",
      message: "blocked path",
      retriable: false,
    });
  });

  it("should use the provided fallback code for generic errors", () => {
    const converted = toToolError(new Error("socket broke"), "SSH_CONNECTION_FAILED");

    assert.strictEqual(converted.code, "SSH_CONNECTION_FAILED");
    assert.strictEqual(converted.message, "socket broke");
    assert.strictEqual(converted.retriable, false);
  });
});
