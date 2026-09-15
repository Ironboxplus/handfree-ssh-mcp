import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, test } from "node:test";

// PLAN.MD P0-02: exercises the real scripts/ssh-lab.mjs as a genuine child
// process — same pattern as preflight.test.ts (PLAN.MD §7.2: no stubbed
// detectors, no simulated results).
//
// What lives in THIS file vs. what does not:
//  - Pure-function white-box tests (buildProjectName, parseDockerComposePort
//    Output, deterministicPayload, shellQuote) require no external host and
//    run unconditionally as part of `npm test`.
//  - The script's own config-validation contract (missing required env vars
//    -> exit 2 / MISSING_REQUIRED_CAPABILITY; bad subcommand -> exit 1) is
//    real, deterministic, and needs no live infrastructure, so it also runs
//    unconditionally here.
//  - The actual P0-02-A1 acceptance run (spin up two real containers on the
//    lab host, real SSH/SFTP round-trip, pinned-key + failing-key checks) is
//    NOT run from this file. It requires a real Docker-capable Linux host
//    reachable over SSH (PLAN.MD's class-B "Linux lab" capability, per
//    P0-00), which is not present on every dev machine and must never
//    silently mock/skip. That live run is its own gate:
//    `npm run test:acceptance:ssh` -> `node scripts/ssh-lab.mjs test ssh`,
//    configured entirely via SSH_LAB_* environment variables (never
//    hardcoded credentials in a git-tracked file).

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Compiled location is build/tests/ssh-lab.test.js; scripts/ lives at the
// repo root two levels up (build/tests -> build -> repo root).
const repoRoot = path.resolve(__dirname, "..", "..");
const scriptPath = path.join(repoRoot, "scripts", "ssh-lab.mjs");

type ScriptRun = { status: number | null; stdout: string; stderr: string };

function runSshLabScript(args: string[], env: NodeJS.ProcessEnv = {}): ScriptRun {
  // Deliberately does NOT inherit SSH_LAB_* from the ambient shell, so this
  // test's "missing capability" assertions are genuine regardless of what
  // happens to be exported in whichever shell runs `npm test`.
  const scrubbedEnv = { ...process.env };
  for (const key of Object.keys(scrubbedEnv)) {
    if (key.startsWith("SSH_LAB_")) delete scrubbedEnv[key];
  }
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 15000,
    env: { ...scrubbedEnv, ...env },
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** Runs a snippet of real code against the actual exported pure functions in
 * scripts/ssh-lab.mjs, in a genuine child `node` process (avoids fighting
 * tsc's rootDir with a cross-tree static import of a plain .mjs script,
 * while still executing the real production code, not a reimplementation). */
function evalInScript(expression: string): { status: number | null; stdout: string; stderr: string } {
  const src = `import * as m from ${JSON.stringify(pathToFileURL(scriptPath).href)};\nconsole.log(JSON.stringify(${expression}));`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", src], {
    encoding: "utf8",
    timeout: 15000,
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

describe("ssh-lab.mjs (P0-02) pure helpers - white-box", () => {
  test("buildProjectName: namespaces every run under a shared, greppable prefix", () => {
    for (const token of ["ab12cd34", "0", "ffffffff", "abc"]) {
      const { status, stdout } = evalInScript(`m.buildProjectName(${JSON.stringify(token)})`);
      assert.equal(status, 0, stdout);
      assert.equal(JSON.parse(stdout), `handfree-sshlab-${token}`);
    }
  });

  test("parseDockerComposePortOutput: exhaustive real-shaped `docker compose port` outputs", () => {
    const cases: Array<[string, number | "throws"]> = [
      ["0.0.0.0:32768\n", 32768],
      ["0.0.0.0:32768", 32768],
      ["0.0.0.0:32768\n:::32768\n", 32768],
      ["\n\n0.0.0.0:40000\n", 40000],
      ["  0.0.0.0:50000  \n", 50000],
      ["not-a-port-line\n", "throws"],
      ["", "throws"],
      ["   \n  \n", "throws"],
      ["0.0.0.0:70000\n", "throws"],
      ["0.0.0.0:0\n", "throws"],
    ];
    for (const [input, expected] of cases) {
      const { status, stdout, stderr } = evalInScript(`m.parseDockerComposePortOutput(${JSON.stringify(input)})`);
      if (expected === "throws") {
        assert.notEqual(status, 0, `expected a throw for input ${JSON.stringify(input)}, got stdout=${stdout}`);
      } else {
        assert.equal(status, 0, `input ${JSON.stringify(input)} stderr:\n${stderr}`);
        assert.equal(JSON.parse(stdout), expected, `input ${JSON.stringify(input)}`);
      }
    }
  });

  test("deterministicPayload: same seed+size reproduces byte-identical output, real SHA-256 stable", () => {
    const src = `
      const a = m.deterministicPayload("p0-02-source", 256 * 1024);
      const b = m.deterministicPayload("p0-02-source", 256 * 1024);
      const c = m.deterministicPayload("p0-02-destination", 256 * 1024);
      const crypto = await import("node:crypto");
      const result = {
        aEqualsB: Buffer.compare(a, b) === 0,
        aEqualsC: Buffer.compare(a, c) === 0,
        lengthA: a.length,
        sha256A: crypto.createHash("sha256").update(a).digest("hex"),
      };
      console.log(JSON.stringify(result));
    `;
    const full = `import * as m from ${JSON.stringify(pathToFileURL(scriptPath).href)};\n${src}`;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", full], { encoding: "utf8", timeout: 15000 });
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.aEqualsB, true, "same seed+size must reproduce identical bytes");
    assert.equal(parsed.aEqualsC, false, "different seed must not coincidentally match");
    assert.equal(parsed.lengthA, 256 * 1024);
    assert.match(parsed.sha256A, /^[0-9a-f]{64}$/);
  });

  test("deterministicPayload: exact size respected at boundary values, including zero", () => {
    for (const size of [0, 1, 31, 32, 33, 1000]) {
      const { status, stdout } = evalInScript(`m.deterministicPayload("seed", ${size}).length`);
      assert.equal(status, 0);
      assert.equal(JSON.parse(stdout), size);
    }
  });

  test("deterministicPayload: negative size is a real thrown error, not a silently clamped value", () => {
    const { status } = evalInScript(`m.deterministicPayload("seed", -1)`);
    assert.notEqual(status, 0);
  });

  test("shellQuote: round-trips through a real POSIX shell (sh -c), including embedded quotes", () => {
    if (process.platform === "win32") {
      // No real POSIX `sh` on this host to round-trip through; still verify
      // the escaping shape itself is well-formed.
      for (const value of ["plain", "it's", "a'b'c", "", "with space"]) {
        const { status, stdout } = evalInScript(`m.shellQuote(${JSON.stringify(value)})`);
        assert.equal(status, 0);
        const quoted = JSON.parse(stdout);
        assert.ok(quoted.startsWith("'") && quoted.endsWith("'"), quoted);
      }
      return;
    }
    for (const value of ["plain", "it's", "a'b'c", "", "with space", "$(rm -rf /)"]) {
      const { stdout: quotedJson } = evalInScript(`m.shellQuote(${JSON.stringify(value)})`);
      const quoted = JSON.parse(quotedJson);
      const result = spawnSync("sh", ["-c", `printf '%s' ${quoted}`], { encoding: "utf8" });
      assert.equal(result.stdout, value, `shellQuote round-trip failed for ${JSON.stringify(value)}`);
    }
  });
});

describe("ssh-lab.mjs (P0-02) script contract - black-box, no live host required", () => {
  test("black-box: missing all SSH_LAB_* env vars is a real MISSING_REQUIRED_CAPABILITY, exit 2", () => {
    const { status, stderr } = runSshLabScript(["test", "ssh"]);
    assert.equal(status, 2, `stderr:\n${stderr}`);
    const artifactPath = path.join(repoRoot, "artifacts", "ssh-lab", "result.json");
    assert.ok(fs.existsSync(artifactPath), "expected the script to write its JSON artifact even on a config failure");
    const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
    assert.equal(artifact.exitCode, 2);
    assert.equal(artifact.classification, "MISSING_REQUIRED_CAPABILITY");
    assert.match(artifact.error, /SSH_LAB_HOST/);
  });

  test("black-box: partial config (host+user, no key or password) is still a real exit-2 capability failure", () => {
    const { status } = runSshLabScript(["test", "ssh"], { SSH_LAB_HOST: "10.100.100.88", SSH_LAB_USER: "arc" });
    assert.equal(status, 2);
  });

  test("black-box: an unknown subcommand is a real usage error, exit 1, before any env is even read", () => {
    const { status, stderr } = runSshLabScript(["bogus"]);
    assert.equal(status, 1);
    assert.match(stderr, /usage/i);
  });

  test("grey-box: the artifact directory is created fresh under artifacts/ssh-lab on every real invocation", () => {
    const artifactPath = path.join(repoRoot, "artifacts", "ssh-lab", "result.json");
    if (fs.existsSync(artifactPath)) fs.rmSync(artifactPath);
    runSshLabScript(["test", "ssh"]);
    assert.ok(fs.existsSync(artifactPath), "expected a fresh result.json after re-running with no prior artifact present");
  });
});
