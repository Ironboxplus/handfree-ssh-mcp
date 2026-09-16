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
});
