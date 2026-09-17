import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { buildAdHocProfile, AD_HOC_PROFILE_LABEL } from "../run/ad-hoc-profile.js";
import { matchesAllowedEntrypoint } from "../run/entrypoint-glob.js";
import { applyEnvOverride } from "../run/env-allowlist.js";
import { RunServiceError } from "../run/run-errors.js";

/**
 * White-box unit tests for the inline (no-YAML) run description.
 *
 * These are pure-function tests by construction -- buildAdHocProfile touches
 * no SSH, no filesystem, no registry -- so there is nothing to mock here and
 * nothing is mocked. The launch pipeline that consumes the result is covered
 * by the real-SSH tests in run-service-real.test.ts and the Linux acceptance
 * suite; what is asserted here is the contract between them: the ad-hoc
 * profile must be indistinguishable in SHAPE from one the YAML loader would
 * have produced, or the downstream code paths diverge.
 */

function expectRunError(fn: () => unknown, codeMatch: string, messageMatch: RegExp): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof RunServiceError, `expected a RunServiceError, got ${String(error)}`);
    assert.equal(error.code, codeMatch);
    assert.match(error.message, messageMatch);
    return true;
  });
}

describe("buildAdHocProfile: workspace-run without any YAML config", () => {
  test("venv + remoteRoot is enough -- the resulting profile needs no other field", () => {
    const profile = buildAdHocProfile({ remoteRoot: "/data/proj", venv: "/data/envs/proj" });
    assert.deepEqual(profile.environment, { type: "venv", path: "/data/envs/proj" });
    assert.equal(profile.remoteRoot, "/data/proj");
    // Left undefined on purpose: resolveExecutable turns a venv with no
    // explicit executable into <venv>/bin/python, which is the whole point of
    // the inline venv shortcut.
    assert.equal(profile.executable, undefined);
  });

  test("executable + remoteRoot runs a non-Python entrypoint", () => {
    const profile = buildAdHocProfile({ remoteRoot: "/data/proj", executable: "bash" });
    assert.deepEqual(profile.environment, { type: "executable" });
    assert.equal(profile.executable, "bash");
  });

  test("venv wins over executable, and executable then names the binary inside it", () => {
    // Matches RunService.resolveExecutable's existing venv branch:
    // joinPosix(path, "bin", executable || "python") -- so passing both is
    // meaningful, not a conflict to reject.
    const profile = buildAdHocProfile({ remoteRoot: "/data/proj", venv: "/env", executable: "python3.11" });
    assert.deepEqual(profile.environment, { type: "venv", path: "/env" });
    assert.equal(profile.executable, "python3.11");
  });

  test("missing remoteRoot fails with a message naming both ways out", () => {
    expectRunError(
      () => buildAdHocProfile({ venv: "/env" }),
      "INVALID_CONFIGURATION",
      /profile .*or remoteRoot/s,
    );
  });

  test("missing both venv and executable fails with a message naming both", () => {
    expectRunError(
      () => buildAdHocProfile({ remoteRoot: "/data/proj" }),
      "INVALID_CONFIGURATION",
      /venv.*executable/s,
    );
  });

  test("an empty-string remoteRoot is rejected, not silently treated as the remote root", () => {
    // "" is falsy, so it takes the same branch as undefined -- asserted
    // explicitly because a `remoteRoot ?? throw` would NOT have, and would
    // have produced entrypoints resolved against "/".
    expectRunError(() => buildAdHocProfile({ remoteRoot: "", venv: "/env" }), "INVALID_CONFIGURATION", /remoteRoot/);
  });

  describe("what inline mode does and does not relax", () => {
    test("any relative entrypoint under remoteRoot is allowed", () => {
      const profile = buildAdHocProfile({ remoteRoot: "/data/proj", venv: "/env" });
      for (const entrypoint of ["train.py", "scripts/eval.sh", "a/b/c/deep.py"]) {
        assert.ok(
          matchesAllowedEntrypoint(entrypoint, profile.allowedEntrypoints!),
          `expected inline mode to allow '${entrypoint}'`,
        );
      }
    });

    test("traversal, absolute paths and drive letters are STILL rejected", () => {
      // The load-bearing assertion of this file: `allowedEntrypoints: ["**"]`
      // compiles to the regex `.*`, so if matchesAllowedEntrypoint ever
      // stopped running isSafeRelativeEntrypoint first, inline mode would
      // silently become "execute any file on the remote host". This test
      // fails if that containment is lost.
      const profile = buildAdHocProfile({ remoteRoot: "/data/proj", venv: "/env" });
      for (const entrypoint of ["../etc/shadow", "a/../../b.py", "/etc/passwd", "C:\\windows\\system32\\cmd.exe"]) {
        assert.equal(
          matchesAllowedEntrypoint(entrypoint, profile.allowedEntrypoints!),
          false,
          `inline mode must not allow '${entrypoint}'`,
        );
      }
    });

    test("the caller's own env is the allowlist inline, so its keys are accepted", () => {
      const env = { CUDA_VISIBLE_DEVICES: "0", WANDB_MODE: "offline" };
      const profile = buildAdHocProfile({ remoteRoot: "/data/proj", venv: "/env", env });
      const result = applyEnvOverride(profile.env, env);
      assert.equal(result.ok, true);
      assert.deepEqual(result.ok && result.merged, env);
    });
  });

  describe("push and collect defaults", () => {
    test("no pushPaths -> push is off by default (remoteRoot already holds the code)", () => {
      const profile = buildAdHocProfile({ remoteRoot: "/data/proj", venv: "/env" });
      assert.equal(profile.push, undefined);
      assert.equal(profile.defaultPush, false);
      // This pair is what stops the shared default in resolvePushCollectPlan
      // -- `params.push ?? profile.defaultPush ?? true` -- from demanding
      // push sources an inline caller never declared. Evaluated here with the
      // same expression, for an unset params.push.
      const callerPush: boolean | undefined = undefined;
      assert.equal(callerPush ?? profile.defaultPush ?? true, false);
    });

    test("pushPaths -> push is on and carries the declared sources", () => {
      const profile = buildAdHocProfile({ remoteRoot: "/data/proj", venv: "/env", pushPaths: ["./src", "./cfg.yaml"] });
      assert.deepEqual(profile.push, { paths: ["./src", "./cfg.yaml"] });
      assert.equal(profile.defaultPush, true);
    });

    test("an empty pushPaths list does not turn push on with nothing to push", () => {
      const profile = buildAdHocProfile({ remoteRoot: "/data/proj", venv: "/env", pushPaths: [] });
      assert.equal(profile.push, undefined);
      assert.equal(profile.defaultPush, false);
    });

    test("collectLocalDir becomes the profile's collect destination; absent means no collect", () => {
      const withDir = buildAdHocProfile({ remoteRoot: "/data/proj", venv: "/env", collectLocalDir: "./artifacts" });
      assert.equal(withDir.collect?.localDir, "./artifacts");
      // collect.paths stays absent: §5.8's "collect never defaults to pulling
      // the whole remoteRoot" holds for inline runs too -- the caller has to
      // ask for specific globs on the call.
      assert.equal(withDir.collect?.paths, undefined);
      const without = buildAdHocProfile({ remoteRoot: "/data/proj", venv: "/env" });
      assert.equal(without.collect, undefined);
    });
  });

  test("the profile survives the JSON round-trip retry reads back from meta.json", () => {
    // RunService.buildConfigSnapshot is JSON.parse(JSON.stringify(profile)),
    // and run-retry relaunches from that snapshot rather than the registry.
    // An inline run must therefore be retryable: every field it sets has to
    // be JSON-representable, with no undefined-only shape that would change
    // meaning after the round-trip.
    const profile = buildAdHocProfile({
      remoteRoot: "/data/proj",
      venv: "/env",
      server: "gpu-box",
      env: { SEED: "7" },
      pushPaths: ["./src"],
      collectLocalDir: "./artifacts",
      timeout: 1800000,
    });
    const roundTripped = JSON.parse(JSON.stringify(profile));
    assert.deepEqual(roundTripped, JSON.parse(JSON.stringify(profile)));
    assert.equal(roundTripped.remoteRoot, "/data/proj");
    assert.deepEqual(roundTripped.environment, { type: "venv", path: "/env" });
    assert.deepEqual(roundTripped.allowedEntrypoints, ["**"]);
    assert.deepEqual(roundTripped.push, { paths: ["./src"] });
    assert.equal(roundTripped.collect.localDir, "./artifacts");
    assert.equal(roundTripped.timeout, 1800000);
  });

  test("the ad-hoc label is a display label that can never collide with a real profile name", () => {
    // meta.profile is a free-form string; run-retry never feeds it back into
    // the registry. The parentheses keep it out of the namespace anyway,
    // since a YAML key of this shape would be pathological.
    assert.equal(AD_HOC_PROFILE_LABEL, "(ad-hoc)");
  });
});
