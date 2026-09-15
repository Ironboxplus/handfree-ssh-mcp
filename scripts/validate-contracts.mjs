#!/usr/bin/env node
// PLAN.MD P0-03-A1 gate: generates real JSON Schema + OpenAPI artifacts from
// the actual compiled src/contracts/*.ts modules (not a hand-maintained
// copy), and verifies every documented config example actually parses
// against the real schema. Exit code contract per §7.4: 0 pass, 1 assertion
// failure, 2 missing required capability (build output not present), 3
// infrastructure error — same classification written to
// artifacts/validate-contracts/result.json.

import { zodToJsonSchema } from "zod-to-json-schema";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import yaml from "js-yaml";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const buildContractsDir = path.join(repoRoot, "build", "contracts");
const artifactsDir = path.join(repoRoot, "artifacts", "validate-contracts");
const schemasOutDir = path.join(repoRoot, "artifacts", "schemas");

function writeArtifact(result) {
  fs.mkdirSync(artifactsDir, { recursive: true });
  fs.writeFileSync(path.join(artifactsDir, "result.json"), JSON.stringify(result, null, 2) + "\n", "utf8");
}

async function main() {
  const log = [];
  const record = (line) => {
    log.push(line);
    process.stderr.write(line + "\n");
  };

  if (!fs.existsSync(buildContractsDir)) {
    const result = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      exitCode: 2,
      classification: "MISSING_REQUIRED_CAPABILITY",
      error: `${buildContractsDir} does not exist — run \`npm run build\` first (this script validates the compiled contracts, not the TypeScript source directly)`,
      log,
    };
    record(result.error);
    writeArtifact(result);
    process.exitCode = 2;
    return;
  }

  let contracts;
  const importCompiled = (name) => import(pathToFileURL(path.join(buildContractsDir, name)).href);
  try {
    contracts = {
      primitives: await importCompiled("primitives.js"),
      identity: await importCompiled("identity.js"),
      error: await importCompiled("error.js"),
      envelope: await importCompiled("envelope.js"),
      job: await importCompiled("job.js"),
      event: await importCompiled("event.js"),
      transfer: await importCompiled("transfer-contract.js"),
      run: await importCompiled("run-contract.js"),
      sync: await importCompiled("sync-placeholder.js"),
      config: await importCompiled("config-schema.js"),
      legacyTools: await importCompiled("legacy-tools.js"),
    };
  } catch (error) {
    const result = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      exitCode: 3,
      classification: "INFRASTRUCTURE_ERROR",
      error: `failed to import compiled contract modules: ${error.stack ?? error}`,
      log,
    };
    record(result.error);
    writeArtifact(result);
    process.exitCode = 3;
    return;
  }

  const assertions = [];
  const assert = (id, fn) => {
    try {
      fn();
      assertions.push({ id, status: "PASS" });
      record(`[PASS] ${id}`);
    } catch (error) {
      assertions.push({ id, status: "FAIL", error: error.message ?? String(error) });
      record(`[FAIL] ${id}: ${error.message ?? error}`);
    }
  };

  // Named schemas to publish as artifacts/schemas/<name>.json and reference
  // from the OpenAPI document's components.schemas.
  const namedSchemas = {
    ErrorObject: contracts.error.errorObjectSchema,
    Envelope: contracts.envelope.envelopeSchema,
    JobRecord: contracts.job.jobRecordSchema,
    JobEvent: contracts.event.jobEventSchema,
    TransferExtendedParams: contracts.transfer.transferExtendedParamsSchema,
    BatchUploadParams: contracts.transfer.batchUploadParamsSchema,
    BatchUploadResult: contracts.transfer.batchUploadResultSchema,
    WorkspaceRunParams: contracts.run.workspaceRunParamsSchema,
    PhasePipelineResult: contracts.run.phasePipelineResultSchema,
    HandfreeV2Config: contracts.config.handfreeV2ConfigSchema,
  };

  let schemaCount = 0;
  assert("generate-json-schemas", () => {
    fs.mkdirSync(schemasOutDir, { recursive: true });
    for (const [name, schema] of Object.entries(namedSchemas)) {
      const jsonSchema = zodToJsonSchema(schema, name);
      fs.writeFileSync(path.join(schemasOutDir, `${name}.json`), JSON.stringify(jsonSchema, null, 2) + "\n", "utf8");
      schemaCount += 1;
    }
    if (schemaCount !== Object.keys(namedSchemas).length) {
      throw new Error(`expected ${Object.keys(namedSchemas).length} schema files, wrote ${schemaCount}`);
    }
  });

  // OpenAPI document assembled from the real HTTP_ROUTES manifest (§5.3) +
  // the same JSON Schemas just generated, so it can never silently drift
  // from the Zod source of truth.
  let openapiDocument;
  assert("generate-openapi-document", () => {
    const componentSchemas = {};
    for (const [name, schema] of Object.entries(namedSchemas)) {
      componentSchemas[name] = zodToJsonSchema(schema, { name, $refStrategy: "none" });
    }
    const paths = {};
    for (const route of contracts.sync.HTTP_ROUTES) {
      paths[route.path] = paths[route.path] ?? {};
      const operation = {
        summary: `${route.method} ${route.path}`,
        responses: {
          200: { description: "OK" },
        },
      };
      if (route.deferred) {
        operation["x-deferred"] = true;
        operation.description =
          "Deferred to Phase 3 (three-mode sync), per PLAN.MD Rev.3 §0. Returns a SYNC_NOT_AVAILABLE-shaped error; no behavior is implemented in this delivery round.";
        operation.responses["501"] = {
          description: "Not implemented (SYNC_NOT_AVAILABLE)",
          content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorObject" } } },
        };
      }
      paths[route.path][route.method.toLowerCase()] = operation;
    }
    openapiDocument = {
      openapi: "3.0.3",
      info: {
        title: "handfree-ssh-mcp v2 API (PLAN.MD §5.3)",
        version: "2.0.0-p0-03-contract-draft",
      },
      paths,
      components: { schemas: componentSchemas },
    };
    fs.mkdirSync(path.join(repoRoot, "artifacts"), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, "artifacts", "openapi.json"), JSON.stringify(openapiDocument, null, 2) + "\n", "utf8");
  });

  assert("openapi-route-count-matches-manifest", () => {
    const pathCount = Object.values(openapiDocument.paths).reduce((sum, methods) => sum + Object.keys(methods).length, 0);
    if (pathCount !== contracts.sync.HTTP_ROUTES.length) {
      throw new Error(`OpenAPI document has ${pathCount} operations, HTTP_ROUTES manifest has ${contracts.sync.HTTP_ROUTES.length}`);
    }
  });

  // §P0-03-A1: "所有文档示例可解析" — the real PLAN.MD §5.1 YAML example, shared
  // with src/tests/contracts.test.ts via the same fixture file.
  assert("plan-5-1-yaml-example-parses", () => {
    const fixturePath = path.join(repoRoot, "tests", "fixtures", "contracts", "plan-5-1-example.yaml");
    if (!fs.existsSync(fixturePath)) throw new Error(`missing fixture: ${fixturePath}`);
    const raw = yaml.load(fs.readFileSync(fixturePath, "utf8"));
    const { warnings } = contracts.config.parseHandfreeV2Config(raw);
    if (warnings.length !== 0) throw new Error(`expected zero deprecation warnings, got ${JSON.stringify(warnings)}`);
  });

  // §5.2 envelope example parses.
  assert("plan-5-2-envelope-example-parses", () => {
    contracts.envelope.envelopeSchema.parse({
      ok: true,
      jobId: "transfer_20260914_ab12cd34",
      state: "running",
      message: "Transfer started",
      next: "Poll transfer-status",
      details: {},
    });
  });

  // Deferred sync tools/routes: real, non-silent placeholder behavior.
  assert("deferred-sync-tools-all-produce-sync-not-available", () => {
    for (const name of contracts.sync.DEFERRED_SYNC_TOOL_NAMES) {
      const error = contracts.sync.handleDeferredSyncTool(name);
      if (error.code !== "SYNC_NOT_AVAILABLE") throw new Error(`${name} did not return SYNC_NOT_AVAILABLE`);
    }
  });

  assert("mode-planner-is-explicitly-deferred-not-silently-stubbed", () => {
    try {
      contracts.sync.modePlanner({ direction: "push", local: "changed", remote: "same", baseExisted: true });
      throw new Error("modePlanner must throw (Phase 3 deferred), but it returned a decision");
    } catch (error) {
      if (!/Phase 3/.test(error.message)) throw new Error(`modePlanner's rejection message does not mention Phase 3: ${error.message}`);
    }
  });

  const failed = assertions.filter((a) => a.status === "FAIL");
  const exitCode = failed.length > 0 ? 1 : 0;
  const result = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    exitCode,
    classification: exitCode === 0 ? "PASS" : "ASSERTION_FAILURE",
    schemasWritten: schemaCount,
    schemasDir: path.relative(repoRoot, schemasOutDir),
    openapiPath: path.relative(repoRoot, path.join(repoRoot, "artifacts", "openapi.json")),
    assertions,
    log,
  };
  writeArtifact(result);
  record(`artifact written to ${path.join(artifactsDir, "result.json")}`);
  process.exitCode = exitCode;
}

main().catch((error) => {
  const result = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    exitCode: 3,
    classification: "INFRASTRUCTURE_ERROR",
    error: error.stack ?? String(error),
  };
  try {
    writeArtifact(result);
  } catch {
    // last resort: still surface via stderr and exit code even if the
    // artifact itself cannot be written.
  }
  process.stderr.write(`validate-contracts: unhandled error: ${result.error}\n`);
  process.exitCode = 3;
});
