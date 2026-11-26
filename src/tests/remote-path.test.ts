import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { isWindowsRemotePath, normalizeRemotePath, remotePathWithin } from "../utils/remote-path.js";

// Pure rules of src/utils/remote-path.ts. The accepted Windows forms are the
// ones OpenSSH_for_Windows_9.5 resolves to one file (measured 2026-11-26).
describe("normalizeRemotePath", () => {
  const ok = (raw: string) => {
    const result = normalizeRemotePath(raw);
    assert.ok(result.ok, `${raw}: ${result.ok ? "" : result.reason}`);
    return result.path;
  };
  const reason = (raw: string) => {
    const result = normalizeRemotePath(raw);
    assert.ok(!result.ok, `${raw} should be rejected`);
    return result.reason;
  };

  test("POSIX absolute paths are normalized as before", () => {
    assert.equal(ok("/home/u/file"), "/home/u/file");
    assert.equal(ok("/home//u/./file"), "/home/u/file");
    assert.equal(ok("/"), "/");
    assert.equal(ok("/a\\b"), "/a\\b");
    assert.equal(ok("/tmp/dir/"), "/tmp/dir/");
  });

  test("Windows drive paths in every accepted spelling become /X:/...", () => {
    for (const raw of ["C:\\Users\\Arc\\f", "C:/Users/Arc/f", "/C:\\Users\\Arc\\f", "/C:/Users/Arc/f", "c:/Users/Arc/f"]) {
      assert.equal(ok(raw), "/C:/Users/Arc/f", raw);
    }
    assert.equal(ok("D:"), "/D:/");
    assert.equal(ok("/d:"), "/D:/");
    assert.equal(ok("C:\\"), "/C:/");
    assert.equal(ok("C:\\a\\\\b"), "/C:/a/b");
  });

  test("relative paths and ~ are rejected with the absolute forms spelled out", () => {
    for (const raw of ["~", "~/x", "data/x", "C:relative", "Desktop"]) {
      const message = reason(raw);
      assert.match(message, /\/home\/me\/file/);
      assert.match(message, /C:\\Users\\me\\file/);
    }
  });

  test("'..' is rejected after backslash conversion, null bytes and empty input always", () => {
    assert.match(reason("/a/../b"), /'\.\.'/);
    assert.match(reason("C:\\a\\..\\b"), /'\.\.'/);
    assert.match(reason("/a\0b"), /null/);
    assert.match(reason(""), /non-empty/);
  });
});

describe("remotePathWithin / isWindowsRemotePath", () => {
  test("POSIX containment is case-sensitive and segment-aligned", () => {
    assert.ok(remotePathWithin("/data/x", "/data"));
    assert.ok(remotePathWithin("/data", "/data"));
    assert.ok(remotePathWithin("/anything", "/"));
    assert.ok(!remotePathWithin("/database/x", "/data"));
    assert.ok(!remotePathWithin("/Data/x", "/data"));
  });

  test("Windows containment is case-insensitive and segment-aligned", () => {
    assert.ok(remotePathWithin("/C:/data/x", "/C:/Data"));
    assert.ok(remotePathWithin("/C:/x", "/C:/"));
    assert.ok(!remotePathWithin("/C:/Database/x", "/C:/Data"));
    assert.ok(!remotePathWithin("/D:/Data/x", "/C:/Data"));
  });

  test("isWindowsRemotePath recognizes only the normalized drive form", () => {
    assert.ok(isWindowsRemotePath("/C:/x"));
    assert.ok(!isWindowsRemotePath("C:/x"));
    assert.ok(!isWindowsRemotePath("/home/C:/x"));
  });
});
