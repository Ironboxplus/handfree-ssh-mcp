#!/usr/bin/env node
// Packaging smoke gate: proves the *published npm artifact* actually runs,
// not just the local build/ directory every other test in this repo targets.
//
// Rationale: `npm run build && node --test build/...` (the default `npm
// test`) never touches `package.json`'s `files` allowlist. A module that's
// compiled but missing from `files` looks completely fine to every unit and
// integration test here, then breaks for every real installer the moment
// the entry point tries to `import` it — exactly what happened when the
// P0-04 SshConnectionPool extraction added `src/connection/` without adding
// `build/connection/**/*` to `files` (fixed in this repo's history; this
// gate exists so it can't silently regress).
//
// What this does, for real, no mocks:
//   1. `npm run build` (fresh compile) + `npm pack` (the real tarball npm
//      would publish).
//   2. `npm install <tarball>` into a brand-new temp directory OUTSIDE this
//      repo, so nothing resolves back to src/ or the repo's own
//      node_modules by accident.
//   3. Spawn the installed package's real entry point as a child process,
//      complete a real MCP stdio handshake (the SDK client from THIS
//      repo's node_modules drives it — only the server under test needs to
//      come from the fresh install), call `list-servers`, and assert a
//      well-formed tool response comes back.
//   4. Tear the temp directories down in a `finally`.
//
// Exit code contract (matches scripts/preflight.mjs / scripts/ssh-lab.mjs):
//   0 = pass
//   1 = assertion failure   (the packaged artifact does not work)
//   2 = missing required capability (npm registry/network unavailable, so
//                                     this gate's own prerequisite — a real
//                                     `npm install` from a tarball — cannot
//                                     run at all)
//   3 = infrastructure error (unexpected exception; build/pack/tempdir
//                             failures that aren't about the package itself)
// Same classification is written to artifacts/test-package/result.json.
//
// Deliberately NOT part of `npm test` — packing + a real `npm install` is
// far slower than the unit/integration suite. Run explicitly via
// `npm run test:package`.

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const artifactsDir = path.join(repoRoot, "artifacts", "test-package");

const HANDSHAKE_DEADLINE_MS = 20_000;
const BUILD_TIMEOUT_MS = 180_000;
const PACK_TIMEOUT_MS = 60_000;
const INSTALL_TIMEOUT_MS = 300_000;

class GateFailure extends Error {
  constructor(message, { exitCode, classification }) {
    super(message);
    this.exitCode = exitCode;
    this.classification = classification;
  }
}

function assertionFailure(message) {
  return new GateFailure(message, { exitCode: 1, classification: "ASSERTION_FAILURE" });
}
function missingCapability(message) {
  return new GateFailure(message, { exitCode: 2, classification: "MISSING_REQUIRED_CAPABILITY" });
}
function infrastructureError(message) {
  return new GateFailure(message, { exitCode: 3, classification: "INFRASTRUCTURE_ERROR" });
}

/** Real npm invocation. On Windows `npm` is a .cmd shim spawnSync can't
 * exec directly without a shell — same workaround preflight.mjs uses. */
function runNpm(args, opts) {
  const cmd = "npm";
  if (process.platform === "win32") {
    const quoted = [cmd, ...args]
      .map((part) => (/[\s"]/.test(part) ? `"${part.replace(/"/g, '\\"')}"` : part))
      .join(" ");
    return spawnSync(quoted, { shell: true, encoding: "utf8", ...opts });
  }
  return spawnSync(cmd, args, { encoding: "utf8", ...opts });
}

function tail(text, n = 2000) {
  const s = String(text ?? "");
  return s.length > n ? `...${s.slice(-n)}` : s;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Windows only: the child node.exe process can hold file handles open for
 * a short window after StdioClientTransport.close() returns (it aborts the
 * process but does not wait for the OS to actually reap it), which races
 * against deleting its own install directory. Poll liveness via
 * `process.kill(pid, 0)` (throws ESRCH once the process is gone) instead of
 * a blind delay. */
async function waitForProcessExit(pid, timeoutMs = 5000) {
  if (!pid) return;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return; // ESRCH (or any signal failure) => process is gone.
    }
    await sleep(100);
  }
}

async function rmrf(dir, { retries = 5, delayMs = 300 } = {}) {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
      return;
    } catch (error) {
      if (attempt === retries - 1) {
        process.stderr.write(`warning: failed to remove ${dir}: ${error.message}\n`);
        return;
      }
      await sleep(delayMs);
    }
  }
}

function withDeadline(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(assertionFailure(`${label} did not complete within ${ms}ms`));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function main() {
  const log = [];
  const record = (line) => {
    log.push(line);
    process.stderr.write(line + "\n");
  };
  const step = (id, fn) => {
    record(`[step] ${id}`);
    return fn();
  };

  let tarballDir = null;
  let installDir = null;
  let client = null;
  let serverPid = null;

  try {
    // 1) Real build + real tarball -----------------------------------------
    step("build", () => {
      const result = runNpm(["run", "build"], { cwd: repoRoot, timeout: BUILD_TIMEOUT_MS });
      if (result.status !== 0) {
        throw infrastructureError(
          `npm run build failed (exit ${result.status ?? result.error?.message}): ${tail(result.stderr || result.stdout)}`,
        );
      }
      record("  build ok");
    });

    tarballDir = fs.mkdtempSync(path.join(os.tmpdir(), "handfree-pkg-tarball-"));
    const tarballPath = step("npm-pack", () => {
      const result = runNpm(["pack", "--json", "--pack-destination", tarballDir], {
        cwd: repoRoot,
        timeout: PACK_TIMEOUT_MS,
      });
      if (result.status !== 0) {
        throw infrastructureError(`npm pack failed (exit ${result.status}): ${tail(result.stderr || result.stdout)}`);
      }
      let parsed;
      try {
        parsed = JSON.parse(result.stdout);
      } catch (error) {
        throw infrastructureError(`npm pack --json produced unparseable output: ${tail(result.stdout)}`);
      }
      const entry = Array.isArray(parsed) ? parsed[0] : null;
      if (!entry?.filename) {
        throw infrastructureError(`npm pack --json output missing a filename: ${tail(result.stdout)}`);
      }
      const resolved = path.join(tarballDir, entry.filename);
      if (!fs.existsSync(resolved)) {
        throw infrastructureError(`npm pack reported ${resolved} but it does not exist on disk`);
      }
      record(`  tarball: ${resolved} (${entry.size ?? "?"} bytes)`);
      return resolved;
    });

    // 2) Real install into a temp dir OUTSIDE the repo -----------------------
    installDir = fs.mkdtempSync(path.join(os.tmpdir(), "handfree-pkg-install-"));
    record(`[step] install-sandbox at ${installDir} (outside ${repoRoot})`);
    fs.writeFileSync(
      path.join(installDir, "package.json"),
      JSON.stringify({ name: "handfree-package-smoke-consumer", version: "0.0.0", private: true }, null, 2),
    );

    step("npm-install-tarball", () => {
      const result = runNpm(["install", tarballPath, "--no-audit", "--no-fund", "--no-save"], {
        cwd: installDir,
        timeout: INSTALL_TIMEOUT_MS,
      });
      if (result.status !== 0) {
        throw missingCapability(
          `npm install of the real tarball failed in a clean sandbox (exit ${result.status}) — most likely no npm registry access from this environment: ${tail(result.stderr || result.stdout)}`,
        );
      }
      record("  install ok");
    });

    // 3) Resolve the real installed entry point -------------------------------
    const { entryPath, packageVersion } = step("resolve-entry-point", () => {
      const pkgDir = path.join(installDir, "node_modules", "@aaarc", "handfree-ssh-mcp");
      const pkgJsonPath = path.join(pkgDir, "package.json");
      if (!fs.existsSync(pkgJsonPath)) {
        throw assertionFailure(`installed package.json not found at ${pkgJsonPath} — npm install did not land the package`);
      }
      const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8"));
      const main = pkgJson.main ?? "build/index.js";
      const resolved = path.join(pkgDir, main);
      if (!fs.existsSync(resolved)) {
        throw assertionFailure(`installed package's entry point ${resolved} does not exist on disk`);
      }
      record(`  entry point: ${resolved}`);
      return { entryPath: resolved, packageVersion: pkgJson.version };
    });

    // 4) Hermetic server config: no dependency on this machine's real
    //    ~/.ssh/config, one syntactically valid but unreachable server so
    //    startup succeeds without attempting any real network connection
    //    (list-servers never connects). A YAML-sourced server always needs
    //    an explicit credential field (config-loader.ts forces
    //    authOptional=false for YAML servers, unlike OpenSSH-config-sourced
    //    ones) — the password value itself is never used.
    const yamlPath = path.join(installDir, "smoke-servers.yaml");
    fs.writeFileSync(
      yamlPath,
      [
        "servers:",
        "  smoke-test-server:",
        "    host: 203.0.113.1", // TEST-NET-3 (RFC 5737); never dialed by list-servers
        "    port: 22",
        "    username: smoke",
        "    password: unused-smoke-test-password",
        "",
      ].join("\n"),
    );

    // 5) Spawn the REAL installed artifact and drive a REAL MCP handshake ----
    await step("spawn-and-handshake", async () => {
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [entryPath, "--no-ssh-config", "--config", yamlPath],
        cwd: installDir,
        stderr: "pipe",
      });
      const stderrChunks = [];
      transport.stderr?.on("data", (chunk) => stderrChunks.push(chunk));

      client = new Client({ name: "handfree-package-smoke", version: "0.0.0" });

      try {
        await withDeadline(client.connect(transport), HANDSHAKE_DEADLINE_MS, "MCP initialize handshake");
      } catch (error) {
        const stderrText = Buffer.concat(stderrChunks).toString("utf8");
        throw assertionFailure(
          `installed server failed to complete the MCP handshake: ${error.message}\n` +
            `--- child stderr ---\n${tail(stderrText)}`,
        );
      }
      serverPid = transport.pid;
      const serverVersion = client.getServerVersion();
      record(`  handshake ok (server: ${JSON.stringify(serverVersion)}, pid=${serverPid})`);

      // SERVER_CONFIG.version is a hand-maintained literal in src/config/server.ts
      // while package.json's version is what npm publishes. They drifted silently
      // once (1.0.17 vs 1.0.19), so every client saw a stale version over the
      // wire. Only the packaged artifact can compare the two for real.
      if (serverVersion?.version !== packageVersion) {
        throw assertionFailure(
          `handshake version ${JSON.stringify(serverVersion?.version)} does not match the published package version ` +
            `${JSON.stringify(packageVersion)} — update SERVER_CONFIG.version in src/config/server.ts`,
        );
      }

      let toolResult;
      try {
        toolResult = await withDeadline(
          client.callTool({ name: "list-servers", arguments: {} }),
          HANDSHAKE_DEADLINE_MS,
          "list-servers tool call",
        );
      } catch (error) {
        const stderrText = Buffer.concat(stderrChunks).toString("utf8");
        throw assertionFailure(
          `list-servers tool call against the installed server failed: ${error.message}\n` +
            `--- child stderr ---\n${tail(stderrText)}`,
        );
      }

      if (toolResult.isError) {
        throw assertionFailure(`list-servers returned isError=true: ${JSON.stringify(toolResult.content)}`);
      }
      const textBlock = toolResult.content?.find((c) => c.type === "text");
      if (!textBlock || typeof textBlock.text !== "string") {
        throw assertionFailure(`list-servers response has no text content block: ${JSON.stringify(toolResult)}`);
      }
      let payload;
      try {
        payload = JSON.parse(textBlock.text);
      } catch (error) {
        throw assertionFailure(`list-servers text content is not valid JSON: ${tail(textBlock.text)}`);
      }
      if (!Array.isArray(payload) || payload.length !== 1 || payload[0]?.name !== "smoke-test-server") {
        throw assertionFailure(
          `list-servers did not return the expected one-server payload: ${JSON.stringify(payload)}`,
        );
      }
      record(`  list-servers ok: ${JSON.stringify(payload)}`);
    });

    const result = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      exitCode: 0,
      classification: "PASS",
      log,
    };
    fs.mkdirSync(artifactsDir, { recursive: true });
    fs.writeFileSync(path.join(artifactsDir, "result.json"), JSON.stringify(result, null, 2) + "\n", "utf8");
    record(`=== test:package PASSED — artifact written to ${path.join(artifactsDir, "result.json")} ===`);
    process.exitCode = 0;
  } catch (error) {
    const gateError = error instanceof GateFailure ? error : infrastructureError(error.stack ?? String(error));
    const result = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      exitCode: gateError.exitCode,
      classification: gateError.classification,
      error: gateError.message,
      log,
    };
    try {
      fs.mkdirSync(artifactsDir, { recursive: true });
      fs.writeFileSync(path.join(artifactsDir, "result.json"), JSON.stringify(result, null, 2) + "\n", "utf8");
    } catch {
      // last resort: still surface via stderr/exit code even if the
      // artifact itself cannot be written.
    }
    process.stderr.write(`=== test:package FAILED [${gateError.classification}] ===\n${gateError.message}\n`);
    process.exitCode = gateError.exitCode;
  } finally {
    if (client) {
      try {
        await client.close();
      } catch {
        // best-effort
      }
    }
    // client.close() aborts the child process but does not wait for the OS
    // to actually reap it; without this, deleting installDir can race a
    // still-exiting node.exe that holds handles inside it (observed as
    // EPERM on Windows).
    await waitForProcessExit(serverPid);
    if (installDir) await rmrf(installDir);
    if (tarballDir) await rmrf(tarballDir);
  }
}

main();
