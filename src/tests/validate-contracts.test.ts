import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";

// PLAN.MD P0-03-A1: drives the real scripts/validate-contracts.mjs as a
// genuine child process against the real compiled build/contracts output —
// no stubbed schema generator, no simulated OpenAPI document (§7.2).

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Compiled location is build/tests/validate-contracts.test.js; repo root is
// two levels up.
const repoRoot = path.resolve(__dirname, "..", "..");
const scriptPath = path.join(repoRoot, "scripts", "validate-contracts.mjs");

function runValidateContracts(): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [scriptPath], { cwd: repoRoot, encoding: "utf8", timeout: 30000 });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

describe("validate-contracts.mjs (P0-03-A1)", { concurrency: false }, () => {
  test("black-box: exits 0 against the real build output and writes a matching PASS artifact", () => {
    const { status, stderr } = runValidateContracts();
    assert.equal(status, 0, `stderr:\n${stderr}`);
    const artifact = JSON.parse(fs.readFileSync(path.join(repoRoot, "artifacts", "validate-contracts", "result.json"), "utf8"));
    assert.equal(artifact.exitCode, 0);
    assert.equal(artifact.classification, "PASS");
    assert.ok(Array.isArray(artifact.assertions) && artifact.assertions.length > 0);
    assert.ok(artifact.assertions.every((a: { status: string }) => a.status === "PASS"));
  });

  test("black-box + white-box: real artifacts/openapi.json and artifacts/schemas/*.json exist and are well-formed", () => {
    runValidateContracts();
    const openapiPath = path.join(repoRoot, "artifacts", "openapi.json");
    assert.ok(fs.existsSync(openapiPath));
    const openapi = JSON.parse(fs.readFileSync(openapiPath, "utf8"));
    assert.equal(openapi.openapi, "3.0.3");
    assert.ok(Object.keys(openapi.paths).length > 0);
    assert.ok(Object.keys(openapi.components.schemas).length > 0);

    const schemasDir = path.join(repoRoot, "artifacts", "schemas");
    const schemaFiles = fs.readdirSync(schemasDir).filter((f) => f.endsWith(".json"));
    assert.ok(schemaFiles.length >= 10, `expected at least 10 generated schema files, got ${schemaFiles.length}`);
    for (const file of schemaFiles) {
      const parsed = JSON.parse(fs.readFileSync(path.join(schemasDir, file), "utf8"));
      assert.equal(typeof parsed, "object");
    }
  });

  test("grey-box: every deferred (/api/v1/sync/*) OpenAPI path carries x-deferred:true and a 501 SYNC_NOT_AVAILABLE response; no other path does", () => {
    runValidateContracts();
    const openapi = JSON.parse(fs.readFileSync(path.join(repoRoot, "artifacts", "openapi.json"), "utf8"));
    for (const [routePath, methods] of Object.entries(openapi.paths) as [string, Record<string, any>][]) {
      const isSync = routePath.startsWith("/api/v1/sync/");
      for (const operation of Object.values(methods)) {
        assert.equal(Boolean(operation["x-deferred"]), isSync, `${routePath}: x-deferred mismatch`);
        assert.equal("501" in operation.responses, isSync, `${routePath}: 501 response mismatch`);
      }
    }
  });

  test("black-box: exits 2 (MISSING_REQUIRED_CAPABILITY) when build/contracts is genuinely absent", () => {
    const buildContractsDir = path.join(repoRoot, "build", "contracts");
    const backupDir = `${buildContractsDir}.characterization-backup`;
    assert.ok(fs.existsSync(buildContractsDir), "precondition: build/contracts must exist before this test moves it aside");
    fs.renameSync(buildContractsDir, backupDir);
    try {
      const { status, stderr } = runValidateContracts();
      assert.equal(status, 2, `stderr:\n${stderr}`);
      const artifact = JSON.parse(fs.readFileSync(path.join(repoRoot, "artifacts", "validate-contracts", "result.json"), "utf8"));
      assert.equal(artifact.exitCode, 2);
      assert.equal(artifact.classification, "MISSING_REQUIRED_CAPABILITY");
    } finally {
      fs.renameSync(backupDir, buildContractsDir);
    }
  });
});
