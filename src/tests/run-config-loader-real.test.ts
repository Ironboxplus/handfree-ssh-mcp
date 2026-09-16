import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, test } from "node:test";
import { loadConfigFromYaml } from "../config/config-loader.js";
import { parseRunProfiles } from "../config/run-profiles-loader.js";

// PLAN.MD P2-01: "解析 runProfiles". Real file on real disk, real YAML
// parser, real Zod validation -- no mocked fs, no hand-constructed config
// objects standing in for what the loader actually produces.

describe("P2-01 grey-box: runProfiles YAML config loading (real file, real parser)", () => {
  const suiteRoot = fs.mkdtempSync(path.join(os.tmpdir(), "handfree-run-config-"));

  after(() => {
    fs.rmSync(suiteRoot, { recursive: true, force: true });
  });

  test("a config with no runProfiles key at all yields an empty map -- zero impact on existing 1.x configs", () => {
    const configPath = path.join(suiteRoot, "no-run-profiles.yaml");
    fs.writeFileSync(
      configPath,
      "servers:\n  gpu4090:\n    host: 10.0.0.1\n    username: alice\n    password: secret\n",
      "utf8",
    );
    const loaded = loadConfigFromYaml(configPath);
    assert.deepEqual(loaded.runProfiles, {});
  });

  test("a well-formed runProfiles section parses for real", () => {
    const configPath = path.join(suiteRoot, "with-run-profiles.yaml");
    fs.writeFileSync(
      configPath,
      [
        "servers:",
        "  gpu4090:",
        "    host: 10.0.0.1",
        "    username: alice",
        "    password: secret",
        "runProfiles:",
        "  qwen-dev:",
        "    server: gpu4090",
        "    remoteRoot: /data/arc/qwen",
        "    environment:",
        "      type: venv",
        "      path: /data/arc/venvs/qwen",
        "    allowedEntrypoints:",
        "      - train.py",
        "    env:",
        "      PYTHONUNBUFFERED: '1'",
        "",
      ].join("\n"),
      "utf8",
    );
    const loaded = loadConfigFromYaml(configPath);
    assert.ok(loaded.runProfiles);
    const profile = loaded.runProfiles!["qwen-dev"];
    assert.equal(profile.server, "gpu4090");
    assert.equal(profile.remoteRoot, "/data/arc/qwen");
    assert.equal(profile.environment.type, "venv");
    assert.equal(profile.environment.path, "/data/arc/venvs/qwen");
    assert.deepEqual(profile.allowedEntrypoints, ["train.py"]);
    assert.deepEqual(profile.env, { PYTHONUNBUFFERED: "1" });
  });

  test("a malformed runProfiles section (missing required environment.type) fails config load, not a silent partial parse", () => {
    const configPath = path.join(suiteRoot, "bad-run-profiles.yaml");
    fs.writeFileSync(
      configPath,
      [
        "servers:",
        "  gpu4090:",
        "    host: 10.0.0.1",
        "    username: alice",
        "    password: secret",
        "runProfiles:",
        "  broken:",
        "    server: gpu4090",
        "    remoteRoot: /data",
        "    environment: {}",
        "",
      ].join("\n"),
      "utf8",
    );
    assert.throws(() => loadConfigFromYaml(configPath));
  });

  test("syncProfile set together with server/remoteRoot is rejected (they must be derived, not duplicated)", () => {
    assert.throws(() =>
      parseRunProfiles({
        bad: {
          syncProfile: "x",
          server: "gpu4090",
          remoteRoot: "/data",
          environment: { type: "executable" },
        },
      }),
    );
  });

  test("environment.type accepts the full declared enum at parse time (conda/module/slurm parse OK even though launch rejects them)", () => {
    for (const type of ["venv", "conda", "module", "slurm", "executable"]) {
      const parsed = parseRunProfiles({
        p: { server: "s", remoteRoot: "/r", environment: { type } },
      });
      assert.equal(parsed.p.environment.type, type);
    }
  });

  // PLAN.MD P2-02/P2-06 (this round): push.paths and the richer collect
  // shape (localDir/maxBytes/maxFiles) are NOT on the frozen
  // src/contracts/config-schema.ts runProfileSchema -- parseRunProfiles
  // strips and validates them separately (see run-profiles-loader.ts's
  // module doc comment). These real-YAML tests prove that split actually
  // round-trips correctly, not just that the two halves compile.

  test("push.paths and the richer collect shape parse for real, from real YAML", () => {
    const configPath = path.join(suiteRoot, "with-push-collect.yaml");
    fs.writeFileSync(
      configPath,
      [
        "servers:",
        "  gpu4090:",
        "    host: 10.0.0.1",
        "    username: alice",
        "    password: secret",
        "runProfiles:",
        "  qwen-dev:",
        "    server: gpu4090",
        "    remoteRoot: /data/arc/qwen",
        "    environment:",
        "      type: venv",
        "      path: /data/arc/venvs/qwen",
        "    allowedEntrypoints:",
        "      - train.py",
        "    push:",
        "      paths:",
        "        - E:/projects/qwen",
        "        - E:/projects/shared-config.yaml",
        "    collect:",
        "      paths:",
        "        - outputs/*.json",
        "      localDir: E:/collected/qwen",
        "      maxBytes: 104857600",
        "      maxFiles: 200",
        "",
      ].join("\n"),
      "utf8",
    );
    const loaded = loadConfigFromYaml(configPath);
    const profile = loaded.runProfiles!["qwen-dev"];
    assert.deepEqual(profile.push, { paths: ["E:/projects/qwen", "E:/projects/shared-config.yaml"] });
    assert.deepEqual(profile.collect, { paths: ["outputs/*.json"], localDir: "E:/collected/qwen", maxBytes: 104857600, maxFiles: 200 });
    // The rest of the entry still parses exactly as before -- push/collect
    // were stripped and re-attached, not left to corrupt the base parse.
    assert.equal(profile.server, "gpu4090");
    assert.equal(profile.environment.type, "venv");
  });

  test("a profile with no push/collect keys at all still parses -- both are optional", () => {
    const parsed = parseRunProfiles({
      p: { server: "s", remoteRoot: "/r", environment: { type: "executable" }, executable: "/bin/true" },
    });
    assert.equal(parsed.p.push, undefined);
    assert.equal(parsed.p.collect, undefined);
  });

  test("push.paths must be non-empty when the push key is present at all", () => {
    assert.throws(() =>
      parseRunProfiles({
        p: { server: "s", remoteRoot: "/r", environment: { type: "executable" }, executable: "/bin/true", push: { paths: [] } },
      }),
    );
  });

  test("an unknown key inside push is rejected (push schema is strict, matching the frozen profile schema's own strictness)", () => {
    assert.throws(() =>
      parseRunProfiles({
        p: {
          server: "s",
          remoteRoot: "/r",
          environment: { type: "executable" },
          executable: "/bin/true",
          push: { paths: ["/x"], extraUnknownField: true },
        },
      }),
    );
  });

  test("collect.paths alone (no localDir/caps) still parses -- localDir is only required at launch time when paths is non-empty", () => {
    const parsed = parseRunProfiles({
      p: {
        server: "s",
        remoteRoot: "/r",
        environment: { type: "executable" },
        executable: "/bin/true",
        collect: { paths: ["out/*.txt"] },
      },
    });
    assert.deepEqual(parsed.p.collect, { paths: ["out/*.txt"] });
  });
});
