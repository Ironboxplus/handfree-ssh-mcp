import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { posixShellQuote, posixShellQuoteAll } from "../run/posix-quote.js";
import { generateRunId, isValidRunId } from "../run/run-id.js";
import { computeRunPaths, computeStateRootPath, joinPosix, DEFAULT_STATE_ROOT_NAME } from "../run/remote-run-paths.js";
import { isSafeRelativeEntrypoint, compileEntrypointGlob, matchesAllowedEntrypoint } from "../run/entrypoint-glob.js";
import { applyEnvOverride } from "../run/env-allowlist.js";
import { decideCancelAction, type ProcessProbe } from "../run/identity.js";
import { sliceUtf8Window } from "../run/log-offset.js";
import { parseRunMeta, parseRunExit, parseOrphanedMarker, interpretWaitStatus } from "../run/meta.js";
import { parseProbeLine, parseCancelOutcome } from "../run/cancel-script.js";
import { findSentinelLine } from "../run/sentinel.js";

// PLAN.MD §7.2.1 white-box: exhaustive value tests over every pure/near-pure
// function in src/run/. No SSH, no mocks -- plain function calls in, plain
// values out.

describe("P2-03/04 white-box: posixShellQuote (real bash round-trip)", () => {
  test("wraps in single quotes, empty string -> ''", () => {
    assert.equal(posixShellQuote(""), "''");
    assert.equal(posixShellQuote("abc"), "'abc'");
  });

  test("embedded single quote is escaped via close-escape-reopen", () => {
    assert.equal(posixShellQuote("it's"), `'it'\\''s'`);
  });

  test("posixShellQuoteAll space-joins each quoted value", () => {
    assert.equal(posixShellQuoteAll(["a", "b c", ""]), `'a' 'b c' ''`);
  });

  test("real bash: quoting round-trips arbitrary strings byte-for-byte, including shell metacharacters", async () => {
    const { spawnSync } = await import("node:child_process");
    const probe = spawnSync("bash", ["--version"]);
    if (probe.error) {
      console.warn(`[skip] bash not available on PATH: ${probe.error.message}`);
      return;
    }
    const samples = [
      "",
      "plain",
      "with space",
      `it's a "test"`,
      "$(rm -rf /)",
      "`backtick`",
      "a\nb",
      "a\tb",
      "glob*[?]",
      "unicode 中文 emoji \u{1F600}",
      "\\backslash\\",
      "trailing-backslash\\",
      "; rm -rf ~ #",
      "&& echo pwned",
      "| cat /etc/passwd",
    ];
    const quotedArgs = samples.map(posixShellQuote).join(" ");
    const script = `printf '%s\\0' ${quotedArgs}`;
    const result = spawnSync("bash", ["-c", script], { encoding: "buffer" });
    assert.equal(result.status, 0, `bash exited ${result.status}: ${result.stderr?.toString()}`);
    const recovered = result.stdout.toString("utf8").split("\0").slice(0, -1);
    assert.deepEqual(recovered, samples);
  });
});

describe("P2-03 white-box: run-id", () => {
  test("generateRunId is deterministic given now/random", () => {
    const now = new Date("2026-09-15T12:34:56.789Z");
    const random = () => Buffer.from("deadbeef", "hex");
    assert.equal(generateRunId(now, random), "run_20260915T123456Z_deadbeef");
  });

  test("isValidRunId accepts exactly the generated shape", () => {
    assert.equal(isValidRunId(generateRunId(new Date(), () => Buffer.from([1, 2, 3, 4]))), true);
  });

  const invalid = ["", "run_bad", "../etc/passwd", "run_20260915T123456Z_deadbeef/../x", "run_20260915T123456Z_DEADBEEF", "run_20260915T123456Z_deadbee", "foo"];
  for (const candidate of invalid) {
    test(`isValidRunId rejects ${JSON.stringify(candidate)}`, () => {
      assert.equal(isValidRunId(candidate), false);
    });
  }
});

describe("P2-03 white-box: remote-run-paths", () => {
  const runId = "run_20260915T120000Z_ab12cd34";

  test("computeRunPaths derives every state file under the default root", () => {
    const paths = computeRunPaths(runId);
    assert.equal(paths.runDir, `${DEFAULT_STATE_ROOT_NAME}/${runId}`);
    assert.equal(paths.metaPath, `${paths.runDir}/meta.json`);
    assert.equal(paths.stdoutPath, `${paths.runDir}/stdout.log`);
    assert.equal(paths.stderrPath, `${paths.runDir}/stderr.log`);
    assert.equal(paths.pidPath, `${paths.runDir}/pid`);
    assert.equal(paths.heartbeatPath, `${paths.runDir}/heartbeat`);
    assert.equal(paths.exitPath, `${paths.runDir}/exit.json`);
    assert.equal(paths.orphanedPath, `${paths.runDir}/orphaned.json`);
  });

  test("computeRunPaths rejects an invalid runId", () => {
    assert.throws(() => computeRunPaths("../etc/passwd"), /invalid runId/);
  });

  test("custom stateRoot: '~/' prefix and trailing slash are normalized", () => {
    const paths = computeRunPaths(runId, "~/custom-root/");
    assert.equal(paths.runDir, `custom-root/${runId}`);
  });

  for (const bad of ["", "..", "a/../b", "./a", "a/./b"]) {
    test(`custom stateRoot rejects traversal/empty: ${JSON.stringify(bad)}`, () => {
      assert.throws(() => computeRunPaths(runId, bad));
    });
  }

  test("computeStateRootPath matches the root portion of computeRunPaths", () => {
    assert.equal(computeStateRootPath(), DEFAULT_STATE_ROOT_NAME);
    assert.equal(computeStateRootPath("~/custom/"), "custom");
  });

  test("joinPosix preserves an absolute base's leading slash", () => {
    assert.equal(joinPosix("/home/alice", "a", "b"), "/home/alice/a/b");
  });

  test("joinPosix preserves a relative base as relative", () => {
    assert.equal(joinPosix("relative-root", "a"), "relative-root/a");
  });

  test("joinPosix strips a trailing slash on base and ignores empty parts", () => {
    assert.equal(joinPosix("/home/alice/", "", "a/b", ""), "/home/alice/a/b");
  });

  test("joinPosix with no non-empty parts returns base unchanged", () => {
    assert.equal(joinPosix("/home/alice/"), "/home/alice");
    assert.equal(joinPosix(""), "");
  });

  test("joinPosix flattens a part that itself contains '/'", () => {
    assert.equal(joinPosix("/root", "a/b/c"), "/root/a/b/c");
  });
});

describe("P2-01 white-box: entrypoint-glob", () => {
  test("isSafeRelativeEntrypoint rejects absolute/home/drive/traversal/empty", () => {
    for (const bad of ["", "/etc/passwd", "~/x", "C:\\Windows\\x", "a/../../etc/passwd", "..", "a/..", "a/../b"]) {
      assert.equal(isSafeRelativeEntrypoint(bad), false, bad);
    }
  });

  test("isSafeRelativeEntrypoint accepts plain relative paths", () => {
    for (const good of ["train.py", "benchmarks/a.py", "a/b/c.py"]) {
      assert.equal(isSafeRelativeEntrypoint(good), true, good);
    }
  });

  test("compileEntrypointGlob: '*' matches within one segment only", () => {
    const re = compileEntrypointGlob("*.py");
    assert.equal(re.test("train.py"), true);
    assert.equal(re.test("sub/train.py"), false);
  });

  test("compileEntrypointGlob: '**' matches across segments", () => {
    const re = compileEntrypointGlob("**/*.py");
    assert.equal(re.test("train.py"), true);
    assert.equal(re.test("a/b/train.py"), true);
  });

  test("compileEntrypointGlob: literal segment glob does not cross into subdirectories", () => {
    const re = compileEntrypointGlob("benchmarks/*.py");
    assert.equal(re.test("benchmarks/a.py"), true);
    assert.equal(re.test("benchmarks/sub/a.py"), false);
  });

  test("compileEntrypointGlob: '?' matches exactly one non-slash character", () => {
    const re = compileEntrypointGlob("run?.py");
    assert.equal(re.test("run1.py"), true);
    assert.equal(re.test("run12.py"), false);
  });

  test("compileEntrypointGlob escapes regex metacharacters in the literal portion", () => {
    const re = compileEntrypointGlob("a.b+c.py");
    assert.equal(re.test("a.b+c.py"), true);
    assert.equal(re.test("aXb+c.py"), false);
  });

  test("matchesAllowedEntrypoint rejects traversal even against a permissive '**' pattern", () => {
    assert.equal(matchesAllowedEntrypoint("../../etc/passwd", ["**"]), false);
  });

  test("matchesAllowedEntrypoint requires a real pattern match, not just safety", () => {
    assert.equal(matchesAllowedEntrypoint("train.py", ["other.py"]), false);
    assert.equal(matchesAllowedEntrypoint("train.py", ["train.py"]), true);
  });
});

describe("P2-01 white-box: env-allowlist", () => {
  test("no override -> merged equals profile env as-is", () => {
    const result = applyEnvOverride({ A: "1" }, undefined);
    assert.deepEqual(result, { ok: true, merged: { A: "1" } });
  });

  test("override of a declared key is accepted", () => {
    const result = applyEnvOverride({ A: "1" }, { A: "2" });
    assert.deepEqual(result, { ok: true, merged: { A: "2" } });
  });

  test("a brand-new key not on the profile's allowlist is rejected", () => {
    const result = applyEnvOverride({ A: "1" }, { A: "2", B: "3" });
    assert.equal(result.ok, false);
    if (!result.ok) assert.deepEqual(result.rejectedKeys, ["B"]);
  });

  test("undefined profile env means no overrides are ever allowed", () => {
    const result = applyEnvOverride(undefined, { A: "1" });
    assert.equal(result.ok, false);
    if (!result.ok) assert.deepEqual(result.rejectedKeys, ["A"]);
  });

  test("empty caller env against a declared profile env is a no-op", () => {
    assert.deepEqual(applyEnvOverride({ A: "1" }, {}), { ok: true, merged: { A: "1" } });
  });
});

describe("P2-04 white-box: decideCancelAction (identity mismatch decision)", () => {
  const recorded = { bootId: "boot-1", pid: 100, pgid: 100, startTicks: "12345", wrapperToken: "token-a" };

  test("not found at all -> orphaned", () => {
    const probe: ProcessProbe = { found: false };
    assert.deepEqual(decideCancelAction(recorded, probe).action, "orphaned");
  });

  test("every field matching -> signal", () => {
    const probe: ProcessProbe = { found: true, ...recorded };
    assert.deepEqual(decideCancelAction(recorded, probe), { action: "signal" });
  });

  const mismatchCases: Array<[string, Partial<ProcessProbe>, RegExp]> = [
    ["bootId", { bootId: "boot-2" }, /boot id/i],
    ["pid", { pid: 999 }, /pid mismatch/i],
    ["pgid", { pgid: 999 }, /pgid mismatch/i],
    ["startTicks", { startTicks: "99999" }, /start time|ticks/i],
    ["wrapperToken", { wrapperToken: "token-b" }, /token/i],
  ];
  for (const [field, override, expectedReason] of mismatchCases) {
    test(`${field} mismatch alone -> orphaned`, () => {
      const probe: ProcessProbe = { found: true, ...recorded, ...override } as ProcessProbe;
      const decision = decideCancelAction(recorded, probe);
      assert.equal(decision.action, "orphaned");
      if (decision.action === "orphaned") assert.match(decision.reason, expectedReason);
    });
  }
});

describe("P2-04 white-box: sliceUtf8Window (byte-offset UTF-8 boundary safety)", () => {
  test("pure ASCII, no boundary issues", () => {
    const data = Buffer.from("hello world");
    const slice = sliceUtf8Window(data, 0, 100);
    assert.equal(slice.text, "hello world");
    assert.equal(slice.startOffset, 0);
    assert.equal(slice.nextOffset, data.length);
  });

  test("a 3-byte UTF-8 character straddling the cap boundary is extended (up to 3 overread bytes) to include the whole character, never split", () => {
    // "中" is E4 B8 AD (3 bytes). Put "ab" then "中" then "cd".
    const full = Buffer.from("ab\u4e2dcd", "utf8");
    const first = sliceUtf8Window(full, 0, 3);
    // The completion bytes are available, so the character is extended into
    // (not deferred out of) this read -- see the module doc comment.
    assert.equal(first.text, "ab\u4e2d");
    assert.equal(first.nextOffset, 5);

    const second = sliceUtf8Window(full.subarray(first.nextOffset), first.nextOffset, 100);
    assert.equal(second.text, "cd");
    assert.equal(second.startOffset, 5);
    assert.equal(second.nextOffset, full.length);

    // Sequential reconstruction has no duplicated and no dropped bytes.
    assert.equal(first.text + second.text, full.toString("utf8"));
  });

  test("a 4-byte UTF-8 character (emoji) straddling the cap boundary is extended to include the whole character", () => {
    const full = Buffer.from("x\u{1F600}y", "utf8"); // 'x' + 4-byte emoji + 'y'
    const first = sliceUtf8Window(full, 0, 2); // lands 1 byte into the emoji
    assert.equal(first.text, "x\u{1F600}");
    const second = sliceUtf8Window(full.subarray(first.nextOffset), first.nextOffset, 100);
    assert.equal(second.text, "y");
    assert.equal(first.text + second.text, full.toString("utf8"));
  });

  test("an arbitrary mid-character start offset drops only the orphaned leading continuation bytes", () => {
    const full = Buffer.from("\u4e2dcd", "utf8"); // 3-byte char + 'cd'
    // Simulate a caller-chosen offset landing 1 byte into the 3-byte character.
    const midCharacterWindow = full.subarray(1);
    const slice = sliceUtf8Window(midCharacterWindow, 1, 100);
    assert.equal(slice.text, "cd");
    assert.equal(slice.startOffset, 1 + 2); // the 2 remaining continuation bytes were dropped
  });

  test("cap=0 returns an empty slice without advancing past a character boundary incorrectly", () => {
    const full = Buffer.from("abc", "utf8");
    const slice = sliceUtf8Window(full.subarray(0, 3), 0, 0);
    assert.equal(slice.text, "");
    assert.equal(slice.nextOffset, 0);
  });

  test("genuinely truncated data at the real end (no more overread bytes available) defers the partial character", () => {
    // Only the lead byte of a 3-byte character is actually available -- as if
    // we requested overread but the file itself ends exactly there.
    const full = Buffer.from("ab\u4e2dcd", "utf8");
    const onlyLeadByteAvailable = full.subarray(0, 3); // "ab" + first byte of the 3-byte char
    const slice = sliceUtf8Window(onlyLeadByteAvailable, 0, 3);
    assert.equal(slice.text, "ab");
    assert.equal(slice.nextOffset, 2);
  });
});

describe("P2-03 white-box: meta.ts parsing", () => {
  test("parseRunMeta accepts a well-formed document", () => {
    const doc = {
      runId: "run_20260915T120000Z_ab12cd34",
      profile: "p",
      server: "s",
      remoteRoot: "/r",
      workdir: "/r",
      executable: "/bin/python",
      entrypoint: "/r/train.py",
      args: ["--x"],
      env: { A: "1" },
      createdAt: "2026-09-15T12:00:00.000Z",
      identity: { bootId: "b", pid: 1, pgid: 1, startTicks: "1", wrapperToken: "t" },
    };
    const result = parseRunMeta(JSON.stringify(doc));
    assert.equal(result.ok, true);
    if (result.ok) assert.deepEqual(result.value, doc);
  });

  test("parseRunMeta rejects invalid JSON without throwing", () => {
    const result = parseRunMeta("{not json");
    assert.equal(result.ok, false);
  });

  test("parseRunMeta rejects a document missing required fields", () => {
    const result = parseRunMeta(JSON.stringify({ runId: "x" }));
    assert.equal(result.ok, false);
  });

  test("parseRunExit accepts and parseOrphanedMarker accepts well-formed documents", () => {
    assert.equal(parseRunExit(JSON.stringify({ waitStatus: 0, finishedAt: "t", cancelled: false })).ok, true);
    assert.equal(parseOrphanedMarker(JSON.stringify({ detectedAt: "t", reason: "r" })).ok, true);
  });

  test("interpretWaitStatus: 0 is a clean exit", () => {
    assert.deepEqual(interpretWaitStatus(0), { exitCode: 0, signal: null });
  });
  test("interpretWaitStatus: 128 (boundary, not > 128) is a literal exit code, not a signal", () => {
    assert.deepEqual(interpretWaitStatus(128), { exitCode: 128, signal: null });
  });
  test("interpretWaitStatus: 137 (128+SIGKILL) decodes to SIGKILL", () => {
    assert.deepEqual(interpretWaitStatus(137), { exitCode: null, signal: "SIGKILL" });
  });
  test("interpretWaitStatus: 143 (128+SIGTERM) decodes to SIGTERM", () => {
    assert.deepEqual(interpretWaitStatus(143), { exitCode: null, signal: "SIGTERM" });
  });
  test("interpretWaitStatus: an unrecognized signal number falls back to a literal exit code", () => {
    assert.deepEqual(interpretWaitStatus(200), { exitCode: 200, signal: null });
  });
});

describe("P2-04 white-box: cancel-script line parsers", () => {
  test("parseProbeLine: found:false", () => {
    assert.deepEqual(parseProbeLine("noise\nHANDFREE_PROBE:{\"found\":false}\nmore noise"), { found: false });
  });
  test("parseProbeLine: found:true with every field", () => {
    const probe = { found: true, bootId: "b", pid: 1, pgid: 2, startTicks: "3", wrapperToken: "t" };
    assert.deepEqual(parseProbeLine(`HANDFREE_PROBE:${JSON.stringify(probe)}`), probe);
  });
  test("parseProbeLine: no matching line -> null", () => {
    assert.equal(parseProbeLine("nothing relevant here"), null);
  });
  test("parseProbeLine: malformed JSON after the prefix -> null, does not throw", () => {
    assert.equal(parseProbeLine("HANDFREE_PROBE:{not json"), null);
  });

  test("parseCancelOutcome: recognizes each real outcome", () => {
    assert.equal(parseCancelOutcome("HANDFREE_CANCEL:terminated"), "terminated");
    assert.equal(parseCancelOutcome("HANDFREE_CANCEL:killed"), "killed");
    assert.equal(parseCancelOutcome("HANDFREE_CANCEL:already-exited"), "already-exited");
  });
  test("parseCancelOutcome: unrecognized value -> null", () => {
    assert.equal(parseCancelOutcome("HANDFREE_CANCEL:bogus"), null);
    assert.equal(parseCancelOutcome("no sentinel line"), null);
  });
});

describe("P2-03/04 white-box: findSentinelLine", () => {
  test("finds a prefixed line among unrelated output", () => {
    assert.equal(findSentinelLine("a\nHANDFREE_LAUNCHED:{\"x\":1}\nb", "HANDFREE_LAUNCHED:"), '{"x":1}');
  });
  test("returns null when absent", () => {
    assert.equal(findSentinelLine("a\nb", "HANDFREE_LAUNCHED:"), null);
  });
  test("handles CRLF line endings", () => {
    assert.equal(findSentinelLine("a\r\nHANDFREE_LAUNCHED:ok\r\nb", "HANDFREE_LAUNCHED:"), "ok");
  });
});
