#!/usr/bin/env node
// PLAN.MD P0-02 — real SSH lab lifecycle + acceptance runner.
//
// Brings up two real Docker containers (source/destination, each real
// OpenSSH/SFTP) on a real remote Linux host reachable over SSH, runs the
// P0-02-A1 acceptance checks against them for real (uname, SFTP
// upload/download round-trip with SHA-256 verification, pinned-key direct
// access, and a genuinely-failing auth path for relay-fallback testing),
// and tears everything down in a `finally`. No mocks, no simulated results
// (PLAN.MD §7.2): every step here is a real SSH/SFTP/Docker operation.
//
// The lab host is never hardcoded. It — and the credentials used to reach
// it — are supplied entirely via environment variables, because driving
// Docker on that host requires the operator's own real SSH identity, which
// must never be committed to this repo:
//
//   SSH_LAB_HOST          required (e.g. 10.100.100.88)
//   SSH_LAB_PORT          optional, default 22
//   SSH_LAB_USER          required
//   SSH_LAB_KEY_PATH      path to a private key file (mutually exclusive
//                         with SSH_LAB_PASSWORD; at least one required)
//   SSH_LAB_PASSWORD      password auth alternative to SSH_LAB_KEY_PATH
//   SSH_LAB_SUDO_DOCKER   "true" (default) | "false" — prefix docker with
//                         `sudo -n` (needed when the lab user is not in the
//                         docker group, which PLAN.MD's P0-02 host decision
//                         explicitly says not to change)
//   SSH_LAB_APT_PROXY     optional HTTP(S) proxy passed as the image's
//                         APT_PROXY build-arg (see Dockerfile comment)
//   SSH_LAB_REMOTE_DIR    optional remote scratch root, default /tmp
//
// Exit code contract (PLAN.MD §7.4): 0 pass, 1 assertion failure,
// 2 missing required capability (e.g. lab host not configured/reachable),
// 3 infrastructure error. Same classification written to the JSON artifact.

import { Client } from "ssh2";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const fixtureDir = path.join(repoRoot, "tests", "fixtures", "ssh-lab");

// ---------------------------------------------------------------------------
// Pure helpers (white-box tested in src/tests/ssh-lab.test.ts)
// ---------------------------------------------------------------------------

/** Every resource this script creates on the shared lab host is namespaced
 * under this prefix + a fresh random token, per run. Never reuse a fixed
 * name across runs on a shared machine. */
export function buildProjectName(token) {
  return `handfree-sshlab-${token}`;
}

/** Parses `docker compose port <service> <containerPort>` output (one or
 * more "<bind-addr>:<port>" lines, e.g. "0.0.0.0:32768" or "[::]:32768") and
 * returns the numeric host port from the first non-empty line. Pure: no I/O. */
export function parseDockerComposePortOutput(output) {
  const line = (output ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) {
    throw new Error(`empty docker compose port output: ${JSON.stringify(output)}`);
  }
  const match = line.match(/:(\d+)\s*$/);
  if (!match) {
    throw new Error(`could not parse a port number from docker compose port output line: ${JSON.stringify(line)}`);
  }
  const port = Number(match[1]);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`parsed an out-of-range port (${port}) from: ${JSON.stringify(line)}`);
  }
  return port;
}

/**
 * Deterministic, fixed-seed payload generator (pure): repeatedly hashes
 * `seed` with a counter and concatenates SHA-256 digests until `sizeBytes`
 * is reached. Same seed + size always produces the exact same bytes, so
 * P0-02-A1's "fixed seed random file" is reproducible without needing a
 * checked-in binary fixture.
 */
export function deterministicPayload(seed, sizeBytes) {
  if (!Number.isInteger(sizeBytes) || sizeBytes < 0) {
    throw new Error(`sizeBytes must be a non-negative integer, got ${sizeBytes}`);
  }
  const chunks = [];
  let produced = 0;
  let counter = 0;
  while (produced < sizeBytes) {
    const digest = createHash("sha256").update(`${seed}:${counter}`).digest();
    chunks.push(digest);
    produced += digest.length;
    counter += 1;
  }
  return Buffer.concat(chunks, sizeBytes);
}

/** Single-quote a string for a POSIX shell, the same scheme used in
 * ssh-connection-manager.ts's shellQuote. */
export function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

// ---------------------------------------------------------------------------
// CLI / config
// ---------------------------------------------------------------------------

function readLabConfig() {
  const host = process.env.SSH_LAB_HOST;
  const user = process.env.SSH_LAB_USER;
  const keyPath = process.env.SSH_LAB_KEY_PATH;
  const password = process.env.SSH_LAB_PASSWORD;
  const missing = [];
  if (!host) missing.push("SSH_LAB_HOST");
  if (!user) missing.push("SSH_LAB_USER");
  if (!keyPath && !password) missing.push("SSH_LAB_KEY_PATH or SSH_LAB_PASSWORD");
  if (missing.length > 0) {
    return { ok: false, missing };
  }
  return {
    ok: true,
    host,
    port: Number(process.env.SSH_LAB_PORT ?? 22),
    user,
    keyPath,
    password,
    sudoDocker: (process.env.SSH_LAB_SUDO_DOCKER ?? "true") !== "false",
    aptProxy: process.env.SSH_LAB_APT_PROXY ?? "",
    remoteDirRoot: process.env.SSH_LAB_REMOTE_DIR ?? "/tmp",
  };
}

// ---------------------------------------------------------------------------
// Real SSH/SFTP/exec driver against the lab host
// ---------------------------------------------------------------------------

class LabHostConnection {
  constructor(config) {
    this.config = config;
    this.client = null;
  }

  async connect() {
    const { config } = this;
    await new Promise((resolve, reject) => {
      const client = new Client();
      client.once("ready", () => {
        this.client = client;
        resolve();
      });
      client.once("error", reject);
      client.connect({
        host: config.host,
        port: config.port,
        username: config.user,
        ...(config.keyPath ? { privateKey: fs.readFileSync(config.keyPath) } : {}),
        ...(config.password ? { password: config.password } : {}),
        readyTimeout: 15000,
      });
    });
  }

  close() {
    try { this.client?.end(); } catch { /* already closed */ }
  }

  /** Real command execution on the lab host, prefixed with `sudo -n docker`
   * env-injection when the command starts with `docker` and sudo is
   * configured — see the module doc comment for why `sudo -n env VAR=...`
   * rather than `VAR=... sudo` (sudo does not forward the caller's
   * environment by default). */
  exec(command, { timeoutMs = 120000 } = {}) {
    return new Promise((resolve, reject) => {
      if (!this.client) return reject(new Error("not connected"));
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error(`remote command timed out after ${timeoutMs}ms: ${command}`));
      }, timeoutMs);
      this.client.exec(command, (err, stream) => {
        if (err) {
          clearTimeout(timer);
          reject(err);
          return;
        }
        let stdout = "";
        let stderr = "";
        stream.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
        stream.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
        stream.on("close", (code) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({ code: code ?? 0, stdout, stderr });
        });
        stream.on("error", (streamErr) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(streamErr);
        });
      });
    });
  }

  async execOk(command, options) {
    const result = await this.exec(command, options);
    if (result.code !== 0) {
      throw new Error(`remote command failed (exit ${result.code}): ${command}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
    }
    return result;
  }

  sftpUploadFile(localPath, remotePath) {
    return new Promise((resolve, reject) => {
      this.client.sftp((err, sftp) => {
        if (err) return reject(err);
        sftp.fastPut(localPath, remotePath, (putErr) => {
          if (putErr) return reject(putErr);
          resolve();
        });
      });
    });
  }
}

/** docker (optionally sudo -n) with explicit env-var injection via `env`,
 * because `sudo -n` does not forward the caller's shell environment. */
function dockerCmd(config, argsString, { env = {} } = {}) {
  const envAssignments = Object.entries(env)
    .map(([key, value]) => `${key}=${shellQuote(value)}`)
    .join(" ");
  const envPrefix = envAssignments ? `env ${envAssignments} ` : "";
  return config.sudoDocker ? `sudo -n ${envPrefix}docker ${argsString}` : `${envPrefix}docker ${argsString}`;
}

// ---------------------------------------------------------------------------
// Lab lifecycle
// ---------------------------------------------------------------------------

/** Pure-ish: computes every remote path/name this run will use, without
 * touching the network. Called before any docker/SSH operation so that even
 * a failure on the very first remote command still leaves `main()` knowing
 * exactly what (if anything) needs to be torn down — see the `lab` object
 * being built here and threaded into the finally block in main(). */
function buildLabPaths(config, token) {
  const projectName = buildProjectName(token);
  const remoteDir = `${config.remoteDirRoot}/${projectName}`;
  const imageTag = `handfree-sshlab-image:${token}`;
  const composePath = `${remoteDir}/compose.yaml`;
  return { projectName, remoteDir, imageTag, composePath };
}

async function upLab(conn, config, lab, log) {
  const { projectName, remoteDir, imageTag, composePath } = lab;

  log(`creating remote fixture directory ${remoteDir}`);
  await conn.execOk(`mkdir -p ${shellQuote(remoteDir)}`);

  for (const file of ["Dockerfile", "entrypoint.sh", "compose.yaml"]) {
    await conn.sftpUploadFile(path.join(fixtureDir, file), `${remoteDir}/${file}`);
  }
  await conn.execOk(`chmod 755 ${shellQuote(`${remoteDir}/entrypoint.sh`)}`);

  log(`building image ${imageTag} (project ${projectName})`);
  await conn.execOk(
    dockerCmd(config, `compose -p ${shellQuote(projectName)} -f ${shellQuote(composePath)} build`, {
      env: { APT_PROXY: config.aptProxy, LAB_IMAGE_TAG: imageTag },
    }),
    { timeoutMs: 240000 },
  );

  log(`starting containers (project ${projectName})`);
  await conn.execOk(
    dockerCmd(config, `compose -p ${shellQuote(projectName)} -f ${shellQuote(composePath)} up -d`, {
      env: { APT_PROXY: config.aptProxy, LAB_IMAGE_TAG: imageTag },
    }),
    { timeoutMs: 60000 },
  );

  const ports = {};
  for (const service of ["source", "destination"]) {
    // Retry port discovery briefly: the container can take a moment to
    // register its published port after `up -d` returns.
    let lastError;
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        const result = await conn.execOk(
          dockerCmd(config, `compose -p ${shellQuote(projectName)} -f ${shellQuote(composePath)} port ${service} 22`),
        );
        ports[service] = parseDockerComposePortOutput(result.stdout);
        lastError = undefined;
        break;
      } catch (error) {
        lastError = error;
        await sleep(500);
      }
    }
    if (lastError) throw lastError;
  }
  log(`published ports: source=${ports.source} destination=${ports.destination}`);

  // Wait for sshd to actually accept TCP connections (container start !=
  // sshd ready) before proceeding, bounded and real (a live TCP probe, not
  // a fixed sleep).
  for (const service of ["source", "destination"]) {
    await waitForTcpOpen(config.host, ports[service], 20000);
  }

  return { projectName, remoteDir, imageTag, composePath, ports };
}

async function downLab(conn, config, lab, log) {
  if (!lab) return;
  try {
    log(`tearing down project ${lab.projectName}`);
    await conn.exec(
      dockerCmd(config, `compose -p ${shellQuote(lab.projectName)} -f ${shellQuote(lab.composePath)} down -v --rmi local`),
      { timeoutMs: 120000 },
    );
  } catch (error) {
    log(`WARNING: docker compose down failed, attempting best-effort force cleanup: ${error.message}`);
    // Best-effort, scoped ONLY to this run's own project-prefixed names —
    // never a broad sweep of other containers on this shared host.
    await conn.exec(dockerCmd(config, `rm -f ${shellQuote(`${lab.projectName}-source-1`)} ${shellQuote(`${lab.projectName}-destination-1`)}`)).catch(() => {});
  }
  try {
    await conn.exec(`rm -rf ${shellQuote(lab.remoteDir)}`);
  } catch (error) {
    log(`WARNING: failed to remove remote scratch dir ${lab.remoteDir}: ${error.message}`);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForTcpOpen(host, port, timeoutMs) {
  const net = require_net();
  const deadline = Date.now() + timeoutMs;
  const attempt = () =>
    new Promise((resolve, reject) => {
      const socket = net.createConnection({ host, port }, () => {
        socket.end();
        resolve();
      });
      socket.once("error", () => {
        socket.destroy();
        reject(new Error("not yet open"));
      });
      socket.setTimeout(2000, () => {
        socket.destroy();
        reject(new Error("connect timeout"));
      });
    });
  const loop = async () => {
    while (Date.now() < deadline) {
      try {
        await attempt();
        return;
      } catch {
        await sleep(300);
      }
    }
    throw new Error(`${host}:${port} did not accept TCP connections within ${timeoutMs}ms`);
  };
  return loop();
}

// node:net import via a small indirection so this stays a single file
// without a top-level import collision with other "net"-shaped names.
import * as nodeNet from "node:net";
function require_net() {
  return nodeNet;
}

// ---------------------------------------------------------------------------
// Local (Windows test process) real SSH/SFTP checks — this is the "test
// process" side of P0-02-A1: a genuine ssh2 client connection from THIS
// machine, over the LAN, to the lab container's published port.
// ---------------------------------------------------------------------------

function connectDirect({ host, port, username, password }) {
  return new Promise((resolve, reject) => {
    const client = new Client();
    client.once("ready", () => resolve(client));
    client.once("error", reject);
    client.connect({ host, port, username, password, readyTimeout: 15000 });
  });
}

function execOnClient(client, command) {
  return new Promise((resolve, reject) => {
    client.exec(command, (err, stream) => {
      if (err) return reject(err);
      let stdout = "";
      let stderr = "";
      stream.on("data", (d) => { stdout += d.toString("utf8"); });
      stream.stderr.on("data", (d) => { stderr += d.toString("utf8"); });
      stream.on("close", (code) => resolve({ code: code ?? 0, stdout, stderr }));
    });
  });
}

function sftpRoundTrip(client, payload, remotePath) {
  return new Promise((resolve, reject) => {
    client.sftp((err, sftp) => {
      if (err) return reject(err);
      const writeStream = sftp.createWriteStream(remotePath);
      writeStream.on("error", reject);
      writeStream.on("close", () => {
        const readStream = sftp.createReadStream(remotePath);
        const chunks = [];
        readStream.on("data", (d) => chunks.push(d));
        readStream.on("error", reject);
        readStream.on("close", () => resolve(Buffer.concat(chunks)));
      });
      writeStream.end(payload);
    });
  });
}

/** Generates a real OpenSSH-format ed25519 keypair via the real `ssh-keygen`
 * binary (guaranteed-correct format; no hand-rolled key encoding). */
function generateKeypair(outDir, name) {
  const keyPath = path.join(outDir, name);
  const result = spawnSync("ssh-keygen", ["-t", "ed25519", "-N", "", "-C", `handfree-sshlab-${name}`, "-f", keyPath], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`ssh-keygen failed for ${name}: ${result.stderr || result.stdout}`);
  }
  return { privateKeyPath: keyPath, publicKeyPath: `${keyPath}.pub` };
}

// ---------------------------------------------------------------------------
// Acceptance checks (P0-02-A1 + the pinned-key / failing-auth fixture checks)
// ---------------------------------------------------------------------------

async function runAcceptance(conn, config, lab, log) {
  const results = { checks: [], artifactsDir: path.join(repoRoot, "artifacts", "ssh-lab") };
  fs.mkdirSync(results.artifactsDir, { recursive: true });

  const record = async (id, fn) => {
    const startedAt = Date.now();
    try {
      const detail = await fn();
      results.checks.push({ id, status: "PASS", durationMs: Date.now() - startedAt, detail });
      log(`[PASS] ${id}`);
    } catch (error) {
      results.checks.push({ id, status: "FAIL", durationMs: Date.now() - startedAt, error: error.message });
      log(`[FAIL] ${id}: ${error.message}`);
      throw error;
    }
  };

  // P0-02-A1: uname + SFTP round-trip with SHA-256, against BOTH containers
  // independently (each is a genuinely separate real sshd).
  for (const service of ["source", "destination"]) {
    await record(`p0-02-a1:${service}:uname+sftp-roundtrip`, async () => {
      const client = await connectDirect({
        host: config.host,
        port: lab.ports[service],
        username: "labuser",
        password: "labtest123",
      });
      try {
        const uname = await execOnClient(client, "uname -a");
        if (uname.code !== 0 || !/Linux/.test(uname.stdout)) {
          throw new Error(`unexpected uname result: code=${uname.code} stdout=${JSON.stringify(uname.stdout)}`);
        }
        const payload = deterministicPayload(`handfree-sshlab-${service}`, 256 * 1024);
        const expectedHash = createHash("sha256").update(payload).digest("hex");
        const downloaded = await sftpRoundTrip(client, payload, `/home/labuser/data/roundtrip-${service}.bin`);
        const actualHash = createHash("sha256").update(downloaded).digest("hex");
        if (actualHash !== expectedHash) {
          throw new Error(`SHA-256 mismatch: expected ${expectedHash}, got ${actualHash}`);
        }
        return { uname: uname.stdout.trim(), bytes: downloaded.length, sha256: actualHash };
      } finally {
        client.end();
      }
    });
  }

  // Pinned test-only key: source -> destination direct access, over the
  // containers' own internal Docker network (service-name DNS).
  await record("p0-02:pinned-key-direct-access-source-to-destination", async () => {
    const result = await conn.execOk(
      dockerCmd(
        config,
        `exec ${shellQuote(`${lab.projectName}-source-1`)} ssh -i /home/labuser/.ssh/id_ed25519_direct ` +
          `-o StrictHostKeyChecking=no -o BatchMode=yes -o ConnectTimeout=5 labuser@destination echo direct-ok`,
      ),
      { timeoutMs: 20000 },
    );
    if (!result.stdout.includes("direct-ok")) {
      throw new Error(`expected 'direct-ok' in output, got: ${JSON.stringify(result.stdout)}`);
    }
    return { stdout: result.stdout.trim() };
  });

  // Deliberately-unauthorized key: must fail, real relay-fallback fixture.
  await record("p0-02:unauthorized-key-genuinely-fails", async () => {
    const result = await conn.exec(
      dockerCmd(
        config,
        `exec ${shellQuote(`${lab.projectName}-source-1`)} ssh -i /home/labuser/.ssh/id_ed25519_wrong ` +
          `-o StrictHostKeyChecking=no -o BatchMode=yes -o ConnectTimeout=5 labuser@destination echo should-not-print`,
      ),
      { timeoutMs: 20000 },
    );
    if (result.code === 0) {
      throw new Error(`expected the unauthorized key to fail, but the command exited 0: ${result.stdout}`);
    }
    return { exitCode: result.code, stderrTail: result.stderr.slice(-300) };
  });

  return results;
}

async function installPinnedKeys(conn, config, lab, log) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "handfree-sshlab-keys-"));
  try {
    const direct = generateKeypair(tmpDir, "id_ed25519_direct");
    const wrong = generateKeypair(tmpDir, "id_ed25519_wrong");
    const sourceContainer = `${lab.projectName}-source-1`;
    const destContainer = `${lab.projectName}-destination-1`;

    log("installing pinned direct-access key on source and destination");
    await conn.sftpUploadFile(direct.privateKeyPath, `${lab.remoteDir}/id_ed25519_direct`);
    await conn.sftpUploadFile(wrong.privateKeyPath, `${lab.remoteDir}/id_ed25519_wrong`);
    const directPublicKey = fs.readFileSync(direct.publicKeyPath, "utf8").trim();

    await conn.execOk(dockerCmd(config, `cp ${shellQuote(`${lab.remoteDir}/id_ed25519_direct`)} ${shellQuote(`${sourceContainer}:/home/labuser/.ssh/id_ed25519_direct`)}`));
    await conn.execOk(dockerCmd(config, `cp ${shellQuote(`${lab.remoteDir}/id_ed25519_wrong`)} ${shellQuote(`${sourceContainer}:/home/labuser/.ssh/id_ed25519_wrong`)}`));
    await conn.execOk(dockerCmd(config, `exec -u root ${shellQuote(sourceContainer)} chown labuser:labuser /home/labuser/.ssh/id_ed25519_direct /home/labuser/.ssh/id_ed25519_wrong`));
    await conn.execOk(dockerCmd(config, `exec -u root ${shellQuote(sourceContainer)} chmod 600 /home/labuser/.ssh/id_ed25519_direct /home/labuser/.ssh/id_ed25519_wrong`));

    // Deliberately NOT authorizing id_ed25519_wrong's public key anywhere —
    // that is the point of the "genuinely fails" fixture.
    await conn.execOk(
      dockerCmd(config, `exec -u root ${shellQuote(destContainer)} sh -c ${shellQuote(`echo ${directPublicKey} >> /home/labuser/.ssh/authorized_keys && chown labuser:labuser /home/labuser/.ssh/authorized_keys`)}`),
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function writeArtifact(artifact) {
  const dir = path.join(repoRoot, "artifacts", "ssh-lab");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "result.json");
  fs.writeFileSync(file, JSON.stringify(artifact, null, 2) + "\n", "utf8");
  return file;
}

async function main() {
  const argv = process.argv.slice(2);
  const [command, subcommand] = argv;
  const logLines = [];
  const log = (line) => {
    const stamped = `[${new Date().toISOString()}] ${line}`;
    logLines.push(stamped);
    process.stderr.write(stamped + "\n");
  };

  if (command !== "test" || subcommand !== "ssh") {
    process.stderr.write("usage: node scripts/ssh-lab.mjs test ssh\n");
    process.exitCode = 1;
    return;
  }

  const config = readLabConfig();
  if (!config.ok) {
    const artifact = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      exitCode: 2,
      classification: "MISSING_REQUIRED_CAPABILITY",
      error: `lab host not configured: missing ${config.missing.join(", ")}`,
      log: logLines,
    };
    log(artifact.error);
    writeArtifact(artifact);
    process.exitCode = 2;
    return;
  }

  const token = randomBytes(4).toString("hex");
  const conn = new LabHostConnection(config);
  // Built up front (pure, no I/O) so that even if the very first remote
  // command fails, the finally block below still knows exactly what
  // project/dir/image this run claimed and can tear it down — found for
  // real during the first live run: a build failure left an orphaned image
  // and scratch dir on the lab host because `lab` was still undefined at
  // that point under the old (upLab-returns-lab) structure.
  let lab = buildLabPaths(config, token);
  let exitCode = 0;
  let classification = "PASS";
  let errorMessage;
  let acceptance;

  try {
    log(`connecting to lab host ${config.host}:${config.port} as ${config.user}`);
    await conn.connect();
    lab = await upLab(conn, config, lab, log);
    await installPinnedKeys(conn, config, lab, log);
    acceptance = await runAcceptance(conn, config, lab, log);
  } catch (error) {
    exitCode = /remote command timed out|did not accept TCP/.test(error.message) ? 3 : 1;
    classification = exitCode === 3 ? "INFRASTRUCTURE_ERROR" : "ASSERTION_FAILURE";
    errorMessage = error.stack ?? String(error);
    log(`ERROR: ${errorMessage}`);
  } finally {
    try {
      if (conn.client) {
        await downLab(conn, config, lab, log);
      }
    } catch (teardownError) {
      log(`WARNING: teardown itself failed: ${teardownError.message}`);
    }
    conn.close();
  }

  const artifact = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    exitCode,
    classification,
    host: config.host,
    projectName: lab?.projectName,
    ports: lab?.ports,
    checks: acceptance?.checks ?? [],
    error: errorMessage,
    log: logLines,
  };
  const artifactPath = writeArtifact(artifact);
  log(`artifact written to ${artifactPath}`);
  process.exitCode = exitCode;
}

// Only run main() when this file is executed directly (`node ssh-lab.mjs
// ...`), not when it's imported for its pure helper exports (e.g. from
// src/tests/ssh-lab.test.ts, which imports this module in a real child
// process purely to exercise buildProjectName/parseDockerComposePortOutput/
// deterministicPayload/shellQuote without touching any live infrastructure).
const isDirectlyExecuted = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectlyExecuted) {
  main().catch((error) => {
    process.stderr.write(`ssh-lab: unhandled error: ${error?.stack ?? error}\n`);
    process.exitCode = 3;
  });
}
