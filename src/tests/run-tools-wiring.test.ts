import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSHConnectionManager } from "../services/ssh-connection-manager.js";
import { RunProfileRegistry } from "../run/run-profile-registry.js";
import { registerWorkspaceRunTool } from "../tools/workspace-run.js";
import { registerRunStatusTool } from "../tools/run-status.js";
import { registerRunLogsTool } from "../tools/run-logs.js";
import { registerRunListTool } from "../tools/run-list.js";
import { registerRunCancelTool } from "../tools/run-cancel.js";
import { RealSshTestServer } from "./helpers/real-ssh-server.js";

// PLAN.MD P2-05: black-box through a real stdio-shaped MCP transport
// (InMemoryTransport -- same technique src/tests/batch-upload-real.test.ts
// and characterization-legacy-tools.test.ts already use for "real MCP,
// no mocked transport"). Covers every preflight error branch in
// RunService.launch() (all resolvable without any remote I/O) plus the
// SFTP-backed read tools (run-status/run-logs/run-list/run-cancel) driven
// through the actual tool/envelope layer against a real ssh2 server with
// hand-seeded state files. A real successful workspace-run launch requires
// genuine Linux process semantics this dev box cannot provide -- see
// run-acceptance-linux-pending.test.ts for that (P2-05-A1).

function responseJson(result: Awaited<ReturnType<Client["callTool"]>>): any {
  const content = result.content as Array<{ type: string; text?: string }>;
  const text = content.find((item) => item.type === "text")?.text;
  assert.ok(text, "expected a text content item");
  return JSON.parse(text!);
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value), "utf8");
}

describe("P2-05 black-box: workspace-run / run-status / run-logs / run-list / run-cancel over real MCP", { concurrency: false }, () => {
  const manager = SSHConnectionManager.getInstance();
  const registry = RunProfileRegistry.getInstance();
  const suiteRoot = fs.mkdtempSync(path.join(os.tmpdir(), "handfree-run-tools-"));
  const remoteServerRoot = path.join(suiteRoot, "remote-server");
  const server = new RealSshTestServer(remoteServerRoot);
  const runsRoot = path.join(remoteServerRoot, ".handfree-runs");
  const mcpServer = new McpServer({ name: "run-tools-test", version: "1.0.0" });
  const mcpClient = new Client({ name: "run-tools-client", version: "1.0.0" });

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
    registry.setProfiles({
      "good-venv": {
        server: "remote",
        remoteRoot: "/data/proj",
        environment: { type: "venv", path: "/data/venv" },
        allowedEntrypoints: ["train.py", "bench/*.py"],
        env: { FOO: "bar" },
      },
      "bad-conda": {
        server: "remote",
        remoteRoot: "/data/proj",
        environment: { type: "conda", path: "/data/conda-env" },
      },
      "bad-gpu": {
        server: "remote",
        remoteRoot: "/data/proj",
        environment: { type: "executable" },
        executable: "/bin/true",
        allowedEntrypoints: ["a.py"],
        gpu: { required: true },
      },
      "bad-syncprofile": {
        syncProfile: "some-sync-profile",
        environment: { type: "executable" },
        executable: "/bin/true",
        allowedEntrypoints: ["a.py"],
      },
      "bad-secret": {
        server: "remote",
        remoteRoot: "/data/proj",
        environment: { type: "executable" },
        executable: "/bin/true",
        allowedEntrypoints: ["a.py"],
        secretEnv: { TOKEN: { provider: "process-env", key: "X" } },
      },
    } as any);
    registerWorkspaceRunTool(mcpServer);
    registerRunStatusTool(mcpServer);
    registerRunLogsTool(mcpServer);
    registerRunListTool(mcpServer);
    registerRunCancelTool(mcpServer);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await mcpServer.connect(serverTransport);
    await mcpClient.connect(clientTransport);
  });

  after(async () => {
    manager.disconnect();
    await Promise.all([mcpClient.close(), mcpServer.close()]);
    await server.stop();
    fs.rmSync(suiteRoot, { recursive: true, force: true });
    manager.setConfig({}, undefined);
    registry.setProfiles({});
  });

  describe("workspace-run: preflight error branches (no remote I/O reached)", () => {
    test("unknown profile -> RUN_PROFILE_NOT_FOUND", async () => {
      const result = await mcpClient.callTool({ name: "workspace-run", arguments: { profile: "nope", entrypoint: "x.py", push: false } });
      const body = responseJson(result);
      assert.equal(body.ok, false);
      assert.equal(body.error.code, "RUN_PROFILE_NOT_FOUND");
    });

    test("entrypoint not on allowedEntrypoints -> ENTRYPOINT_NOT_ALLOWED", async () => {
      const result = await mcpClient.callTool({ name: "workspace-run", arguments: { profile: "good-venv", entrypoint: "not-allowed.py", push: false } });
      const body = responseJson(result);
      assert.equal(body.error.code, "ENTRYPOINT_NOT_ALLOWED");
    });

    test("entrypoint traversal is rejected even though '**' style laxness might otherwise be tempting", async () => {
      const result = await mcpClient.callTool({ name: "workspace-run", arguments: { profile: "good-venv", entrypoint: "../../etc/passwd", push: false } });
      const body = responseJson(result);
      assert.equal(body.error.code, "ENTRYPOINT_NOT_ALLOWED");
    });

    test("env override key not on the profile's allowlist -> ENV_KEY_NOT_ALLOWED", async () => {
      const result = await mcpClient.callTool({
        name: "workspace-run",
        arguments: { profile: "good-venv", entrypoint: "train.py", push: false, env: { NOT_DECLARED: "x" } },
      });
      const body = responseJson(result);
      assert.equal(body.error.code, "ENV_KEY_NOT_ALLOWED");
    });

    // PLAN.MD P2-02/P2-06 (this round): push and collect are now real
    // phases. 'good-venv' declares neither push.paths nor collect.localDir,
    // so requesting either without configuring it is a config error --
    // caught before any remote I/O, same as every other case in this
    // describe block (superseding the old, this-round-only
    // PUSH_NOT_AVAILABLE/COLLECT_NOT_AVAILABLE placeholders).
    test("push omitted (defaults true) but profile has no push.paths -> INVALID_CONFIGURATION", async () => {
      const result = await mcpClient.callTool({ name: "workspace-run", arguments: { profile: "good-venv", entrypoint: "train.py" } });
      const body = responseJson(result);
      assert.equal(body.error.code, "INVALID_CONFIGURATION");
    });

    test("push:true explicit but profile has no push.paths -> INVALID_CONFIGURATION", async () => {
      const result = await mcpClient.callTool({ name: "workspace-run", arguments: { profile: "good-venv", entrypoint: "train.py", push: true } });
      const body = responseJson(result);
      assert.equal(body.error.code, "INVALID_CONFIGURATION");
    });

    test("non-empty collect but profile has no collect.localDir -> INVALID_CONFIGURATION", async () => {
      const result = await mcpClient.callTool({
        name: "workspace-run",
        arguments: { profile: "good-venv", entrypoint: "train.py", push: false, collect: ["out/*.txt"] },
      });
      const body = responseJson(result);
      assert.equal(body.error.code, "INVALID_CONFIGURATION");
    });

    test("sync:'flush' -> SYNC_NOT_AVAILABLE", async () => {
      const result = await mcpClient.callTool({
        name: "workspace-run",
        arguments: { profile: "good-venv", entrypoint: "train.py", push: false, sync: "flush" },
      });
      const body = responseJson(result);
      assert.equal(body.error.code, "SYNC_NOT_AVAILABLE");
    });

    test("environment.type=conda -> ENVIRONMENT_ADAPTER_NOT_AVAILABLE", async () => {
      const result = await mcpClient.callTool({ name: "workspace-run", arguments: { profile: "bad-conda", entrypoint: "a.py", push: false } });
      const body = responseJson(result);
      assert.equal(body.error.code, "ENVIRONMENT_ADAPTER_NOT_AVAILABLE");
    });

    test("gpu.required -> GPU_VALIDATION_NOT_AVAILABLE", async () => {
      const result = await mcpClient.callTool({ name: "workspace-run", arguments: { profile: "bad-gpu", entrypoint: "a.py", push: false } });
      const body = responseJson(result);
      assert.equal(body.error.code, "GPU_VALIDATION_NOT_AVAILABLE");
    });

    test("syncProfile-derived profile -> SYNC_PROFILE_NOT_AVAILABLE (Phase 3 not available)", async () => {
      const result = await mcpClient.callTool({ name: "workspace-run", arguments: { profile: "bad-syncprofile", entrypoint: "a.py", push: false } });
      const body = responseJson(result);
      assert.equal(body.error.code, "SYNC_PROFILE_NOT_AVAILABLE");
    });

    test("secretEnv declared -> SECRET_ENV_NOT_AVAILABLE", async () => {
      const result = await mcpClient.callTool({ name: "workspace-run", arguments: { profile: "bad-secret", entrypoint: "a.py", push: false } });
      const body = responseJson(result);
      assert.equal(body.error.code, "SECRET_ENV_NOT_AVAILABLE");
    });

    test("explicit server override pointing at an unconfigured server -> SERVER_NOT_FOUND", async () => {
      const result = await mcpClient.callTool({
        name: "workspace-run",
        arguments: { profile: "good-venv", entrypoint: "train.py", push: false, server: "does-not-exist" },
      });
      const body = responseJson(result);
      assert.equal(body.error.code, "SERVER_NOT_FOUND");
    });
  });

  // Plug-and-play: workspace-run shipped requiring a runProfiles.<name>
  // entry, which made it unreachable on any install whose servers come from
  // ~/.ssh/config -- those YAML files have no runProfiles: section at all, so
  // every call returned RUN_PROFILE_NOT_FOUND. These are black-box through
  // the same real MCP transport: nothing here is registered in the profile
  // registry, and the calls must still get all the way through preflight.
  describe("workspace-run inline: no runProfiles entry needed", () => {
    // Chosen as the deterministic end-of-preflight marker: runPush stats its
    // local sources BEFORE any remote I/O, so a source that cannot exist
    // fails here and nowhere earlier. Reaching it proves the inline profile
    // was built and the server, executable, entrypoint, env and push plan all
    // resolved -- with zero YAML.
    const unpushableLocalSource = path.join(suiteRoot, "does-not-exist-anywhere");

    test("remoteRoot + venv + pushPaths reaches the push phase -- no profile lookup happens at all", async () => {
      const result = await mcpClient.callTool({
        name: "workspace-run",
        arguments: {
          server: "remote",
          remoteRoot: "/data/proj",
          venv: "/data/venv",
          entrypoint: "train.py",
          pushPaths: [unpushableLocalSource],
        },
      });
      const body = responseJson(result);
      assert.equal(body.ok, false);
      assert.equal(body.error.code, "RUN_PUSH_FAILED");
      assert.match(body.error.message, /does-not-exist-anywhere/);
    });

    test("remoteRoot + executable (non-Python entrypoint) reaches the push phase too", async () => {
      const result = await mcpClient.callTool({
        name: "workspace-run",
        arguments: {
          server: "remote",
          remoteRoot: "/data/proj",
          executable: "bash",
          entrypoint: "scripts/eval.sh",
          pushPaths: [unpushableLocalSource],
        },
      });
      const body = responseJson(result);
      assert.equal(body.error.code, "RUN_PUSH_FAILED");
    });

    test("arbitrary env keys are accepted inline (the call's own env IS the allowlist)", async () => {
      const result = await mcpClient.callTool({
        name: "workspace-run",
        arguments: {
          server: "remote",
          remoteRoot: "/data/proj",
          venv: "/data/venv",
          entrypoint: "train.py",
          env: { NOT_DECLARED_ANYWHERE: "x" },
          pushPaths: [unpushableLocalSource],
        },
      });
      const body = responseJson(result);
      // The same env key returns ENV_KEY_NOT_ALLOWED for a profile-backed run
      // (see the 'good-venv' case above); inline there is no administrator to
      // have declared an allowlist, so it must pass through to push instead.
      assert.equal(body.error.code, "RUN_PUSH_FAILED");
    });

    test("entrypoint traversal is still rejected inline", async () => {
      // Inline sets allowedEntrypoints: ["**"], which compiles to `.*`. This
      // is the assertion that inline mode did not become "run any file on the
      // remote host": the safe-relative-path check still runs first.
      for (const entrypoint of ["../../etc/passwd", "/etc/passwd"]) {
        const result = await mcpClient.callTool({
          name: "workspace-run",
          arguments: { server: "remote", remoteRoot: "/data/proj", venv: "/data/venv", entrypoint },
        });
        assert.equal(responseJson(result).error.code, "ENTRYPOINT_NOT_ALLOWED", `expected '${entrypoint}' to be rejected`);
      }
    });

    test("neither profile nor remoteRoot -> INVALID_CONFIGURATION naming both ways to fix it", async () => {
      const result = await mcpClient.callTool({ name: "workspace-run", arguments: { entrypoint: "train.py" } });
      const body = responseJson(result);
      assert.equal(body.error.code, "INVALID_CONFIGURATION");
      assert.match(body.error.message, /profile/);
      assert.match(body.error.message, /remoteRoot/);
    });

    test("remoteRoot but no interpreter -> INVALID_CONFIGURATION naming venv and executable", async () => {
      const result = await mcpClient.callTool({
        name: "workspace-run",
        arguments: { server: "remote", remoteRoot: "/data/proj", entrypoint: "train.py" },
      });
      const body = responseJson(result);
      assert.equal(body.error.code, "INVALID_CONFIGURATION");
      assert.match(body.error.message, /venv/);
      assert.match(body.error.message, /executable/);
    });

    test("an inline run with no pushPaths does NOT demand push sources", async () => {
      // A profile-backed run defaults push to true, so omitting push.paths is
      // a config error (asserted above). Inline it must default to false --
      // remoteRoot is where the code already lives -- so this call has to get
      // PAST the push gate. It then proceeds into real remote I/O, whose
      // outcome on this fixture is not the point; the point is which error it
      // is NOT.
      const result = await mcpClient.callTool({
        name: "workspace-run",
        arguments: { server: "remote", remoteRoot: "/data/proj", venv: "/data/venv", entrypoint: "train.py" },
      });
      const body = responseJson(result);
      if (body.ok === false) {
        assert.notEqual(body.error.code, "INVALID_CONFIGURATION");
        assert.notEqual(body.error.code, "RUN_PROFILE_NOT_FOUND");
      }
    });
  });

  describe("run-status / run-logs / run-list / run-cancel: real SFTP reads through the tool layer", () => {
    test("run-status on a seeded completed run", async () => {
      const runId = "run_20260915T120000Z_a0000001";
      writeJson(path.join(runsRoot, runId, "meta.json"), {
        runId, profile: "good-venv", server: "remote", remoteRoot: "/data/proj", workdir: "/data/proj",
        executable: "/data/venv/bin/python", entrypoint: "/data/proj/train.py", args: [], env: {},
        createdAt: new Date().toISOString(),
        identity: { bootId: "b", pid: 1, pgid: 1, startTicks: "1", wrapperToken: "t" },
      });
      writeJson(path.join(runsRoot, runId, "exit.json"), { waitStatus: 0, finishedAt: new Date().toISOString(), cancelled: false });

      const result = await mcpClient.callTool({ name: "run-status", arguments: { runId } });
      const body = responseJson(result);
      assert.equal(body.ok, true);
      assert.equal(body.jobId, runId);
      assert.equal(body.state, "completed");
      assert.equal(body.details.exitCode, 0);
    });

    test("run-status on an unknown runId -> RUN_NOT_FOUND", async () => {
      const result = await mcpClient.callTool({ name: "run-status", arguments: { runId: "run_20260915T120000Z_a0000099" } });
      const body = responseJson(result);
      assert.equal(body.ok, false);
      assert.equal(body.error.code, "RUN_NOT_FOUND");
    });

    test("run-logs reads real bytes written to stdout.log", async () => {
      const runId = "run_20260915T120000Z_a0000002";
      writeJson(path.join(runsRoot, runId, "meta.json"), {
        runId, profile: "good-venv", server: "remote", remoteRoot: "/data/proj", workdir: "/data/proj",
        executable: "/data/venv/bin/python", entrypoint: "/data/proj/train.py", args: [], env: {},
        createdAt: new Date().toISOString(),
        identity: { bootId: "b", pid: 1, pgid: 1, startTicks: "1", wrapperToken: "t" },
      });
      fs.writeFileSync(path.join(runsRoot, runId, "stdout.log"), "epoch 1 done\nepoch 2 done\n", "utf8");

      const result = await mcpClient.callTool({ name: "run-logs", arguments: { runId, offset: 0 } });
      const body = responseJson(result);
      assert.equal(body.ok, true);
      assert.equal(body.details.text, "epoch 1 done\nepoch 2 done\n");
      assert.equal(body.details.stream, "stdout");
    });

    test("run-list finds seeded runs and honors the profile filter", async () => {
      const result = await mcpClient.callTool({ name: "run-list", arguments: { profile: "good-venv" } });
      const body = responseJson(result);
      assert.equal(body.ok, true);
      assert.ok(Array.isArray(body.details.runs));
      assert.ok(body.details.runs.every((r: any) => r.profile === "good-venv"));
      assert.ok(body.details.runs.some((r: any) => r.runId === "run_20260915T120000Z_a0000001"));
    });

    test("run-cancel on an already-finished run reports already-exited without sending any signal", async () => {
      const runId = "run_20260915T120000Z_a0000001"; // seeded above with exit.json
      const result = await mcpClient.callTool({ name: "run-cancel", arguments: { runId } });
      const body = responseJson(result);
      assert.equal(body.ok, true);
      assert.equal(body.state, "completed");
      assert.equal(body.details.outcome, "already-exited");
    });

    // Grey-box, real connection counting (same technique multi-connection
    // download's fixture already uses): proves reuseConnection is wired all
    // the way through to a real accepted TCP+SSH connection at the SFTP
    // layer that run-status/run-logs/run-list/run-cancel all share
    // (remote-sftp.ts's withSftp), not just plumbed through and ignored.
    // This is the exact layer that had no escape hatch at all before this
    // change -- a run-status call stuck behind a stale cached connection
    // (as actually happened testing workspace-run for real on .88) had no
    // parameter to force a fresh one, unlike every SFTP-using tool in the
    // rest of this codebase.
    test("reuseConnection:false opens a genuinely new SFTP connection; default reuses the cached one", async () => {
      const runId = "run_20260915T120000Z_a0000001"; // seeded above, terminal (exit.json present)

      // Warm the cache: an ordinary default-reuseConnection call first, so
      // "default reuses" is measured against a connection that already
      // exists, not against the suite's very first connect.
      await mcpClient.callTool({ name: "run-status", arguments: { runId } });

      server.resetConnectionCount();
      await mcpClient.callTool({ name: "run-status", arguments: { runId } });
      assert.equal(server.stats.connectionCount, 0, "default reuseConnection must not open a new TCP+SSH connection");

      server.resetConnectionCount();
      await mcpClient.callTool({ name: "run-status", arguments: { runId, reuseConnection: false } });
      assert.ok(
        server.stats.connectionCount >= 1,
        `reuseConnection:false must open at least one real new TCP+SSH connection, got ${server.stats.connectionCount}`,
      );
    });
  });
});
