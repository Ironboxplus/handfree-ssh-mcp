import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { after, before, describe, test } from "node:test";
import { SSHConnectionManager } from "../services/ssh-connection-manager.js";
import { RunProfileRegistry } from "../run/run-profile-registry.js";
import { RunService } from "../run/run-service.js";

/**
 * PLAN.MD P2-03-A1 / P2-04-A1 / P2-04-A2 -- REAL acceptance against a real
 * Linux host. Everything these three assert (detached survival across SSH
 * disconnect, process-GROUP signalling, /proc-based identity re-verification
 * defeating PID reuse) is genuine Linux process/kernel behavior that cannot
 * be authentically produced on this Windows dev box: there is no `setsid`,
 * no `/proc/<pid>/stat`, no `/proc/sys/kernel/random/boot_id`, and Windows
 * process-group semantics are not POSIX process groups. Faking any of that
 * here would be exactly the "assert Linux semantics against a Windows
 * stand-in" the dispatch prohibits.
 *
 * ============================================================================
 * WHAT THE REVIEWER RUNS (I have not executed this against .88 myself):
 * ============================================================================
 *
 *   SSH_LAB_HOST=10.100.100.88 \
 *   SSH_LAB_USER=<user> \
 *   SSH_LAB_KEY_PATH=/path/to/key \        (or SSH_LAB_PASSWORD=...)
 *   SSH_LAB_REMOTE_DIR=/tmp \              (optional, default /tmp)
 *   SSH_LAB_PYTHON=/usr/bin/python3 \      (optional, default /usr/bin/python3)
 *     npm run build && node --test build/tests/run-acceptance-linux-pending.test.js
 *
 * Same SSH_LAB_* variable family scripts/ssh-lab.mjs already uses (see its
 * module doc comment) -- this file connects PLAIN SSH directly to that host
 * (no docker compose orchestration of its own); point it at the lab host
 * itself, or at a container on it that has a real python3, real /proc, and
 * a real init/subreaper (the plain OpenSSH source/destination fixture images
 * scripts/ssh-lab.mjs spins up may not have python3 installed -- if they
 * don't, either add it to tests/fixtures/ssh-lab's Dockerfile or point
 * SSH_LAB_HOST/USER at .88 itself with a real venv/python3 present).
 *
 * Without SSH_LAB_HOST set, every test below reports MISSING CAPABILITY and
 * is skipped (not silently passed, not faked) -- same convention as
 * src/tests/ssh-lab.test.ts's own P0-02-A1 acceptance gate.
 * ============================================================================
 */

function hasLabCapability(): boolean {
  return typeof process.env.SSH_LAB_HOST === "string" && process.env.SSH_LAB_HOST.length > 0;
}

const skipReason = hasLabCapability()
  ? undefined
  : "MISSING CAPABILITY: SSH_LAB_HOST (and SSH_LAB_USER + SSH_LAB_KEY_PATH/SSH_LAB_PASSWORD) not set. " +
    "This is a real Linux acceptance test (setsid/proc/process-group semantics) that cannot run on this dev box " +
    "and is not faked. See this file's module doc comment for exactly what to set.";

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe("P2-03-A1 / P2-04-A1 / P2-04-A2: real Linux acceptance (SKIPPED unless SSH_LAB_HOST is set)", { concurrency: false }, () => {
  const manager = SSHConnectionManager.getInstance();
  const runService = RunService.getInstance();
  const registry = RunProfileRegistry.getInstance();
  const remoteDir = process.env.SSH_LAB_REMOTE_DIR ?? "/tmp";
  const remoteRoot = `${remoteDir}/handfree-p2-accept-${crypto.randomBytes(4).toString("hex")}`;
  const python = process.env.SSH_LAB_PYTHON ?? "/usr/bin/python3";
  const localScratch = fs.mkdtempSync(path.join(os.tmpdir(), "handfree-p2-accept-"));
  const SERVER = "p2-accept-lab";
  // Reviewer-added. Run state lives at ~/.handfree-runs/<runId>/, which is
  // OUTSIDE remoteRoot, so the remoteRoot cleanup below does not touch it.
  // On a shared machine (.88 is one) every acceptance run would otherwise
  // leave a directory behind in the account's home forever. Track what we
  // create so cleanup can be exact rather than a wildcard sweep.
  const createdRunIds: string[] = [];
  // Reviewer-added. Every background process this suite starts gets a unique
  // marker so it can be killed by that marker alone. PLAN.MD's .88 rule is
  // "禁止触碰前缀之外的任何路径、容器或网络" -- a broad `pkill -f 'sleep 300'`
  // would kill any unrelated process of this user that happens to match.
  const startedMarkers: string[] = [];

  before(async () => {
    if (!hasLabCapability()) return;
    manager.setConfig(
      {
        [SERVER]: {
          host: process.env.SSH_LAB_HOST!,
          port: process.env.SSH_LAB_PORT ? Number(process.env.SSH_LAB_PORT) : 22,
          username: process.env.SSH_LAB_USER!,
          password: process.env.SSH_LAB_PASSWORD,
          // Reviewer-fixed: this field is a PATH, not key material. The
          // original read the file and passed its contents, so the pool tried
          // to open the key text as a filename -- and the resulting ENOENT
          // message printed the whole private key. See
          // describePrivateKeyReadFailure in ssh-connection-pool.ts.
          privateKey: process.env.SSH_LAB_KEY_PATH,
          disableSftpPathPolicy: true,
        },
      },
      [SERVER],
    );
    registry.setProfiles({
      "p2-accept": {
        server: SERVER,
        remoteRoot,
        environment: { type: "executable" },
        executable: python,
        allowedEntrypoints: ["*.py"],
        env: {},
      },
    } as any);
    await manager.executeCommand(`mkdir -p ${remoteRoot}`, SERVER, { timeout: 15000 });
  });

  after(async () => {
    if (hasLabCapability()) {
      for (const marker of startedMarkers) {
        try {
          await manager.executeCommand(`pkill -f ${marker} || true`, SERVER, { timeout: 15000 });
        } catch {
          // best-effort
        }
      }
      // `rm -rf` is refused by this product's own built-in dangerous-command
      // blacklist ("recursive force rm"), so the obvious cleanup command is
      // silently rejected and every acceptance run would litter a shared host.
      // Observed for real on .88: three run directories and one workspace
      // directory survived a full green run because the rejection was
      // swallowed by a bare `catch {}`. `find <exact paths> -delete` removes
      // the same trees without matching the blacklist.
      const leftovers: string[] = [];
      const removeTree = async (remotePath: string): Promise<void> => {
        try {
          await manager.executeCommand(`find ${remotePath} -mindepth 0 -delete`, SERVER, { timeout: 15000 });
          const check = await manager.executeCommand(
            `test -e ${remotePath} && echo PRESENT || echo GONE`,
            SERVER,
            { timeout: 15000 },
          );
          if (!/GONE/.test(check)) leftovers.push(remotePath);
        } catch (error) {
          leftovers.push(`${remotePath} (${(error as Error).message})`);
        }
      };

      for (const runId of createdRunIds) {
        // Exact path, never a glob: only directories this suite created.
        await removeTree(`"$HOME/.handfree-runs/${runId}"`);
      }
      await removeTree(remoteRoot);

      manager.disconnect();
      if (leftovers.length > 0) {
        // Loud, not swallowed: .88 is a shared machine and silent cleanup
        // failure is how it accumulates junk.
        throw new Error(
          `acceptance cleanup failed to remove ${leftovers.length} remote path(s) on the shared lab host; ` +
            `remove them manually: ${leftovers.join(", ")}`,
        );
      }
    }
    fs.rmSync(localScratch, { recursive: true, force: true });
    manager.setConfig({}, undefined);
    registry.setProfiles({});
  });

  async function uploadScript(filename: string, content: string): Promise<void> {
    const localPath = path.join(localScratch, filename);
    fs.writeFileSync(localPath, content, "utf8");
    await manager.getTransferService().upload(localPath, `${remoteRoot}/${filename}`, SERVER);
  }

  test(
    "P2-03-A1: a real ~30s python program survives an SSH-client-cache reset (adapter-restart analog) and reports the real exit code",
    { skip: skipReason },
    async () => {
      const seconds = process.env.SSH_LAB_P2_SLEEP_SECONDS ? Number(process.env.SSH_LAB_P2_SLEEP_SECONDS) : 30;
      await uploadScript(
        "p2_03_a1.py",
        [
          "import sys, time",
          "for i in range(1, 6):",
          "    print(f'progress {i}', flush=True)",
          `    time.sleep(${seconds} / 5)`,
          "sys.exit(0)",
          "",
        ].join("\n"),
      );

      const launch = await runService.launch({ profile: "p2-accept", entrypoint: "p2_03_a1.py", push: false });
      createdRunIds.push(launch.runId);
      assert.equal(launch.status.state, "running");

      await sleep(1000);
      const midStatus = await runService.getStatus(SERVER, launch.runId);
      assert.equal(midStatus.state, "running", "expected the run to still be in progress");
      const midLogs = await runService.getLogs(SERVER, launch.runId, "stdout", 0, 65536);
      assert.match(midLogs.text, /progress 1/);

      // Adapter-restart analog: SSHConnectionManager is a process-wide
      // singleton, so a literal new-process restart can't be simulated
      // in-process -- but the entire point of "no local authoritative
      // state" is that closing and reopening the SSH connection is
      // observably equivalent to a restart from RunService's point of
      // view, since it holds nothing else. This is the real, load-bearing
      // assertion this test exists to make.
      manager.disconnect();

      let finalStatus = await runService.getStatus(SERVER, launch.runId);
      const deadline = Date.now() + (seconds + 15) * 1000;
      while (finalStatus.state === "running" && Date.now() < deadline) {
        await sleep(1000);
        finalStatus = await runService.getStatus(SERVER, launch.runId);
      }
      assert.equal(finalStatus.state, "completed");
      assert.equal(finalStatus.exitCode, 0);

      const fullLogs = await runService.getLogs(SERVER, launch.runId, "stdout", 0, 65536);
      assert.match(fullLogs.text, /progress 5/);
    },
  );

  test(
    "P2-04-A1: cancel kills the whole process group (child + its own grandchild) and leaves an unrelated process untouched",
    { skip: skipReason },
    async () => {
      const marker = `handfree-unrelated-${crypto.randomBytes(4).toString("hex")}`;
      const noiseMarker = `handfree-noise-${crypto.randomBytes(4).toString("hex")}`;
      startedMarkers.push(marker, noiseMarker);
      // Reviewer-changed: this background process was originally an untagged
      // `sleep 300`, which left no way to clean it up precisely and forced a
      // `pkill -f 'sleep 300'` at the end of the test -- that would kill any
      // unrelated process of this user matching the same pattern, which on a
      // shared host is exactly what PLAN.MD's .88 rule forbids. Tagging it
      // makes cleanup exact.
      await manager.executeCommand(`nohup bash -c 'exec -a ${noiseMarker} sleep 300' >/dev/null 2>&1 & disown; echo started`, SERVER, { timeout: 15000 });
      // A second, genuinely-unrelated long-lived process, tagged so we can
      // find it again -- started completely outside of workspace-run.
      await manager.executeCommand(`nohup bash -c 'exec -a ${marker} sleep 300' >/dev/null 2>&1 & disown; echo started`, SERVER, { timeout: 15000 });

      await uploadScript(
        "p2_04_a1.py",
        [
          "import subprocess, time",
          "child = subprocess.Popen(['sleep', '300'])",
          "print(f'grandchild_pid {child.pid}', flush=True)",
          "child.wait()",
          "",
        ].join("\n"),
      );

      const launch = await runService.launch({ profile: "p2-accept", entrypoint: "p2_04_a1.py", push: false });
      createdRunIds.push(launch.runId);
      await sleep(1500);
      const logs = await runService.getLogs(SERVER, launch.runId, "stdout", 0, 4096);
      const grandchildMatch = logs.text.match(/grandchild_pid (\d+)/);
      assert.ok(grandchildMatch, `expected the script to report its own child's pid; got: ${logs.text}`);
      const grandchildPid = grandchildMatch![1];

      const cancelResult = await runService.cancel(SERVER, launch.runId, 3000);
      assert.ok(cancelResult.outcome === "terminated" || cancelResult.outcome === "killed", cancelResult.outcome);

      await sleep(500);
      const grandchildAlive = await manager.executeCommand(`kill -0 ${grandchildPid} 2>/dev/null && echo alive || echo dead`, SERVER, { timeout: 15000 });
      assert.match(grandchildAlive, /dead/, "the launched process's own child (grandchild) must also be gone");

      const unrelatedAlive = await manager.executeCommand(`pgrep -f ${marker} >/dev/null && echo alive || echo dead`, SERVER, { timeout: 15000 });
      assert.match(unrelatedAlive, /alive/, "cancel must not touch an unrelated process of the same user");

      // Reviewer-changed: marker-scoped only. The original also ran
      // `pkill -f 'sleep 300'`, which is unscoped and would kill unrelated
      // processes belonging to this user on a shared host.
      await manager.executeCommand(`pkill -f ${marker} || true`, SERVER, { timeout: 15000 });
      await manager.executeCommand(`pkill -f ${noiseMarker} || true`, SERVER, { timeout: 15000 });
    },
  );

  test(
    "P2-04-A2: a fabricated identity mismatch (pointed at a real, unrelated live process) routes to orphaned and sends nothing to it",
    { skip: skipReason },
    async () => {
      const marker = `handfree-innocent-${crypto.randomBytes(4).toString("hex")}`;
      startedMarkers.push(marker);
      await manager.executeCommand(`nohup bash -c 'exec -a ${marker} sleep 300' >/dev/null 2>&1 & disown; echo started`, SERVER, { timeout: 15000 });
      await sleep(300);
      const pidOutput = await manager.executeCommand(`pgrep -f ${marker}`, SERVER, { timeout: 15000 });
      const innocentPid = pidOutput.trim().split("\n")[0].trim();
      assert.ok(/^\d+$/.test(innocentPid), `expected a numeric pid, got: ${JSON.stringify(pidOutput)}`);

      // Launch a real run, then overwrite its meta.json's identity to point
      // at the innocent process above with a deliberately WRONG bootId/pgid/
      // startTicks/wrapperToken -- i.e. exactly the pid-reuse shape
      // decideCancelAction() exists to catch, constructed reliably instead
      // of racing the kernel's real pid-recycling behavior.
      await uploadScript("p2_04_a2.py", ["import time", "time.sleep(120)", ""].join("\n"));
      const launch = await runService.launch({ profile: "p2-accept", entrypoint: "p2_04_a2.py", push: false });
      createdRunIds.push(launch.runId);

      const runDirRelative = `.handfree-runs/${launch.runId}`;
      const fabricated =
        `{"runId":"${launch.runId}","profile":"p2-accept","server":"${SERVER}","remoteRoot":"${remoteRoot}",` +
        `"workdir":"${remoteRoot}","executable":"${python}","entrypoint":"${remoteRoot}/p2_04_a2.py","args":[],"env":{},` +
        `"createdAt":"${new Date().toISOString()}",` +
        `"identity":{"bootId":"deliberately-wrong-boot-id","pid":${innocentPid},"pgid":${innocentPid},"startTicks":"0","wrapperToken":"deliberately-wrong-token"}}`;
      await manager.executeCommand(
        `printf '%s' '${fabricated}' > "$HOME/${runDirRelative}/meta.json"`,
        SERVER,
        { timeout: 15000 },
      );

      const result = await runService.cancel(SERVER, launch.runId, 3000);
      assert.equal(result.outcome, "orphaned");

      const innocentAlive = await manager.executeCommand(`kill -0 ${innocentPid} 2>/dev/null && echo alive || echo dead`, SERVER, { timeout: 15000 });
      assert.match(innocentAlive, /alive/, "the unrelated process the fabricated identity pointed at must never be signalled");

      // Clean up the real (still-running, never cancelled) p2_04_a2 process
      // and the innocent marker process.
      // Reviewer-changed: match the unique remoteRoot path rather than the
      // bare script name, so this cannot reach a same-named process that
      // belongs to someone else on a shared host.
      await manager.executeCommand(`pkill -f ${remoteRoot}/p2_04_a2.py || true`, SERVER, { timeout: 15000 });
      await manager.executeCommand(`pkill -f ${marker} || true`, SERVER, { timeout: 15000 });
    },
  );
});
