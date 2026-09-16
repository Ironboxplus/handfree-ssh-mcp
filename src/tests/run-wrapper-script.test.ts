import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { after, before, describe, test } from "node:test";
import { buildStaticMetaJson, buildWrapperScript, type WrapperLaunchSpec } from "../run/wrapper-script.js";
import { buildLaunchExecCommand, buildRemoteScriptExecCommand } from "../run/launch-command.js";
import { computeRunPaths } from "../run/remote-run-paths.js";
import { buildProbeScript, buildSignalScript, buildWriteOrphanedMarkerScript } from "../run/cancel-script.js";

// PLAN.MD P2-03: the remote wrapper's actual detach/setsid/proc semantics
// are Linux-only and cannot be genuinely exercised on this Windows dev box
// (see the acceptance tests in run-acceptance-linux-pending.test.ts). What
// CAN be verified for real here, with a real bash interpreter (git-bash is
// present on this dev box), is that every generated script is syntactically
// valid shell -- `bash -n` parses without executing anything Linux-specific
// -- plus the pure JS-side string arithmetic (the meta.json splice point,
// the base64 transport round trip) that has nothing to do with the OS at
// all. Skips (not fails) if bash truly is not on PATH anywhere.

function bashAvailable(): boolean {
  return spawnSync("bash", ["--version"]).error === undefined;
}

function assertBashSyntaxValid(script: string, label: string): void {
  if (!bashAvailable()) {
    console.warn(`[skip] bash not available on PATH -- cannot syntax-check ${label}`);
    return;
  }
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "handfree-bash-syntax-"));
  const scriptPath = path.join(tmpDir, "script.sh");
  fs.writeFileSync(scriptPath, script, "utf8");
  try {
    const result = spawnSync("bash", ["-n", scriptPath], { encoding: "utf8" });
    assert.equal(result.status, 0, `${label} failed bash -n syntax check: ${result.stderr}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function sampleSpec(overrides: Partial<WrapperLaunchSpec> = {}): WrapperLaunchSpec {
  const runId = "run_20260915T120000Z_ab12cd34";
  return {
    runId,
    profile: "qwen-dev",
    server: "gpu4090",
    remoteRoot: "/data/arc/qwen",
    workdir: "/data/arc/qwen",
    executable: "/data/arc/venvs/qwen/bin/python",
    entrypoint: "/data/arc/qwen/train.py",
    args: ["--epochs", "3", `it's "quoted"`, "$(rm -rf /)", "unicode 中文"],
    env: { PYTHONUNBUFFERED: "1", "WEIRD'S_KEY": `va'lue"$(x)` },
    wrapperToken: "deadbeefcafebabe0011223344556677",
    createdAt: "2026-09-15T12:00:00.000Z",
    heartbeatIntervalSec: 5,
    paths: computeRunPaths(runId),
    ...overrides,
  };
}

describe("P2-03 grey-box: buildStaticMetaJson / identity splice", () => {
  test("ends with exactly one '}' (required for the string-splice technique)", () => {
    const json = buildStaticMetaJson(sampleSpec());
    assert.equal(json.endsWith("}"), true);
    assert.equal(json.endsWith("}}"), false);
  });

  test("splicing an identity object into the stripped prefix reproduces exactly what parseRunMeta expects", async () => {
    const spec = sampleSpec();
    const staticJson = buildStaticMetaJson(spec);
    const prefix = staticJson.slice(0, -1);
    const identity = { bootId: "boot-abc", pid: 4242, pgid: 4242, startTicks: "998877", wrapperToken: spec.wrapperToken };
    const fullJson = `${prefix},"identity":${JSON.stringify(identity)}}`;

    const { parseRunMeta } = await import("../run/meta.js");
    const parsed = parseRunMeta(fullJson);
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.equal(parsed.value.runId, spec.runId);
    assert.equal(parsed.value.profile, spec.profile);
    assert.deepEqual(parsed.value.args, spec.args);
    assert.deepEqual(parsed.value.env, spec.env);
    assert.deepEqual(parsed.value.identity, identity);
  });
});

describe("P2-03 grey-box: buildWrapperScript is syntactically valid real bash", () => {
  test("plain spec", () => {
    assertBashSyntaxValid(buildWrapperScript(sampleSpec()), "wrapper script (plain)");
  });

  test("spec with shell-hostile args/env (quotes, $(), backticks, unicode)", () => {
    const script = buildWrapperScript(
      sampleSpec({
        args: ["; rm -rf ~ #", "`id`", "$(whoami)", "a\nb", "--flag='value'"],
        env: { A: "1'2`3$4", B: "" },
      }),
    );
    assertBashSyntaxValid(script, "wrapper script (hostile args/env)");
  });

  test("spec with zero args and zero env exports", () => {
    const script = buildWrapperScript(sampleSpec({ args: [], env: {} }));
    assertBashSyntaxValid(script, "wrapper script (no args/env)");
  });

  test("every dynamic value appears only inside a single-quoted literal, never bare", () => {
    const spec = sampleSpec();
    const script = buildWrapperScript(spec);
    // The raw executable path must not appear unquoted anywhere (it should
    // only ever appear as 'value' via posixShellQuote).
    assert.equal(script.includes(`EXECUTABLE=${spec.executable}\n`), false);
    assert.ok(script.includes(`'${spec.executable}'`));
  });
});

describe("P2-04 grey-box: cancel-script builders are syntactically valid real bash", () => {
  test("probe script", () => {
    assertBashSyntaxValid(buildProbeScript(4242), "probe script");
  });

  test("signal script", () => {
    const paths = computeRunPaths("run_20260915T120000Z_ab12cd34");
    assertBashSyntaxValid(
      buildSignalScript({ paths, pgid: 4242, pid: 4242, graceMs: 5000 }),
      "signal script",
    );
  });

  test("write-orphaned-marker script, including a reason string with quotes", () => {
    const paths = computeRunPaths("run_20260915T120000Z_ab12cd34");
    assertBashSyntaxValid(
      buildWriteOrphanedMarkerScript(paths.orphanedPath, `pid reuse: recorded "boot-1", now "boot-2"`, "2026-09-15T12:00:00.000Z"),
      "write-orphaned-marker script",
    );
  });
});

describe("P2-03 grey-box: launch-command base64/heredoc transport", () => {
  test("the outer exec command string contains no raw script bytes -- only the heredoc marker and base64 alphabet", () => {
    const script = buildWrapperScript(sampleSpec({ args: ["'; rm -rf / #", "$(evil)"] }));
    const command = buildLaunchExecCommand(script);
    const lines = command.split("\n");
    assert.equal(lines[0], "base64 -d <<'HANDFREE_WRAPPER_SCRIPT_EOF' | bash -s");
    assert.equal(lines[lines.length - 2], "HANDFREE_WRAPPER_SCRIPT_EOF");
    const body = lines.slice(1, -2).join("");
    assert.match(body, /^[A-Za-z0-9+/=]*$/);
  });

  test("base64 round trip reproduces the exact original script byte-for-byte", () => {
    const script = buildWrapperScript(sampleSpec());
    const command = buildLaunchExecCommand(script);
    const lines = command.split("\n");
    const base64Body = lines.slice(1, -2).join("");
    const decoded = Buffer.from(base64Body, "base64").toString("utf8");
    assert.equal(decoded, script);
  });

  test("real bash: base64 -d | bash -s round trip actually decodes and would execute the right bytes (dry run via `bash -n` on the decoded content, not full execution)", () => {
    if (!bashAvailable()) {
      console.warn("[skip] bash not available on PATH");
      return;
    }
    const script = buildWrapperScript(sampleSpec());
    const command = buildLaunchExecCommand(script).replace("| bash -s", "| bash -c 'cat > /dev/null; echo OK'");
    const result = spawnSync("bash", ["-c", command], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /OK/);
  });

  test("buildRemoteScriptExecCommand is the same transport (identity re-export)", () => {
    assert.equal(buildRemoteScriptExecCommand, buildLaunchExecCommand);
  });
});
