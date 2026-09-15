import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";
import yaml from "js-yaml";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Compiled location is build/tests/contracts.test.js; repo root is two
// levels up (build/tests -> build -> repo root).
const repoRoot = path.resolve(__dirname, "..", "..");
const PLAN_5_1_EXAMPLE_PATH = path.join(repoRoot, "tests", "fixtures", "contracts", "plan-5-1-example.yaml");

import {
  parseDuration,
  parseByteSize,
  canonicalJsonStringify,
  sha256Hex,
} from "../contracts/primitives.js";
import {
  computeInstanceId,
  shortInstanceId,
  computeConfigRevision,
  computePolicyFingerprint,
  assertNoSecretLikeKeys,
} from "../contracts/identity.js";
import {
  JOB_STATES,
  isValidTransition,
  allowedTransitions,
  isTerminalState,
  assertRunIdMatchesJobId,
  type JobState,
} from "../contracts/job.js";
import {
  validateTransferCombination,
  detectBatchTargetCollisions,
  validateBatchUpload,
  validateArchiveNotCombinedWithBatch,
  basenameOf,
  MAX_BATCH_UPLOAD_SIZE,
} from "../contracts/transfer-contract.js";
import {
  checkSyncParamSupported,
  computeCleanupOrder,
  findMissingPhaseReports,
  findSkippedPhasesMissingReason,
  WORKSPACE_RUN_PHASE_ORDER,
  TRANSFER_PIPELINE_PHASE_ORDER,
} from "../contracts/run-contract.js";
import {
  DEFERRED_SYNC_TOOL_NAMES,
  handleDeferredSyncTool,
  modePlanner,
  MODE_PLANNER_NOT_IMPLEMENTED_REASON,
  HTTP_ROUTES,
  isDeferredRoute,
} from "../contracts/sync-placeholder.js";
import { expandHomePath, parseHandfreeV2Config, handfreeV2ConfigSchema } from "../contracts/config-schema.js";
import { errorObjectSchema, legacyErrorSchema } from "../contracts/error.js";
import { envelopeSchema } from "../contracts/envelope.js";

// ===========================================================================
// primitives.ts
// ===========================================================================

describe("contracts/primitives.ts", () => {
  test("white-box: parseDuration accepts every unit and rejects every malformed input", () => {
    const valid: Array<[number | string, number]> = [
      [500, 500],
      ["500ms", 500],
      ["5s", 5000],
      ["2m", 120000],
      ["1h", 3600000],
      ["1d", 86400000],
      ["1.5s", 1500],
      ["0.5m", 30000],
    ];
    for (const [input, expected] of valid) {
      assert.equal(parseDuration(input), expected, `input ${JSON.stringify(input)}`);
    }
    const invalid: Array<number | string> = [
      0,
      -5,
      1.5,
      "5",
      "5x",
      "s5",
      "5S",
      "5MS",
      "",
      "5.5.5s",
      Number.MAX_SAFE_INTEGER + 1,
    ];
    for (const input of invalid) {
      assert.throws(() => parseDuration(input), `input ${JSON.stringify(input)} should throw`);
    }
  });

  test("white-box: parseByteSize accepts IEC units case-sensitively and rejects malformed input", () => {
    const valid: Array<[number | string, number]> = [
      [1024, 1024],
      ["1KiB", 1024],
      ["1MiB", 1024 ** 2],
      ["1GiB", 1024 ** 3],
      ["2.5MiB", 2.5 * 1024 ** 2],
    ];
    for (const [input, expected] of valid) {
      assert.equal(parseByteSize(input), expected, `input ${JSON.stringify(input)}`);
    }
    const invalid: Array<number | string> = [0, -1, 1.5, "1kib", "1Kib", "1KIB", "1TiB", "1KB", "", "abc"];
    for (const input of invalid) {
      assert.throws(() => parseByteSize(input), `input ${JSON.stringify(input)} should throw`);
    }
  });

  test("white-box: canonicalJsonStringify is key-order independent and array-order preserving", () => {
    const a = canonicalJsonStringify({ b: 1, a: 2, c: { y: 1, x: 2 } });
    const b = canonicalJsonStringify({ a: 2, c: { x: 2, y: 1 }, b: 1 });
    assert.equal(a, b);
    assert.notEqual(canonicalJsonStringify([1, 2]), canonicalJsonStringify([2, 1]));
    assert.equal(canonicalJsonStringify(null), "null");
    assert.equal(canonicalJsonStringify({}), "{}");
    assert.equal(canonicalJsonStringify([]), "[]");
  });

  test("white-box: sha256Hex produces a real, correct digest (known vector)", () => {
    // echo -n "" | sha256sum
    assert.equal(sha256Hex(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    // echo -n "abc" | sha256sum
    assert.equal(sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

// ===========================================================================
// identity.ts (§4.2)
// ===========================================================================

describe("contracts/identity.ts (§4.2)", () => {
  const base = {
    instanceName: "default",
    configSourcePaths: ["/home/arc/servers.yaml"],
    enabledServers: ["source", "destination"],
    stateDirIdentity: "/home/arc/.local/state/handfree-ssh-mcp/instances/x",
  };

  test("white-box: computeInstanceId is deterministic and order-independent for arrays", () => {
    const a = computeInstanceId(base);
    const b = computeInstanceId({ ...base, enabledServers: ["destination", "source"] });
    assert.equal(a, b, "enabledServers order must not change instanceId");
    assert.match(a, /^[0-9a-f]{64}$/);
  });

  test("white-box: computeInstanceId changes when any identity input changes", () => {
    const a = computeInstanceId(base);
    const variants = [
      { ...base, instanceName: "other" },
      { ...base, configSourcePaths: ["/home/arc/other.yaml"] },
      { ...base, enabledServers: ["source"] },
      { ...base, stateDirIdentity: "/different" },
    ];
    for (const variant of variants) {
      assert.notEqual(computeInstanceId(variant), a, JSON.stringify(variant));
    }
  });

  test("white-box: shortInstanceId enforces the 128-256 bit floor/ceiling and validates the input shape", () => {
    const id = computeInstanceId(base);
    assert.equal(shortInstanceId(id, 32).length, 32);
    assert.equal(shortInstanceId(id, 64).length, 64);
    assert.equal(shortInstanceId(id), id.slice(0, 32), "default is 32 hex chars (128 bit)");
    assert.throws(() => shortInstanceId(id, 31));
    assert.throws(() => shortInstanceId(id, 65));
    assert.throws(() => shortInstanceId("not-a-hash", 32));
    assert.throws(() => shortInstanceId("a".repeat(63), 32), "63 hex chars is not a valid SHA-256 digest");
  });

  test("white-box: computeConfigRevision / computePolicyFingerprint differ for different content and refuse secret-like keys", () => {
    const rev1 = computeConfigRevision({ transferDefaults: { fast: true } });
    const rev2 = computeConfigRevision({ transferDefaults: { fast: false } });
    assert.notEqual(rev1, rev2);
    assert.match(rev1, /^[0-9a-f]{64}$/);

    const pol1 = computePolicyFingerprint({ commandMode: "whitelist", whitelist: ["^pwd$"] });
    const pol2 = computePolicyFingerprint({ commandMode: "whitelist", whitelist: ["^ls$"] });
    assert.notEqual(pol1, pol2);

    for (const secretKey of ["password", "Password", "secret", "apiKey", "api_key", "privateKey", "private_key", "token", "credential", "passphrase"]) {
      assert.throws(() => computeConfigRevision({ [secretKey]: "x" }), `expected refusal for key "${secretKey}"`);
      assert.throws(() => computePolicyFingerprint({ nested: { [secretKey]: "x" } }), `expected refusal for nested key "${secretKey}"`);
    }
  });

  test("white-box: assertNoSecretLikeKeys walks arrays and nested objects", () => {
    assert.doesNotThrow(() => assertNoSecretLikeKeys({ a: [1, 2, { b: "c" }] }));
    assert.throws(() => assertNoSecretLikeKeys([{ inner: { deepSecretValue: "x" } }]));
    assert.doesNotThrow(() => assertNoSecretLikeKeys(null));
    assert.doesNotThrow(() => assertNoSecretLikeKeys("plain string"));
  });
});

// ===========================================================================
// job.ts (§5.5 state machine) — exhaustive over every (from,to,actor) triple
// ===========================================================================

describe("contracts/job.ts (§5.5)", () => {
  // Independently hand-transcribed from §5.5's printed table plus its
  // system-only-transition prose, kept deliberately separate from job.ts's
  // own internal tables so this test can catch a real regression instead of
  // just echoing the implementation back at itself.
  const EXPECTED_API: Record<JobState, JobState[]> = {
    queued: ["preparing", "cancelling", "failed"],
    preparing: ["running", "cancelling", "failed"],
    running: ["verifying", "cancelling", "failed"],
    verifying: ["completed", "cancelling", "failed"],
    cancelling: ["cancelled", "failed"],
    recovering: ["running", "verifying", "completed", "cancelled", "failed", "orphaned"],
    orphaned: ["recovering", "failed"],
    completed: [],
    cancelled: [],
    failed: [],
  };
  const EXPECTED_SYSTEM_ONLY_EXTRA: Partial<Record<JobState, JobState[]>> = {
    preparing: ["recovering"],
    running: ["recovering"],
    verifying: ["recovering"],
    cancelling: ["recovering"],
  };

  test("white-box: every (from, to) pair matches the §5.5 table exactly for the api actor", () => {
    for (const from of JOB_STATES) {
      for (const to of JOB_STATES) {
        const expected = EXPECTED_API[from].includes(to);
        assert.equal(isValidTransition(from, to, "api"), expected, `api: ${from} -> ${to}`);
      }
    }
  });

  test("white-box: every (from, to) pair matches the §5.5 table plus system-only recovery entry for the system actor", () => {
    for (const from of JOB_STATES) {
      for (const to of JOB_STATES) {
        const expected = EXPECTED_API[from].includes(to) || (EXPECTED_SYSTEM_ONLY_EXTRA[from]?.includes(to) ?? false);
        assert.equal(isValidTransition(from, to, "system"), expected, `system: ${from} -> ${to}`);
      }
    }
  });

  test("white-box: queued never reaches recovering even for the system actor (§5.5: no side effects yet, stays queued)", () => {
    assert.equal(isValidTransition("queued", "recovering", "system"), false);
    assert.ok(!allowedTransitions("queued", "system").includes("recovering"));
  });

  test("white-box: terminal states have zero outgoing transitions for either actor", () => {
    for (const state of ["completed", "cancelled", "failed"] as const) {
      assert.deepEqual(allowedTransitions(state, "api"), []);
      assert.deepEqual(allowedTransitions(state, "system"), []);
      assert.equal(isTerminalState(state), true);
    }
    for (const state of JOB_STATES) {
      if (!["completed", "cancelled", "failed"].includes(state)) {
        assert.equal(isTerminalState(state), false, state);
      }
    }
  });

  test("white-box: assertRunIdMatchesJobId (§4.3)", () => {
    assert.doesNotThrow(() => assertRunIdMatchesJobId("run_1", "run_1"));
    assert.throws(() => assertRunIdMatchesJobId("run_1", "run_2"));
  });
});

// ===========================================================================
// transfer-contract.ts (§5.4, §5.7)
// ===========================================================================

describe("contracts/transfer-contract.ts (§5.4 combinations)", () => {
  test("white-box: local-remote topology rejects any provided strategy", () => {
    const result = validateTransferCombination({ topology: "local-remote", strategy: "auto" });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "TRANSFER_STRATEGY_NOT_APPLICABLE");
  });

  test("white-box: local-remote topology with no strategy resolves cleanly", () => {
    const result = validateTransferCombination({ topology: "local-remote" });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.resolvedStrategy, undefined);
      assert.equal(result.resolvedStriped, "off");
    }
  });

  test("white-box: remote-remote + direct + striped:on is rejected", () => {
    const result = validateTransferCombination({ topology: "remote-remote", strategy: "direct", striped: "on" });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "TRANSFER_STRIPED_NOT_APPLICABLE");
  });

  test("white-box: remote-remote + relay + striped:on is accepted (builtin multi-channel relay)", () => {
    const result = validateTransferCombination({ topology: "remote-remote", strategy: "relay", striped: "on" });
    assert.equal(result.ok, true);
  });

  test("white-box: remote-remote with no strategy defaults to auto", () => {
    const result = validateTransferCombination({ topology: "remote-remote" });
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.resolvedStrategy, "auto");
  });

  test("white-box: archive:true + striped:on is always rejected regardless of topology/strategy", () => {
    for (const topology of ["local-remote", "remote-remote"] as const) {
      const result = validateTransferCombination({ topology, archive: true, striped: "on" });
      assert.equal(result.ok, false, topology);
      if (!result.ok) assert.equal(result.code, "TRANSFER_STRIPED_NOT_APPLICABLE");
    }
  });

  test("white-box: archive:true resolves striped:auto down to off, and leaves striped:off alone", () => {
    for (const striped of ["auto", "off", undefined] as const) {
      const result = validateTransferCombination({ topology: "local-remote", archive: true, striped });
      assert.equal(result.ok, true);
      if (result.ok) assert.equal(result.resolvedStriped, "off");
    }
  });
});

describe("contracts/transfer-contract.ts (§5.7 batch upload)", () => {
  test("white-box: basenameOf handles both separators, trailing slashes, and bare names", () => {
    assert.equal(basenameOf("a/b/c.txt"), "c.txt");
    assert.equal(basenameOf("a\\b\\c.txt"), "c.txt");
    assert.equal(basenameOf("C:\\Users\\x\\file.txt"), "file.txt");
    assert.equal(basenameOf("file.txt"), "file.txt");
    assert.equal(basenameOf("a/b/"), "b");
  });

  test("white-box: detectBatchTargetCollisions finds basename collisions across mixed separators and exact duplicates", () => {
    assert.deepEqual(detectBatchTargetCollisions(["a/x.txt", "b/y.txt"]), []);
    const collisions = detectBatchTargetCollisions(["a/config.yaml", "b/config.yaml"]);
    assert.equal(collisions.length, 1);
    assert.equal(collisions[0].basename, "config.yaml");
    assert.deepEqual(collisions[0].paths.sort(), ["a/config.yaml", "b/config.yaml"]);

    const duplicateExact = detectBatchTargetCollisions(["same/path.txt", "same/path.txt"]);
    assert.equal(duplicateExact.length, 1, "exact duplicate path is a degenerate basename collision");

    const mixedSeparators = detectBatchTargetCollisions(["a/x.txt", "b\\x.txt"]);
    assert.equal(mixedSeparators.length, 1, "basename comparison must be separator-agnostic");
  });

  test("white-box: validateBatchUpload — empty, boundary sizes, and collisions", () => {
    assert.deepEqual(validateBatchUpload([]), { ok: false, code: "INVALID_CONFIGURATION", message: (validateBatchUpload([]) as any).message });
    assert.equal((validateBatchUpload([]) as any).ok, false);

    const atLimit = Array.from({ length: MAX_BATCH_UPLOAD_SIZE }, (_, i) => `f${i}.txt`);
    assert.equal(validateBatchUpload(atLimit).ok, true, "exactly 1000 files must be accepted");

    const overLimit = Array.from({ length: MAX_BATCH_UPLOAD_SIZE + 1 }, (_, i) => `f${i}.txt`);
    const overResult = validateBatchUpload(overLimit);
    assert.equal(overResult.ok, false);
    if (!overResult.ok) assert.equal(overResult.code, "BATCH_TOO_LARGE");

    const collisionResult = validateBatchUpload(["a/x.txt", "b/x.txt"]);
    assert.equal(collisionResult.ok, false);
    if (!collisionResult.ok) assert.equal(collisionResult.code, "BATCH_TARGET_COLLISION");

    assert.equal(validateBatchUpload(["only-one.txt"]).ok, true);
  });

  test("white-box: validateArchiveNotCombinedWithBatch (§5.7: archive:true + array => INVALID_CONFIGURATION)", () => {
    const rejected = validateArchiveNotCombinedWithBatch(["a.txt", "b.txt"], true);
    assert.equal(rejected.ok, false);
    if (!rejected.ok) assert.equal(rejected.code, "INVALID_CONFIGURATION");

    assert.equal(validateArchiveNotCombinedWithBatch(["a.txt"], false).ok, true);
    assert.equal(validateArchiveNotCombinedWithBatch(["a.txt"], undefined).ok, true);
    assert.equal(validateArchiveNotCombinedWithBatch("single.txt", true).ok, true, "string localPath is 1.x-compatible, archive still allowed");
  });
});

// ===========================================================================
// run-contract.ts (§5.2 sync placeholder, §5.8 phase pipeline)
// ===========================================================================

describe("contracts/run-contract.ts", () => {
  test("white-box: checkSyncParamSupported — only sync:flush is rejected", () => {
    assert.equal(checkSyncParamSupported(undefined).ok, true);
    assert.equal(checkSyncParamSupported("none").ok, true);
    const flushResult = checkSyncParamSupported("flush");
    assert.equal(flushResult.ok, false);
    if (!flushResult.ok) assert.equal(flushResult.code, "SYNC_NOT_AVAILABLE");
  });

  test("white-box: computeCleanupOrder reverses only phases that actually ran", () => {
    const order = [...WORKSPACE_RUN_PHASE_ORDER];
    assert.deepEqual(
      computeCleanupOrder(order, order.map((phase) => ({ phase, status: "completed" as const }))),
      [...order].reverse(),
    );
    assert.deepEqual(computeCleanupOrder(order, []), [], "nothing ran yet -> nothing to clean up");
    assert.deepEqual(
      computeCleanupOrder(order, [
        { phase: "push", status: "skipped", reason: "push:false" },
        { phase: "preflight", status: "completed" },
        { phase: "launching", status: "completed" },
        { phase: "remote-running", status: "failed", reason: "exit 1" },
        { phase: "collect", status: "skipped", reason: "run failed before producing output" },
      ]),
      ["remote-running", "launching", "preflight"],
      "skipped phases are excluded from cleanup order; failed phases are included",
    );
  });

  test("white-box: findMissingPhaseReports catches a silently-dropped phase", () => {
    const order = [...TRANSFER_PIPELINE_PHASE_ORDER];
    const complete = order.map((phase) => ({ phase, status: "completed" as const }));
    assert.deepEqual(findMissingPhaseReports(order, complete), []);
    const droppedVerify = complete.filter((o) => o.phase !== "verify");
    assert.deepEqual(findMissingPhaseReports(order, droppedVerify), ["verify"]);
  });

  test("white-box: findSkippedPhasesMissingReason requires a non-empty reason on every skip", () => {
    assert.deepEqual(
      findSkippedPhasesMissingReason([
        { phase: "push", status: "skipped", reason: "push:false" },
        { phase: "collect", status: "skipped" },
        { phase: "extract", status: "skipped", reason: "   " },
        { phase: "verify", status: "completed" },
      ]),
      ["collect", "extract"],
    );
  });
});

// ===========================================================================
// sync-placeholder.ts (Phase 3 deferred contracts)
// ===========================================================================

describe("contracts/sync-placeholder.ts (Phase 3 deferred)", () => {
  test("white-box: every deferred sync tool name returns the same stable SYNC_NOT_AVAILABLE shape", () => {
    for (const name of DEFERRED_SYNC_TOOL_NAMES) {
      const error = handleDeferredSyncTool(name);
      assert.equal(error.code, "SYNC_NOT_AVAILABLE");
      assert.equal(error.retryable, false);
      assert.match(error.message, new RegExp(name.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")));
      assert.match(error.message, /Phase 3/);
      assert.doesNotThrow(() => errorObjectSchema.parse(error), "must itself satisfy the §5.2 error object schema");
    }
  });

  test("white-box: modePlanner is explicitly unimplemented, not silently stubbed to a fake decision", () => {
    assert.throws(
      () => modePlanner({ direction: "push", local: "changed", remote: "same", baseExisted: true }),
      new RegExp(MODE_PLANNER_NOT_IMPLEMENTED_REASON.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&").slice(0, 60)),
    );
  });

  test("white-box: every /api/v1/sync/* route is marked deferred and no non-sync route is", () => {
    const seen = new Set<string>();
    for (const route of HTTP_ROUTES) {
      const key = `${route.method} ${route.path}`;
      assert.ok(!seen.has(key), `duplicate route ${key}`);
      seen.add(key);
      const isSyncPath = route.path.startsWith("/api/v1/sync/");
      assert.equal(route.deferred, isSyncPath, key);
      assert.equal(isDeferredRoute(route.method, route.path), route.deferred);
    }
    assert.throws(() => isDeferredRoute("GET", "/api/v1/does-not-exist"));
  });
});

// ===========================================================================
// config-schema.ts (§5.1)
// ===========================================================================

describe("contracts/config-schema.ts (§5.1)", () => {
  test("white-box: expandHomePath only expands a leading bare ~ or ~/ or ~\\", () => {
    assert.equal(expandHomePath("~", "/home/arc"), "/home/arc");
    assert.equal(expandHomePath("~/projects", "/home/arc"), "/home/arc/projects");
    assert.equal(expandHomePath("~\\projects", "C:\\Users\\arc"), "C:\\Users\\arc\\projects");
    assert.equal(expandHomePath("~otheruser/x", "/home/arc"), "~otheruser/x", "not a bare ~ prefix, left untouched");
    assert.equal(expandHomePath("/abs/~notatilde", "/home/arc"), "/abs/~notatilde");
    assert.equal(expandHomePath("relative/path", "/home/arc"), "relative/path");
  });

  test("black-box: an unknown top-level key is rejected (§5.1: unknown key 默认报错)", () => {
    assert.throws(() => parseHandfreeV2Config({ notARealKey: true }));
  });

  test("black-box: an unknown nested key is rejected the same way (.strict() propagates)", () => {
    assert.throws(() => parseHandfreeV2Config({ daemon: { instanceName: "x", bogus: 1 } }));
  });

  test("black-box: runProfiles syncProfile/server/remoteRoot exclusivity (§5.1)", () => {
    assert.throws(
      () => parseHandfreeV2Config({
        runProfiles: { p: { syncProfile: "s", server: "gpu4090", environment: { type: "venv" } } },
      }),
      "syncProfile + server together must fail",
    );
    assert.throws(
      () => parseHandfreeV2Config({ runProfiles: { p: { environment: { type: "venv" } } } }),
      "neither syncProfile nor server/remoteRoot must fail",
    );
    assert.doesNotThrow(() =>
      parseHandfreeV2Config({ runProfiles: { p: { syncProfile: "s", environment: { type: "venv" } } } }),
    );
    assert.doesNotThrow(() =>
      parseHandfreeV2Config({
        runProfiles: { p: { server: "gpu4090", remoteRoot: "/data/x", environment: { type: "venv" } } },
      }),
    );
  });

  test("black-box: syncProfiles direction pull/bidirectional requires remoteScanInterval (§P3-01-A1)", () => {
    const makeProfile = (direction: string, extra: Record<string, unknown> = {}) => ({
      syncProfiles: {
        p: { localRoot: "/local", server: "s", remoteRoot: "/remote", direction, ...extra },
      },
    });
    assert.throws(() => parseHandfreeV2Config(makeProfile("pull")));
    assert.throws(() => parseHandfreeV2Config(makeProfile("bidirectional")));
    assert.doesNotThrow(() => parseHandfreeV2Config(makeProfile("push")), "push does not require remoteScanInterval");
    assert.doesNotThrow(() => parseHandfreeV2Config(makeProfile("pull", { remoteScanInterval: "5m" })));
  });

  test("black-box: delete.propagate incompatible with direction is rejected", () => {
    const makeProfile = (direction: string, propagate: string) => ({
      syncProfiles: {
        p: {
          localRoot: "/local",
          server: "s",
          remoteRoot: "/remote",
          direction,
          remoteScanInterval: "5m",
          delete: { enabled: true, propagate },
        },
      },
    });
    assert.throws(() => parseHandfreeV2Config(makeProfile("push", "pull")));
    assert.throws(() => parseHandfreeV2Config(makeProfile("pull", "push")));
    assert.doesNotThrow(() => parseHandfreeV2Config(makeProfile("bidirectional", "both")));
  });

  test("black-box: directRoutes.hostKey must be a pinned SHA256: fingerprint", () => {
    const makeRoute = (hostKey: string) => ({
      directRoutes: {
        r: {
          sourceServer: "a",
          destinationServer: "b",
          destinationHost: "b.internal",
          destinationUser: "app",
          hostKey,
          credentialMode: "existing-remote-key",
          backends: ["rsync"],
        },
      },
    });
    assert.throws(() => parseHandfreeV2Config(makeRoute("not-pinned")));
    assert.doesNotThrow(() => parseHandfreeV2Config(makeRoute("SHA256:abc123")));
  });

  test("black-box: PLAN.MD §5.1's own documented YAML example parses successfully end to end", () => {
    // Loaded from tests/fixtures/contracts/plan-5-1-example.yaml (a verbatim
    // transcription of PLAN.MD §5.1), shared with scripts/validate-contracts.mjs
    // so both consumers parse the exact same real file rather than two
    // copies that could silently drift apart.
    const yamlText = fs.readFileSync(PLAN_5_1_EXAMPLE_PATH, "utf8");
    const raw = yaml.load(yamlText);
    const { config, warnings } = parseHandfreeV2Config(raw);
    assert.deepEqual(warnings, []);
    assert.equal(config.runProfiles?.["qwen-dev"].syncProfile, "qwen-dev");
    assert.equal(config.syncProfiles?.["qwen-dev"].direction, "bidirectional");
    assert.equal(config.directRoutes?.["source-to-destination"].hostKey, "SHA256:REQUIRED_PIN");
    // Round-trip through the raw schema too, proving handfreeV2ConfigSchema
    // itself (not just the wrapper) accepts the real document.
    assert.doesNotThrow(() => handfreeV2ConfigSchema.parse(raw));
  });
});

// ===========================================================================
// error.ts / envelope.ts
// ===========================================================================

describe("contracts/error.ts + envelope.ts (§5.2)", () => {
  test("white-box: errorObjectSchema rejects a lowercase/invalid machine code", () => {
    assert.doesNotThrow(() => errorObjectSchema.parse({ code: "SOME_CODE", message: "x", retryable: false }));
    assert.throws(() => errorObjectSchema.parse({ code: "some_code", message: "x", retryable: false }));
    assert.throws(() => errorObjectSchema.parse({ code: "1CODE", message: "x", retryable: false }));
  });

  test("white-box: legacyErrorSchema uses retriable (not retryable) — the real 1.x field name", () => {
    assert.doesNotThrow(() => legacyErrorSchema.parse({ code: "SFTP_ERROR", message: "x", retriable: false }));
    assert.throws(() => legacyErrorSchema.parse({ code: "SFTP_ERROR", message: "x", retryable: false } as any));
  });

  test("black-box: envelopeSchema discriminates on ok and matches §5.2's example shape", () => {
    const success = envelopeSchema.parse({
      ok: true,
      jobId: "transfer_20260914_ab12cd34",
      state: "running",
      message: "Transfer started",
      next: "Poll transfer-status",
      details: {},
    });
    assert.equal(success.ok, true);

    const failure = envelopeSchema.parse({
      ok: false,
      error: { code: "SFTP_ERROR", message: "boom", retryable: true },
    });
    assert.equal(failure.ok, false);

    assert.throws(() => envelopeSchema.parse({ ok: true, jobId: "x", state: "not-a-real-state", message: "m" }));
  });
});
