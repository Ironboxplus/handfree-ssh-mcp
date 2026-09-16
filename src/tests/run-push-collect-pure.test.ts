import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { computePushedFilesDigest } from "../run/push-revision.js";
import {
  isCollectCandidateSafe,
  matchesCollectGlob,
  selectWithinCollectCaps,
  type CollectMatch,
} from "../run/collect-glob.js";

// PLAN.MD §7.2.1 white-box: exhaustive value tests over the pure functions
// P2-02 (push revision digest) and P2-06 (collect glob safety + cap
// selection) are built from. No SSH, no filesystem -- plain function calls
// in, plain values out. Real-I/O coverage (the SFTP walk itself, real
// symlinks, real downloads) lives in run-push-collect-real.test.ts.

describe("P2-02 white-box: computePushedFilesDigest", () => {
  test("order-independent: same set, different order -> same digest", () => {
    const a = computePushedFilesDigest(["/r/b.py", "/r/a.py", "/r/c.py"]);
    const b = computePushedFilesDigest(["/r/c.py", "/r/a.py", "/r/b.py"]);
    assert.equal(a, b);
  });

  test("different file sets -> different digests", () => {
    const a = computePushedFilesDigest(["/r/a.py"]);
    const b = computePushedFilesDigest(["/r/a.py", "/r/b.py"]);
    assert.notEqual(a, b);
  });

  test("empty list is deterministic and distinct from a single-file list", () => {
    const empty1 = computePushedFilesDigest([]);
    const empty2 = computePushedFilesDigest([]);
    assert.equal(empty1, empty2);
    assert.notEqual(empty1, computePushedFilesDigest(["/r/a.py"]));
  });

  test("is a 64-char lowercase hex sha256 digest", () => {
    const digest = computePushedFilesDigest(["/r/a.py"]);
    assert.match(digest, /^[0-9a-f]{64}$/);
  });

  test("does not mutate the input array", () => {
    const input = ["/r/z.py", "/r/a.py"];
    const copy = [...input];
    computePushedFilesDigest(input);
    assert.deepEqual(input, copy);
  });
});

describe("P2-06 white-box: isCollectCandidateSafe", () => {
  const cases: Array<[string, { relativePath: string; isSymlink: boolean }, boolean]> = [
    ["plain relative file", { relativePath: "outputs/result.json", isSymlink: false }, true],
    ["plain top-level file", { relativePath: "result.json", isSymlink: false }, true],
    ["symlink, otherwise-safe path -> rejected", { relativePath: "outputs/result.json", isSymlink: true }, false],
    ["symlink pointing outside root (still just a relative path here) -> rejected because it is a symlink", { relativePath: "link-to-outside", isSymlink: true }, false],
    ["'..' segment -> rejected", { relativePath: "../outside.txt", isSymlink: false }, false],
    ["'..' segment deep in the path -> rejected", { relativePath: "outputs/../../etc/passwd", isSymlink: false }, false],
    ["absolute path -> rejected", { relativePath: "/etc/passwd", isSymlink: false }, false],
    ["leading '~' -> rejected", { relativePath: "~/secrets", isSymlink: false }, false],
    ["Windows drive-letter absolute -> rejected", { relativePath: "C:\\secrets.txt", isSymlink: false }, false],
    ["empty path -> rejected", { relativePath: "", isSymlink: false }, false],
  ];
  for (const [label, candidate, expected] of cases) {
    test(label, () => {
      assert.equal(isCollectCandidateSafe(candidate), expected);
    });
  }
});

describe("P2-06 white-box: matchesCollectGlob (thin reuse of entrypoint-glob)", () => {
  test("exact literal match", () => {
    assert.equal(matchesCollectGlob("out.json", ["out.json"]), true);
  });
  test("single-segment '*' does not cross a '/'", () => {
    assert.equal(matchesCollectGlob("logs/run.log", ["*.log"]), false);
    assert.equal(matchesCollectGlob("run.log", ["*.log"]), true);
  });
  test("'**' crosses directories", () => {
    assert.equal(matchesCollectGlob("a/b/c/out.json", ["**/out.json"]), true);
  });
  test("no pattern matches -> false", () => {
    assert.equal(matchesCollectGlob("out.txt", ["*.json", "*.log"]), false);
  });
});

describe("P2-06 white-box: selectWithinCollectCaps (no silent truncation)", () => {
  const m = (relativePath: string, bytes: number): CollectMatch => ({ relativePath, absolutePath: `/root/${relativePath}`, bytes });

  test("all files fit under both caps -> everything accepted, exceeded is null", () => {
    const matches = [m("a", 10), m("b", 20), m("c", 30)];
    const result = selectWithinCollectCaps(matches, 1000, 10);
    assert.deepEqual(result.accepted, matches);
    assert.equal(result.totalBytes, 60);
    assert.equal(result.exceeded, null);
  });

  test("empty match list -> nothing accepted, not an error", () => {
    const result = selectWithinCollectCaps([], 1000, 10);
    assert.deepEqual(result.accepted, []);
    assert.equal(result.totalBytes, 0);
    assert.equal(result.exceeded, null);
  });

  test("exactly at maxFiles -> all accepted (boundary is inclusive)", () => {
    const matches = [m("a", 1), m("b", 1), m("c", 1)];
    const result = selectWithinCollectCaps(matches, 1000, 3);
    assert.equal(result.accepted.length, 3);
    assert.equal(result.exceeded, null);
  });

  test("one file over maxFiles -> stops exactly there, reports what was already accepted", () => {
    const matches = [m("a", 1), m("b", 1), m("c", 1)];
    const result = selectWithinCollectCaps(matches, 1000, 2);
    assert.deepEqual(result.accepted, [matches[0], matches[1]]);
    assert.equal(result.exceeded?.atRelativePath, "c");
    assert.match(result.exceeded!.reason, /maxFiles/);
  });

  test("exactly at maxBytes -> accepted (boundary is inclusive)", () => {
    const matches = [m("a", 50), m("b", 50)];
    const result = selectWithinCollectCaps(matches, 100, 10);
    assert.equal(result.accepted.length, 2);
    assert.equal(result.totalBytes, 100);
    assert.equal(result.exceeded, null);
  });

  test("one byte over maxBytes -> stops before that file, reports accurate partial total", () => {
    const matches = [m("a", 50), m("b", 51)];
    const result = selectWithinCollectCaps(matches, 100, 10);
    assert.deepEqual(result.accepted, [matches[0]]);
    assert.equal(result.totalBytes, 50);
    assert.equal(result.exceeded?.atRelativePath, "b");
    assert.match(result.exceeded!.reason, /maxBytes/);
  });

  test("byte cap trips before file-count cap when both would trip on the same file", () => {
    // maxFiles is large enough that only the byte cap can be the cause here.
    const matches = [m("a", 100)];
    const result = selectWithinCollectCaps(matches, 50, 100);
    assert.equal(result.accepted.length, 0);
    assert.match(result.exceeded!.reason, /maxBytes/);
  });
});
