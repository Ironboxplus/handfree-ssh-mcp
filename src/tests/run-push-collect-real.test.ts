import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, test } from "node:test";
import { SSHConnectionManager } from "../services/ssh-connection-manager.js";
import { RunProfileRegistry } from "../run/run-profile-registry.js";
import { RunService } from "../run/run-service.js";
import { RunServiceError } from "../run/run-errors.js";
import { findRemoteCollectFiles, type CollectMatch } from "../run/collect-glob.js";
import { statRemoteFile } from "../run/remote-sftp.js";
import { RealSshTestServer } from "./helpers/real-ssh-server.js";

// PLAN.MD P2-02/P2-06: real ssh2 server, real SFTP, real files, real
// `md5sum` exec -- no mocks. Covers the pieces of the push/collect phases
// that do NOT require genuine Linux process semantics (real bash wrapper
// execution is Linux-only and stays covered by
// run-acceptance-linux-pending.test.ts, same convention as the rest of
// Phase 2). runPush/computeEntrypointRevision/runCollect are RunService
// private methods; calling them directly via `(runService as any)` exercises
// the real orchestration this dispatch added without needing a full launch.

function sha256File(filePath: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

describe("P2-02/P2-06 grey-box: push/collect against a real ssh2/SFTP server", { concurrency: false }, () => {
  const manager = SSHConnectionManager.getInstance();
  const registry = RunProfileRegistry.getInstance();
  const runService = RunService.getInstance() as any;
  const suiteRoot = fs.mkdtempSync(path.join(os.tmpdir(), "handfree-push-collect-"));
  const remoteServerRoot = path.join(suiteRoot, "remote-server");
  const server = new RealSshTestServer(remoteServerRoot);
  const localRoot = path.join(suiteRoot, "local");

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
    fs.mkdirSync(localRoot, { recursive: true });
  });

  after(async () => {
    manager.disconnect();
    await server.stop();
    fs.rmSync(suiteRoot, { recursive: true, force: true });
    manager.setConfig({}, undefined);
    registry.setProfiles({});
  });

  describe("findRemoteCollectFiles / statRemoteFile (real SFTP readdir/stat)", () => {
    const remoteRoot = "/collect-src";

    before(() => {
      const abs = (...p: string[]) => path.join(remoteServerRoot, "collect-src", ...p);
      fs.mkdirSync(abs("outputs", "nested"), { recursive: true });
      fs.mkdirSync(abs("logs"), { recursive: true });
      fs.writeFileSync(abs("outputs", "a.json"), "a-content");
      fs.writeFileSync(abs("outputs", "b.txt"), "not-matched");
      fs.writeFileSync(abs("outputs", "nested", "c.json"), "nested-content-longer");
      fs.writeFileSync(abs("logs", "run.log"), "log line\n");
    });

    test("matches nested globs, excludes non-matching files, and reports real byte sizes", async () => {
      const matches = await findRemoteCollectFiles("remote", remoteRoot, ["outputs/*.json", "outputs/**/*.json"]);
      const byPath = new Map(matches.map((m) => [m.relativePath, m]));
      assert.equal(byPath.size, 2);
      assert.ok(byPath.has("outputs/a.json"));
      assert.ok(byPath.has("outputs/nested/c.json"));
      assert.equal(byPath.get("outputs/a.json")!.bytes, Buffer.byteLength("a-content"));
      assert.equal(byPath.get("outputs/nested/c.json")!.bytes, Buffer.byteLength("nested-content-longer"));
      assert.equal(byPath.has("outputs/b.txt"), false);
      assert.equal(byPath.has("logs/run.log"), false);
    });

    test("a symlink under the tree is never traversed/collected, even when it would otherwise match", async () => {
      const linkPath = path.join(remoteServerRoot, "collect-src", "outputs", "escape-link.json");
      const targetOutsideRoot = path.join(remoteServerRoot, "outside-secret.json");
      fs.writeFileSync(targetOutsideRoot, "outside-content");
      let symlinkSupported = true;
      try {
        fs.symlinkSync(targetOutsideRoot, linkPath, "file");
      } catch (error) {
        symlinkSupported = false;
        console.warn(`[skip] symlink creation not permitted on this host: ${(error as Error).message}`);
      }
      if (!symlinkSupported) return;

      const matches = await findRemoteCollectFiles("remote", remoteRoot, ["outputs/*.json", "outputs/**/*.json"]);
      assert.equal(matches.some((m) => m.relativePath.includes("escape-link")), false);
    });

    test("statRemoteFile: real size for an existing file, null for a missing one, isFile:false for a directory", async () => {
      const fileStat = await statRemoteFile("remote", `${remoteRoot}/outputs/a.json`);
      assert.deepEqual(fileStat, { size: Buffer.byteLength("a-content"), isFile: true });

      const missing = await statRemoteFile("remote", `${remoteRoot}/outputs/does-not-exist.json`);
      assert.equal(missing, null);

      const dirStat = await statRemoteFile("remote", `${remoteRoot}/outputs`);
      assert.equal(dirStat?.isFile, false);
    });
  });

  describe("RunService.runPush + computeEntrypointRevision (private methods, real upload + real md5sum exec)", () => {
    test("pushes a file and a directory for real; a pushed directory's CONTENTS land directly under remoteRoot (flattened, not nested under the local directory's own name); bytes on the fake remote disk match local content", async () => {
      const singleFile = path.join(localRoot, "single.py");
      fs.writeFileSync(singleFile, "print('single')\n");
      const dir = path.join(localRoot, "project");
      fs.mkdirSync(path.join(dir, "sub"), { recursive: true });
      fs.writeFileSync(path.join(dir, "train.py"), "print('train')\n");
      fs.writeFileSync(path.join(dir, "sub", "util.py"), "print('util')\n");

      const remoteRoot = "/pushed-real";
      const pushed: string[] = await runService.runPush("remote", remoteRoot, { paths: [singleFile, dir] });

      assert.ok(pushed.includes("/pushed-real/single.py"));
      // Flattened: remoteRoot IS the pushed project root, so 'project's own
      // contents land at remoteRoot/train.py and remoteRoot/sub/util.py, not
      // remoteRoot/project/train.py -- this matters because `entrypoint` is
      // always resolved relative to remoteRoot itself, not to some
      // per-source subfolder.
      assert.ok(pushed.includes("/pushed-real/train.py"));
      assert.ok(pushed.includes("/pushed-real/sub/util.py"));

      // Grey-box: the bytes really landed on the fake remote's own disk, not
      // just in the caller's bookkeeping.
      assert.equal(
        fs.readFileSync(path.join(remoteServerRoot, "pushed-real", "single.py"), "utf8"),
        "print('single')\n",
      );
      assert.equal(
        fs.readFileSync(path.join(remoteServerRoot, "pushed-real", "sub", "util.py"), "utf8"),
        "print('util')\n",
      );
    });

    test("computeEntrypointRevision: real md5sum over the real pushed bytes, matching an independently-computed local hash", async () => {
      const entrypoint = path.join(localRoot, "revision-entry.py");
      const content = "print('revision test')\n";
      fs.writeFileSync(entrypoint, content);
      const remoteRoot = "/revision-real";
      const pushed: string[] = await runService.runPush("remote", remoteRoot, { paths: [entrypoint] });
      const entrypointAbsolute = "/revision-real/revision-entry.py";

      const revision = await runService.computeEntrypointRevision("remote", entrypointAbsolute, pushed);

      const expectedMd5 = crypto.createHash("md5").update(content).digest("hex");
      assert.equal(revision.entrypointHash, expectedMd5);
      assert.equal(revision.entrypointBytes, Buffer.byteLength(content));
      assert.equal(typeof revision.pushedFilesDigest, "string");
    });

    test("computeEntrypointRevision: missing remote entrypoint -> ENTRYPOINT_NOT_FOUND, no md5sum attempted", async () => {
      await assert.rejects(
        () => runService.computeEntrypointRevision("remote", "/revision-real/does-not-exist.py", []),
        (error: unknown) => error instanceof RunServiceError && error.code === "ENTRYPOINT_NOT_FOUND",
      );
    });

    test("a missing local push source fails with RUN_PUSH_FAILED naming that exact source, before any remote I/O", async () => {
      const missingLocal = path.join(localRoot, "does-not-exist-locally.py");
      await assert.rejects(
        () => runService.runPush("remote", "/should-not-be-created", { paths: [missingLocal] }),
        (error: unknown) => error instanceof RunServiceError && error.code === "RUN_PUSH_FAILED" && error.message.includes(missingLocal) && error.message.includes("phase: push"),
      );
      assert.equal(fs.existsSync(path.join(remoteServerRoot, "should-not-be-created")), false);
    });

    test("a real remote-side mkdir failure (a file already occupies the destination path) fails with RUN_PUSH_FAILED naming the directory", async () => {
      // Create a real FILE at the exact path push would need to mkdir as a
      // directory -- a genuine, deterministic, cross-platform SFTP MKDIR
      // failure (ENOTDIR/EEXIST), not a simulated one.
      const blockedRemoteRoot = "/blocked-dest";
      fs.mkdirSync(remoteServerRoot, { recursive: true });
      fs.writeFileSync(path.join(remoteServerRoot, "blocked-dest"), "i am a file, not a directory");

      const dir = path.join(localRoot, "project2");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "x.py"), "print('x')\n");

      await assert.rejects(
        () => runService.runPush("remote", blockedRemoteRoot, { paths: [dir] }),
        (error: unknown) => error instanceof RunServiceError && error.code === "RUN_PUSH_FAILED" && error.message.includes(dir) && error.message.includes("phase: push"),
      );
    });

    // Reviewer-added. The two tests above cover the paths where the failure
    // ARRIVES AS A THROW (local stat failure; uploadDirectory throwing via
    // runBoundedTransfers). They do not cover the third and structurally
    // different path: uploadBatch does NOT throw when an individual file
    // fails -- it returns a per-file result array with status "failed", and
    // runPush has to inspect that array and raise RUN_PUSH_FAILED itself.
    //
    // Found by mutation: deleting that inspection (so a per-file push failure
    // was silently ignored and the launch proceeded) left the entire suite
    // green. That is PLAN.MD P2-02's hardest constraint -- "push 失败绝不进入
    // preflight/launching" -- passing vacuously for the most common failure
    // shape, a single bad file among several.
    test("a per-file batch upload failure is raised as RUN_PUSH_FAILED even though uploadBatch itself does not throw", async () => {
      const remoteRoot = "/push-perfile-fail";
      const good = path.join(localRoot, "good_one.py");
      const doomed = path.join(localRoot, "doomed_one.py");
      fs.writeFileSync(good, "print('good')\n");
      fs.writeFileSync(doomed, "print('doomed')\n");

      // Occupy the doomed file's exact destination with a real DIRECTORY, so
      // the real SFTP server's real fs.open(path, 'w') genuinely returns
      // EISDIR for that one file while the other uploads fine. Real OS
      // rejection through the real SFTP protocol, not a stub.
      fs.mkdirSync(path.join(remoteServerRoot, "push-perfile-fail", "doomed_one.py"), { recursive: true });

      await assert.rejects(
        () => runService.runPush("remote", remoteRoot, { paths: [good, doomed] }),
        (error: unknown) =>
          error instanceof RunServiceError &&
          error.code === "RUN_PUSH_FAILED" &&
          error.message.includes("doomed_one.py") &&
          error.message.includes("phase: push"),
      );

      // Sanity: the failure really came from the per-file result path, i.e.
      // the healthy sibling did land. If this were a whole-batch throw the
      // good file would be absent and this test would be proving something
      // else entirely.
      assert.equal(
        fs.readFileSync(path.join(remoteServerRoot, "push-perfile-fail", "good_one.py"), "utf8"),
        "print('good')\n",
      );
    });
  });

  describe("RunService.runCollect (private method, real download, no silent truncation)", () => {
    const remoteRoot = "/collect-dl-src";

    before(() => {
      const abs = (...p: string[]) => path.join(remoteServerRoot, "collect-dl-src", ...p);
      fs.mkdirSync(abs("out"), { recursive: true });
      fs.writeFileSync(abs("out", "a.json"), "a".repeat(30));
      fs.writeFileSync(abs("out", "b.json"), "b".repeat(30));
      fs.writeFileSync(abs("out", "c.json"), "c".repeat(30));
      fs.writeFileSync(abs("out", "ignored.txt"), "not collected");
    });

    test("downloads real matched files with byte-identical content; unmatched files are never pulled", async () => {
      const localDir = path.join(suiteRoot, "collected-ok");
      const result = await runService.runCollect("remote", remoteRoot, localDir, ["out/*.json"], 10_000, 100);

      assert.equal(result.status, "completed");
      assert.equal(result.files.length, 3);
      for (const relative of ["a.json", "b.json", "c.json"]) {
        const local = path.join(localDir, "out", relative);
        const remoteReal = path.join(remoteServerRoot, "collect-dl-src", "out", relative);
        assert.equal(fs.existsSync(local), true);
        assert.equal(sha256File(local), sha256File(remoteReal));
      }
      assert.equal(fs.existsSync(path.join(localDir, "out", "ignored.txt")), false);
    });

    test("exceeding maxBytes stops collecting, reports an accurate already-pulled list, and does not silently truncate", async () => {
      const localDir = path.join(suiteRoot, "collected-bytecap");
      // Each file is 30 bytes; cap at 45 bytes allows exactly one full file
      // (alphabetical: a.json) before the second would exceed it.
      const result = await runService.runCollect("remote", remoteRoot, localDir, ["out/*.json"], 45, 100);

      assert.equal(result.status, "failed");
      assert.match(result.reason ?? "", /maxBytes/);
      assert.equal(result.files.length, 1);
      assert.equal(result.files[0].remotePath, `${remoteRoot}/out/a.json`);
      assert.equal(fs.existsSync(path.join(localDir, "out", "a.json")), true);
      assert.equal(fs.existsSync(path.join(localDir, "out", "b.json")), false);
      assert.equal(fs.existsSync(path.join(localDir, "out", "c.json")), false);
    });

    test("exceeding maxFiles stops collecting after the allowed count and reports it accurately", async () => {
      const localDir = path.join(suiteRoot, "collected-filecap");
      const result = await runService.runCollect("remote", remoteRoot, localDir, ["out/*.json"], 10_000, 2);

      assert.equal(result.status, "failed");
      assert.match(result.reason ?? "", /maxFiles/);
      assert.equal(result.files.length, 2);
      assert.equal(fs.existsSync(path.join(localDir, "out", "c.json")), false);
    });

    test("collect failure never throws -- always a structured CollectPhaseResult", async () => {
      const localDir = path.join(suiteRoot, "collected-empty-glob");
      const result = await runService.runCollect("remote", remoteRoot, localDir, ["no-such-dir/*.json"], 10_000, 100);
      assert.equal(result.status, "completed");
      assert.equal(result.files.length, 0);
      assert.equal(result.totalBytes, 0);
    });
  });

  describe("workspace-run (public launch()): a real push failure never reaches the launching phase", () => {
    test("a real remote mkdir failure during push surfaces as RUN_PUSH_FAILED, not a launch/exec error, proving launch/exec was never reached", async () => {
      const blockedRemoteRoot = "/launch-blocked-dest";
      fs.mkdirSync(remoteServerRoot, { recursive: true });
      fs.writeFileSync(path.join(remoteServerRoot, "launch-blocked-dest"), "blocking file");

      const dir = path.join(localRoot, "launch-project");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "train.py"), "print('train')\n");

      registry.setProfiles({
        "push-fail": {
          server: "remote",
          remoteRoot: blockedRemoteRoot,
          environment: { type: "executable" },
          executable: "/bin/true",
          allowedEntrypoints: ["train.py"],
          push: { paths: [dir] },
        },
      } as any);

      const runServicePublic = RunService.getInstance();
      await assert.rejects(
        () => runServicePublic.launch({ profile: "push-fail", entrypoint: "train.py" }),
        (error: unknown) => error instanceof RunServiceError && error.code === "RUN_PUSH_FAILED",
      );

      // No run state directory was ever created -- the failure happened
      // before generateRunId()/the wrapper exec, not after.
      assert.equal(fs.existsSync(path.join(remoteServerRoot, ".handfree-runs")), false);
      registry.setProfiles({});
    });
  });
});
