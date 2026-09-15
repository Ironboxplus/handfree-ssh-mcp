import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";

// PLAN.MD P0-00: this drives the real scripts/preflight.mjs as a genuine
// child process and asserts on its real exit code and the real JSON artifact
// it writes to a real temp path — no stubbed detectors, no simulated
// capability results (PLAN.MD §7.2).

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Compiled location is build/tests/preflight.test.js; scripts/ lives at the
// repo root two levels up (build/tests -> build -> repo root).
const repoRoot = path.resolve(__dirname, "..", "..");
const scriptPath = path.join(repoRoot, "scripts", "preflight.mjs");

type PreflightRun = { status: number | null; stdout: string; stderr: string };

function runPreflight(args: string[]): PreflightRun {
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 30000,
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function withTempJsonPath<T>(fn: (jsonPath: string, tmpDir: string) => T): T {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "handfree-preflight-test-"));
  try {
    return fn(path.join(tmpDir, "result.json"), tmpDir);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

describe("preflight.mjs (P0-00)", () => {
  test("black-box: --require A exits 0 on this host while the class-B Linux lab is genuinely reported absent", () => {
    withTempJsonPath((jsonPath) => {
      const { status, stdout, stderr } = runPreflight(["--require", "A", "--json", jsonPath]);
      assert.equal(status, 0, `expected exit 0, got ${status}. stdout:\n${stdout}\nstderr:\n${stderr}`);
      const artifact = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
      assert.equal(artifact.exitCode, 0);
      assert.equal(artifact.classification, "PASS");

      const linuxLab = artifact.capabilities.find((c: any) => c.id === "linux-lab-environment");
      assert.ok(linuxLab, "expected a linux-lab-environment capability entry");
      assert.equal(linuxLab.class, "B");
      // This combination is the whole point of the test (per the P0-00 task):
      // this dev host genuinely has neither Docker nor a WSL2 distro
      // installed (verified independently: `docker` is not on PATH, and
      // `wsl.exe -l -q` lists zero distros), so the real probe must report
      // the class-B Linux lab as not satisfied — while `--require A` still
      // exits 0, because B was never required for this invocation.
      assert.notEqual(
        linuxLab.status,
        "PASS",
        `expected the Linux lab to be genuinely absent on this host, got status=${linuxLab.status}`,
      );
    });
  });

  test("grey-box: requiring the genuinely-missing class B exits 2 with a matching JSON classification", () => {
    withTempJsonPath((jsonPath) => {
      const { status } = runPreflight(["--require", "A,B", "--json", jsonPath]);
      assert.equal(status, 2, "requiring B on a host with neither Docker nor a WSL2 distro must fail for real");
      const artifact = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
      assert.equal(artifact.exitCode, 2);
      assert.equal(artifact.classification, "MISSING_REQUIRED_CAPABILITY");
      assert.ok(Array.isArray(artifact.unmetRequired) && artifact.unmetRequired.length > 0);
      assert.ok(
        artifact.unmetRequired.includes("linux-lab-environment"),
        `expected linux-lab-environment among unmetRequired, got: ${JSON.stringify(artifact.unmetRequired)}`,
      );
    });
  });

  test("white-box: JSON artifact contains real versions, platform, and per-item PASS/FAIL/NOT_APPLICABLE status", () => {
    withTempJsonPath((jsonPath) => {
      const { status } = runPreflight(["--require", "A", "--json", jsonPath]);
      assert.equal(status, 0);
      const artifact = JSON.parse(fs.readFileSync(jsonPath, "utf8"));

      // versions
      assert.equal(artifact.versions.node, process.version, "child process's own node --version should match");
      assert.equal(typeof artifact.versions.npm, "string");
      assert.match(artifact.versions.npm, /\d+\.\d+\.\d+/);
      assert.equal(typeof artifact.versions.git, "string");
      assert.match(artifact.versions.git, /git version/i);
      assert.equal(typeof artifact.versions.tar, "string");

      // platform
      assert.equal(artifact.platform.os, process.platform);
      assert.equal(artifact.platform.arch, process.arch);
      assert.equal(typeof artifact.platform.release, "string");

      // config fingerprint: present, stable shape, deterministic for the
      // same inputs (re-running with the same --require must reproduce it).
      assert.match(artifact.configFingerprint, /^sha256:[0-9a-f]{64}$/);

      // per-item status classification
      assert.ok(Array.isArray(artifact.capabilities) && artifact.capabilities.length > 0);
      const validStatuses = new Set(["PASS", "FAIL", "NOT_APPLICABLE"]);
      for (const capability of artifact.capabilities) {
        assert.ok(validStatuses.has(capability.status), `unexpected status '${capability.status}' for ${capability.id}`);
        assert.ok(["A", "B", "C"].includes(capability.class), `unexpected class '${capability.class}' for ${capability.id}`);
        assert.equal(typeof capability.id, "string");
        assert.ok(capability.id.length > 0);
      }
      // At least one PASS, one FAIL, and one NOT_APPLICABLE must actually
      // occur on this real host — otherwise this test would not be
      // distinguishing real classification behaviour at all.
      const statuses = new Set(artifact.capabilities.map((c: any) => c.status));
      assert.ok(statuses.has("PASS"), "expected at least one real PASS");
      assert.ok(statuses.has("FAIL"), "expected at least one real FAIL (the absent Linux lab)");
      assert.ok(statuses.has("NOT_APPLICABLE"), "expected at least one real NOT_APPLICABLE (class C)");
    });
  });

  test("white-box: every NOT_APPLICABLE capability carries a non-empty reason string", () => {
    withTempJsonPath((jsonPath) => {
      const { status } = runPreflight(["--require", "A", "--json", jsonPath]);
      assert.equal(status, 0);
      const artifact = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
      const notApplicable = artifact.capabilities.filter((c: any) => c.status === "NOT_APPLICABLE");
      assert.ok(notApplicable.length > 0, "expected at least one NOT_APPLICABLE capability to check");
      for (const capability of notApplicable) {
        assert.equal(typeof capability.reason, "string", `${capability.id} is NOT_APPLICABLE but has no reason`);
        assert.ok(capability.reason.trim().length > 0, `${capability.id}'s reason must not be empty`);
      }
    });
  });

  test("black-box: an invalid --require value is a real usage/assertion failure (exit 1)", () => {
    withTempJsonPath((jsonPath) => {
      const { status } = runPreflight(["--require", "Z", "--json", jsonPath]);
      assert.equal(status, 1);
      const artifact = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
      assert.equal(artifact.exitCode, 1);
      assert.equal(artifact.classification, "ASSERTION_FAILURE");
    });
  });

  test("grey-box: a real infrastructure error (unwritable JSON target) exits 3 with a matching classification", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "handfree-preflight-test-infra-"));
    try {
      // A real, non-simulated infra failure: the parent path component of
      // the requested artifact is a plain file, so mkdir -p genuinely fails.
      const blockingFile = path.join(tmpDir, "not-a-directory");
      fs.writeFileSync(blockingFile, "x");
      const jsonPath = path.join(blockingFile, "sub", "result.json");

      const { status, stderr } = runPreflight(["--require", "A", "--json", jsonPath]);
      assert.equal(status, 3, `expected exit 3, got ${status}. stderr:\n${stderr}`);
      assert.equal(fs.existsSync(jsonPath), false, "the broken target path must not have been created");

      // The script falls back to writing the same classification to a temp
      // location when the requested destination is unwritable, precisely so
      // this outcome remains discoverable rather than silently vanishing.
      const match = stderr.match(/fallback artifact written to (.+\.json)/);
      assert.ok(match, `expected a fallback-artifact-written message in stderr:\n${stderr}`);
      const fallbackPath = match![1].trim();
      const artifact = JSON.parse(fs.readFileSync(fallbackPath, "utf8"));
      assert.equal(artifact.exitCode, 3);
      assert.equal(artifact.classification, "INFRASTRUCTURE_ERROR");
      fs.rmSync(path.dirname(fallbackPath), { recursive: true, force: true });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("white-box: the same --require input reproduces the same configFingerprint", () => {
    withTempJsonPath((jsonPathA) => {
      withTempJsonPath((jsonPathB) => {
        runPreflight(["--require", "A", "--json", jsonPathA]);
        runPreflight(["--require", "A", "--json", jsonPathB]);
        const a = JSON.parse(fs.readFileSync(jsonPathA, "utf8"));
        const b = JSON.parse(fs.readFileSync(jsonPathB, "utf8"));
        assert.equal(a.configFingerprint, b.configFingerprint);

        const jsonPathC = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "handfree-preflight-test-")), "result.json");
        try {
          runPreflight(["--require", "A,B", "--json", jsonPathC]);
          const c = JSON.parse(fs.readFileSync(jsonPathC, "utf8"));
          // Different --require input must change the fingerprint (it is
          // part of the canonical payload being hashed).
          assert.notEqual(a.configFingerprint, c.configFingerprint);
        } finally {
          fs.rmSync(path.dirname(jsonPathC), { recursive: true, force: true });
        }
      });
    });
  });
});
