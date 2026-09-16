import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, test } from "node:test";
import { SSHConnectionManager } from "../services/ssh-connection-manager.js";
import { RunProfileRegistry } from "../run/run-profile-registry.js";
import { RunService } from "../run/run-service.js";
import { RunServiceError } from "../run/run-errors.js";
import { RealSshTestServer } from "./helpers/real-ssh-server.js";

// PLAN.MD P2-04: run-retry reads the ORIGINAL run's own recorded config
// snapshot over real SFTP (hand-seeded meta.json fixtures, same technique
// run-service-real.test.ts already uses) rather than the live
// RunProfileRegistry. A genuine successful retry-and-relaunch needs real
// Linux bash semantics (Linux-pending, same as every other successful
// launch path in this project); what IS fully real-testable on this dev box
// is retry()'s own snapshot loading/validation, and -- critically -- that it
// actually USES the snapshot instead of a live, differently-configured
// profile of the same name (proven below by a real, deterministic SFTP
// mkdir failure that could only happen if the snapshot's push config was
// the one actually used).

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value), "utf8");
}

const identity = { bootId: "boot-1", pid: 4242, pgid: 4242, startTicks: "998877", wrapperToken: "token-abc" };

describe("P2-04 grey-box: RunService.retry() against a real ssh2/SFTP server", { concurrency: false }, () => {
  const manager = SSHConnectionManager.getInstance();
  const registry = RunProfileRegistry.getInstance();
  const runService = RunService.getInstance();
  const suiteRoot = fs.mkdtempSync(path.join(os.tmpdir(), "handfree-run-retry-"));
  const remoteServerRoot = path.join(suiteRoot, "remote-server");
  const server = new RealSshTestServer(remoteServerRoot);
  const runsRoot = path.join(remoteServerRoot, ".handfree-runs");

  before(async () => {
    await server.start();
    manager.setConfig(
      {
        remote: {
          host: "127.0.0.1",
          port: server.port,
          username: "test",
          password: "test",
          disableSftpPathPolicy: true,
          keepaliveInterval: 0,
        },
      },
      ["remote"],
    );
  });

  after(async () => {
    manager.disconnect();
    await server.stop();
    fs.rmSync(suiteRoot, { recursive: true, force: true });
    manager.setConfig({}, undefined);
    registry.setProfiles({});
  });

  test("a run launched before this delivery round (no configSnapshot) -> RETRY_SNAPSHOT_UNAVAILABLE", async () => {
    const runId = "run_20260915T120000Z_e0000001";
    writeJson(path.join(runsRoot, runId, "meta.json"), {
      runId, profile: "qwen-dev", server: "remote", remoteRoot: "/data/proj", workdir: "/data/proj",
      executable: "/data/venv/bin/python", entrypoint: "/data/proj/train.py", args: [], env: {},
      createdAt: new Date().toISOString(),
      identity,
    });
    await assert.rejects(
      () => runService.retry("remote", runId),
      (error: unknown) => error instanceof RunServiceError && error.code === "RETRY_SNAPSHOT_UNAVAILABLE",
    );
  });

  test("a snapshot declaring secretEnv -> SECRET_REQUIRED (not re-resolvable this round)", async () => {
    const runId = "run_20260915T120000Z_e0000002";
    writeJson(path.join(runsRoot, runId, "meta.json"), {
      runId, profile: "qwen-dev", server: "remote", remoteRoot: "/data/proj", workdir: "/data/proj",
      executable: "/data/venv/bin/python", entrypoint: "/data/proj/train.py", args: [], env: {},
      createdAt: new Date().toISOString(),
      identity,
      entrypointRelative: "train.py",
      configRevision: "deadbeef",
      configSnapshot: {
        server: "remote",
        remoteRoot: "/data/proj",
        environment: { type: "executable" },
        executable: "/bin/true",
        allowedEntrypoints: ["train.py"],
        secretEnv: { HF_TOKEN: { provider: "process-env", key: "HF_TOKEN" } },
      },
    });
    await assert.rejects(
      () => runService.retry("remote", runId),
      (error: unknown) => error instanceof RunServiceError && error.code === "SECRET_REQUIRED",
    );
  });

  test("retry uses the STORED snapshot's push config, not a live re-registered profile of the same name", async () => {
    const runId = "run_20260915T120000Z_e0000003";
    // The snapshot's remoteRoot is deliberately a path that will fail a real
    // SFTP MKDIR (a file already sits there) -- see run-push-collect-real
    // .test.ts for the same technique. If retry() ever reads the LIVE
    // registry profile below instead, remoteRoot would be a perfectly
    // writable path and push would succeed, then fail later with an
    // unrelated (exec-shaped) error instead of RUN_PUSH_FAILED.
    fs.mkdirSync(remoteServerRoot, { recursive: true });
    const blockedRemoteRoot = "/retry-blocked-dest";
    fs.writeFileSync(path.join(remoteServerRoot, "retry-blocked-dest"), "blocking file");

    const localDir = fs.mkdtempSync(path.join(os.tmpdir(), "handfree-retry-push-src-"));
    fs.writeFileSync(path.join(localDir, "train.py"), "print('retry')\n");

    writeJson(path.join(runsRoot, runId, "meta.json"), {
      runId, profile: "qwen-dev", server: "remote", remoteRoot: blockedRemoteRoot, workdir: blockedRemoteRoot,
      executable: "/bin/true", entrypoint: `${blockedRemoteRoot}/train.py`, args: [], env: {},
      createdAt: new Date().toISOString(),
      identity,
      entrypointRelative: "train.py",
      configRevision: "deadbeef",
      configSnapshot: {
        server: "remote",
        remoteRoot: blockedRemoteRoot,
        environment: { type: "executable" },
        executable: "/bin/true",
        allowedEntrypoints: ["train.py"],
        push: { paths: [localDir] },
      },
    });

    // A LIVE profile of the same name, with a perfectly-writable remoteRoot
    // -- retry() must NOT fall back to this.
    registry.setProfiles({
      "qwen-dev": {
        server: "remote",
        remoteRoot: "/perfectly-writable-live-root",
        environment: { type: "executable" },
        executable: "/bin/true",
        allowedEntrypoints: ["train.py"],
        push: { paths: [localDir] },
      },
    } as any);

    await assert.rejects(
      () => runService.retry("remote", runId),
      (error: unknown) => error instanceof RunServiceError && error.code === "RUN_PUSH_FAILED",
    );

    // Proof the snapshot's (blocked) root was really the one attempted, and
    // the live profile's writable root was never touched.
    assert.equal(fs.existsSync(path.join(remoteServerRoot, "perfectly-writable-live-root")), false);

    fs.rmSync(localDir, { recursive: true, force: true });
    registry.setProfiles({});
  });

  test("retry() with an explicit push:false still requires push.paths from the snapshot's OWN profile.push guard -- proving push:false really reaches resolvePushCollectPlan with the snapshot, not a thrown-together default profile", async () => {
    const runId = "run_20260915T120000Z_e0000005";
    writeJson(path.join(runsRoot, runId, "meta.json"), {
      runId, profile: "qwen-dev", server: "remote", remoteRoot: "/data/proj-retry5", workdir: "/data/proj-retry5",
      executable: "/bin/true", entrypoint: "/data/proj-retry5/train.py", args: [], env: {},
      createdAt: new Date().toISOString(),
      identity,
      entrypointRelative: "train.py",
      configRevision: "deadbeef",
      configSnapshot: {
        server: "remote",
        remoteRoot: "/data/proj-retry5",
        environment: { type: "executable" },
        executable: "/bin/true",
        allowedEntrypoints: ["train.py"],
      },
    });

    // push:false skips the push-config-required check entirely and moves on
    // to computeEntrypointRevision, which fails for real (ENTRYPOINT_NOT_FOUND)
    // since nothing was ever pushed to /data/proj-retry5 on the fake remote --
    // proving push:false really took effect against the snapshot's profile.
    await assert.rejects(
      () => runService.retry("remote", runId, false),
      (error: unknown) => error instanceof RunServiceError && error.code === "ENTRYPOINT_NOT_FOUND",
    );
  });
});
