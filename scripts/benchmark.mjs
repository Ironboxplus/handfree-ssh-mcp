#!/usr/bin/env node
// PLAN.MD P1-04b — real transfer throughput measurement under real shaping.
//
// It stands up the real Docker SSH lab on a real Linux host, shapes the link
// with real `tc netem`, and measures the shipping `fast` download path
// (ssh2 fastGet) end to end, verifying SHA-256 on every single run.
//
// HISTORY, because it explains why this script exists and why it now
// measures only one mode:
//
// This harness was built to adjudicate P1-04-A1 — "striped download must
// reach 1.8x the single-channel `fast` baseline, or 70% of the shaped
// bandwidth". On its first real run it reported the opposite: striped came
// in at 6.9 MiB/s against `fast`'s 16.0 MiB/s, i.e. 2.3x SLOWER. The cause
// was architectural, not tuning: striped opened N SFTP *channels* over ONE
// TCP connection, so it gained no additional congestion window, while its
// per-worker read->write->read loop kept only 4 x 256 KiB in flight against
// fastGet's 64 x 32 KiB. Striped was removed from the product on 2026-09-16
// and P1-04-A1 was retired with it, so there is no longer a ratio gate to
// evaluate and nothing to compare against. See PLAN.MD "P1-04b 执行结果".
//
// What it measures now: throughput of `fast`, plus what fraction of the
// shaped bandwidth that represents. It reports; it does not gate. The
// recorded next question (PLAN.MD P1-04b §五) is whether raising in-flight
// bytes closes the gap to the 6.25 MB bandwidth-delay product — this harness
// is the instrument for answering it.
//
// Statistics follow §8.2: 1 discarded warm-up, then N timed runs, judged on
// the median. If the coefficient of variation exceeds 15% the whole group is
// rescheduled (at most twice, all samples retained); a third unstable group
// exits 3/INFRASTRUCTURE_ERROR, which blocks release without being recorded
// as an implementation failure.
//
// Profiles:
//   --profile smoke     32 MiB, 1 warm-up + 2 runs. Proves the harness works
//                       end to end (lab up, netem applied and verified,
//                       transfer run, hash verified, report written) cheaply.
//   --profile release   1 GiB, 1 warm-up + 5 runs, per §8.2.
//
// `--profile full` from §7.3's script table is NOT implemented; it is the
// nightly cross-matrix, and inventing it before there is a matrix to run
// would be building for a requirement nobody has yet.
//
// Environment: identical SSH_LAB_* variables to scripts/ssh-lab.mjs, whose
// lab lifecycle this script imports rather than duplicating. See that file's
// module doc comment. Requires the compose fixture's `cap_add: NET_ADMIN`
// (added for exactly this script) so `tc` can create a qdisc inside the
// container's own network namespace.
//
// Exit codes (§7.4): 0 pass, 1 assertion/gate failure, 2 missing required
// capability, 3 infrastructure error.

import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  buildLabPaths,
  createLabConnection,
  dockerCmd,
  downLab,
  generateKeypair,
  readLabConfig,
  shellQuote,
  upLab,
} from "./ssh-lab.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

// ---------------------------------------------------------------------------
// Pure helpers (white-box tested in src/tests/benchmark-stats.test.ts)
// ---------------------------------------------------------------------------

/** Pure. Median of a numeric sample. For an even count this averages the two
 * middle values, which is the ordinary definition; §8.2 prescribes 5 runs
 * (odd) for the release profile, so the even branch only ever applies to the
 * cheaper smoke profile. */
export function median(values) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error("median requires a non-empty array");
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Pure. Coefficient of variation (population stddev / mean) as a fraction.
 * §8.2 uses this as the stability test with a 15% threshold. Returns 0 for a
 * single sample -- one sample has no observable spread, and treating it as
 * infinitely unstable would make the smoke profile permanently unstable. */
export function coefficientOfVariation(values) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error("coefficientOfVariation requires a non-empty array");
  }
  if (values.length === 1) return 0;
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  if (mean === 0) return 0;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance) / Math.abs(mean);
}

/** Pure. Throughput in bytes/sec. */
export function throughput(bytes, millis) {
  if (!(millis > 0)) throw new Error(`elapsed must be > 0 ms, got ${millis}`);
  return (bytes * 1000) / millis;
}

/**
 * Pure. What fraction of the shaped line rate the measured throughput
 * represents, plus the in-flight bytes that fraction implies at this RTT.
 *
 * This REPORTS, it does not gate: P1-04-A1's ratio gate was retired together
 * with striped download (see the module doc comment). `impliedInFlightBytes`
 * is the diagnostically useful number -- throughput ~= in-flight / RTT, so
 * comparing it against the link's bandwidth-delay product says directly
 * whether the transfer is window-limited (it is) and by how much.
 */
export function evaluateBandwidthUtilisation({ bytesPerSec, shapedBitsPerSec, rttMs }) {
  const shapedBytesPerSec = shapedBitsPerSec / 8;
  const shapedFraction = shapedBytesPerSec > 0 ? bytesPerSec / shapedBytesPerSec : 0;
  const bdpBytes = shapedBytesPerSec * (rttMs / 1000);
  return {
    shapedFraction,
    shapedBytesPerSec,
    bdpBytes,
    impliedInFlightBytes: bytesPerSec * (rttMs / 1000),
  };
}

/**
 * Pure. The `--sweep` grid.
 *
 * Question it answers: is `fast` limited by how many SFTP requests it keeps
 * outstanding (tunable via sftpConcurrency x chunkSize), or by the SSH
 * CHANNEL's own flow-control window, which ssh2 hardcodes at
 * MAX_WINDOW = 2 MiB with a 1 MiB refill threshold (lib/Channel.js) and does
 * not expose as an option?
 *
 * The two hypotheses make opposite predictions, which is what makes this
 * worth running: if SFTP depth is the limit, throughput rises with
 * concurrency x chunkSize. If the channel window is the limit, throughput is
 * FLAT across the whole grid no matter how much more is requested, because
 * the peer may not send beyond the window regardless of how many SFTP reads
 * are queued.
 *
 * `connections` > 1 runs that many INDEPENDENT SSH connections concurrently,
 * each with its own channel window, and reports aggregate throughput. That is
 * the one thing the grid cannot do within a single connection, and it is
 * exactly the multi-CONNECTION design PLAN.MD originally specified before the
 * implementation substituted multi-channel.
 */
export function buildSweepGrid() {
  return [
    { label: "c16 x 32KiB", sftpConcurrency: 16, chunkSize: 32 * 1024, connections: 1 },
    { label: "c64 x 32KiB (ssh2 default)", sftpConcurrency: 64, chunkSize: 32 * 1024, connections: 1 },
    { label: "c64 x 128KiB", sftpConcurrency: 64, chunkSize: 128 * 1024, connections: 1 },
    { label: "c64 x 512KiB", sftpConcurrency: 64, chunkSize: 512 * 1024, connections: 1 },
    { label: "c256 x 128KiB", sftpConcurrency: 256, chunkSize: 128 * 1024, connections: 1 },
    { label: "c64 x 32KiB x 2 CONNECTIONS", sftpConcurrency: 64, chunkSize: 32 * 1024, connections: 2 },
    { label: "c64 x 32KiB x 4 CONNECTIONS", sftpConcurrency: 64, chunkSize: 32 * 1024, connections: 4 },
    // The SHIPPING feature: one download() call with connections=N, which
    // splits ONE file into N ranges over N connections. The rows above are a
    // proxy (N whole-file downloads in parallel); this is the real thing.
    { label: "PRODUCT connections=2 (single file)", product: 2 },
    { label: "PRODUCT connections=4 (single file)", product: 4 },
    { label: "PRODUCT connections=8 (single file)", product: 8 },
    // The cost of ONE fresh handshake + SFTP open on this link. The PRODUCT
    // rows time setup + data together, while the "x N CONNECTIONS" proxy rows
    // reuse connections warmed by their warm-up run and so time data only;
    // without this number a gap between them cannot be attributed. It is how
    // PLAN.MD P1-04e found that serial setup (~685ms per connection, N of
    // them) was the whole gap -- the product now opens all N concurrently, so
    // its setup should cost about one of these, not N.
    { label: "SETUP ONLY: 1 fresh connection", setup: 1 },
    // Multi-connection UPLOAD (PLAN.MD P1-04f-A4). connections=1 is the
    // shipping single-connection fastPut path, the baseline the others are
    // judged against. Every run overwrites the SAME remote path, so from the
    // second run on the final step is a real OpenSSH posix-rename over an
    // existing file; the SHA-256 is checked inside the container every run.
    { label: "UPLOAD connections=1 (fastPut)", upload: 1 },
    { label: "UPLOAD connections=2", upload: 2 },
    { label: "UPLOAD connections=4", upload: 4 },
    { label: "UPLOAD connections=8", upload: 8 },
    // Multi-connection RELAY (PLAN.MD P1-06-A3): source container ->
    // destination container through this host. connections=1 is the shipping
    // single-connection windowed relay. Only the source's egress is shaped,
    // so the constrained leg is source -> this host, as in download.
    { label: "RELAY connections=1 (windowed relay)", relay: 1 },
    { label: "RELAY connections=2", relay: 2 },
    { label: "RELAY connections=4", relay: 4 },
    { label: "RELAY connections=8", relay: 8 },
  ];
}

const PROFILES = {
  sweep: {
    name: "sweep",
    fileBytes: 128 * 1024 * 1024,
    warmups: 1,
    runs: 3,
  },
  smoke: {
    name: "smoke",
    fileBytes: 32 * 1024 * 1024,
    warmups: 1,
    runs: 2,
  },
  release: {
    name: "release",
    fileBytes: 1024 * 1024 * 1024,
    warmups: 1,
    runs: 5,
  },
};

/** Pure. */
export function resolveProfile(argv) {
  const index = argv.indexOf("--profile");
  const requested = index >= 0 ? argv[index + 1] : "smoke";
  const profile = PROFILES[requested];
  if (!profile) {
    throw new Error(
      `unknown --profile ${JSON.stringify(requested)}; supported: ${Object.keys(PROFILES).join(", ")} ` +
        `(--profile full is intentionally not implemented, see this file's doc comment)`,
    );
  }
  // `--no-shaping` runs the identical harness with netem left off. It exists
  // for ONE purpose: telling "the transfer implementation is slow" apart from
  // "the fixture is slow". Without a control run, a low number is
  // uninterpretable and must not be reported as either. Numbers from it
  // describe an unshaped path, and the artifact records shaping:false so they
  // can never be quoted as a shaped result.
  const shaping = !argv.includes("--no-shaping");
  return { ...profile, shaping };
}

// The shaping this script applies, in one place so the artifact and the
// reported utilisation cannot disagree about what the link actually was.
const NETEM_DELAY_MS = 50;
const NETEM_RATE = "1gbit";
const SHAPED_BITS_PER_SEC = 1_000_000_000;

/**
 * Pure. The packet queue netem must be given so that shaping does not
 * silently turn into packet loss.
 *
 * netem's default `limit` is 1000 packets. The bandwidth-delay product of
 * this link is 1 Gbps x 50 ms = 6.25 MB ~= 4200 full-size packets, so a
 * 1000-packet queue cannot hold even a quarter of the data legitimately in
 * flight: TCP fills the window, netem drops the overflow, and the connection
 * collapses into permanent loss recovery.
 *
 * This is not theoretical. The first real smoke run on the lab host produced
 * ~1 MiB/s on a 1 Gbps link -- roughly 1% of the shaped rate -- for BOTH
 * modes, because of exactly this. Numbers taken under that condition measure
 * netem's queue, not the transfer implementation, and would have made the
 * P1-04-A1 gate meaningless in either direction.
 */
export function netemQueueLimitPackets(bitsPerSec = SHAPED_BITS_PER_SEC, delayMs = NETEM_DELAY_MS, mtu = 1500) {
  const bdpBytes = (bitsPerSec / 8) * (delayMs / 1000);
  // 4x the BDP in packets, floored at netem's own default so this can never
  // make the queue smaller than stock.
  return Math.max(1000, Math.ceil((bdpBytes / mtu) * 4));
}

/** Pure. The `tc` command that shapes a container's egress. Egress is the
 * download data path, which is what P1-04-A1 measures. Kept as a pure
 * function so the exact shaping string is white-box assertable without a
 * container. */
export function buildNetemCommand(iface = "eth0") {
  return `tc qdisc replace dev ${iface} root netem delay ${NETEM_DELAY_MS}ms rate ${NETEM_RATE} limit ${netemQueueLimitPackets()}`;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

/** Pure. §8.3's required report fields, rendered as Markdown. Every number
 * here is accompanied by the context §8.3 demands -- "没有以上上下文的单个
 * MB/s 数字不得写进 README". */
export function renderMarkdownReport(artifact) {
  const mib = (bytesPerSec) => (bytesPerSec / (1024 * 1024)).toFixed(2);
  const lines = [];
  lines.push(`# transfer benchmark — profile \`${artifact.profile}\``);
  lines.push("");
  lines.push(`- generated: ${artifact.generatedAt}`);
  lines.push(`- commit: ${artifact.environment.commit}`);
  lines.push(`- node: ${artifact.environment.node} on ${artifact.environment.os} / ${artifact.environment.arch}`);
  lines.push(`- cpu: ${artifact.environment.cpu}`);
  lines.push(`- client: the MCP host running this script (${artifact.environment.os})`);
  lines.push(`- lab host: ${artifact.environment.labHost} (Docker containers, published ephemeral ports)`);
  lines.push(`- link: ${artifact.link.description}`);
  lines.push(`- measured RTT to the shaped container: ${artifact.link.measuredRttMs ?? "n/a"} ms`);
  lines.push(`- payload: ${artifact.payload.bytes} bytes, source SHA-256 \`${artifact.payload.sha256}\``);
  lines.push("");
  lines.push("| mode | streams | runs | median MiB/s | p50 ms | min ms | max ms | CoV | hash |");
  lines.push("|---|---|---|---|---|---|---|---|---|");
  for (const mode of artifact.modes) {
    lines.push(
      `| ${mode.name} | ${mode.streams} | ${mode.samples.length} | ${mib(mode.medianBytesPerSec)} | ` +
        `${Math.round(median(mode.samples))} | ${Math.round(Math.min(...mode.samples))} | ` +
        `${Math.round(Math.max(...mode.samples))} | ${(mode.coefficientOfVariation * 100).toFixed(1)}% | ` +
        `${mode.hashMatched ? "OK" : "MISMATCH"} |`,
    );
  }
  lines.push("");
  if (artifact.utilisation) {
    const u = artifact.utilisation;
    lines.push(
      `**Utilisation**: ${(u.shapedFraction * 100).toFixed(1)}% of the shaped line rate. ` +
        `Implied in-flight ~${(u.impliedInFlightBytes / (1024 * 1024)).toFixed(2)} MiB against a bandwidth-delay ` +
        `product of ~${(u.bdpBytes / (1024 * 1024)).toFixed(2)} MiB -- the transfer is window-limited whenever the ` +
        `former is well under the latter.`,
    );
  }
  lines.push("");
  lines.push("This run reports; it does not gate. P1-04-A1's ratio gate was retired together with striped download (PLAN.MD P1-04b).");
  lines.push("");
  lines.push(`Classification: ${artifact.classification} (exit ${artifact.exitCode})`);
  return lines.join("\n") + "\n";
}

function writeArtifacts(artifact) {
  const dir = path.join(repoRoot, "artifacts", "benchmark");
  fs.mkdirSync(dir, { recursive: true });
  const jsonPath = path.join(dir, "result.json");
  const mdPath = path.join(dir, "result.md");
  fs.writeFileSync(jsonPath, JSON.stringify(artifact, null, 2) + "\n", "utf8");
  fs.writeFileSync(mdPath, renderMarkdownReport(artifact), "utf8");
  return { jsonPath, mdPath };
}

function gitCommit() {
  try {
    return fs.readFileSync(path.join(repoRoot, ".git", "HEAD"), "utf8").trim();
  } catch {
    return "unknown";
  }
}

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

/**
 * One timed download through the PRODUCT's own TransferService -- not a
 * hand-rolled SFTP loop. Benchmarking a reimplementation would measure code
 * that no user ever runs.
 */
async function timedDownload(transferService, serverName, remotePath, localPath, options) {
  if (fs.existsSync(localPath)) fs.rmSync(localPath);
  const started = process.hrtime.bigint();
  await transferService.download(remotePath, localPath, serverName, options);
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  return elapsedMs;
}

/**
 * Waits for the container to complete a real SSH HANDSHAKE, not merely to
 * accept TCP.
 *
 * upLab's waitForTcpOpen is satisfied by docker-proxy, which accepts the
 * connection before sshd inside the container is listening; the backend then
 * resets it. Driving the lab from Windows hid this, because the round trips
 * involved gave sshd time to finish starting. Running the harness locally on
 * the lab host removed that accidental delay and the race became immediate
 * and reproducible: `SSH connection [bench-source] failed: read ECONNRESET`.
 */
async function waitForSshReady(host, port, username, privateKeyPath, timeoutMs, log) {
  const { Client } = await import("ssh2");
  const privateKey = fs.readFileSync(privateKeyPath);
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    const outcome = await new Promise((resolve) => {
      const client = new Client();
      let settled = false;
      // `on`, not `once`: a failing ssh2 client commonly emits a SECOND error
      // while tearing down, and with a one-shot listener that second event
      // has no handler and becomes an unhandled 'error' that kills the
      // process -- turning this retry loop into a crash on the first attempt,
      // which is exactly what happened on the first local run.
      client.on("error", (error) => {
        if (settled) return;
        settled = true;
        client.destroy();
        resolve({ ok: false, error });
      });
      client.once("ready", () => {
        if (settled) return;
        settled = true;
        client.end();
        resolve({ ok: true });
      });
      client.connect({ host, port, username, privateKey, readyTimeout: 10000 });
    });
    if (outcome.ok) return;
    lastError = outcome.error;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw Object.assign(
    new Error(`container sshd never completed an SSH handshake on ${host}:${port} within ${timeoutMs}ms: ${lastError?.message}`),
    { infrastructure: true },
  );
}

function sha256File(filePath) {
  const hash = createHash("sha256");
  const fd = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(4 * 1024 * 1024);
    let bytesRead;
    while ((bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

/**
 * Runs one mode's warm-up + timed samples, verifying the SHA-256 of EVERY
 * downloaded file (not just the last): a mode that is fast because it
 * silently truncated must fail, and it can only be caught by hashing each
 * run's actual output.
 */
async function measureMode({ transferService, serverName, remotePath, scratchDir, mode, profile, expectedSha256, log }) {
  const localPath = path.join(scratchDir, `bench-${mode.name}.bin`);
  log(`${mode.name}: warm-up x${profile.warmups}`);
  for (let i = 0; i < profile.warmups; i += 1) {
    await timedDownload(transferService, serverName, remotePath, localPath, mode.options);
  }

  const samples = [];
  let hashMatched = true;
  for (let i = 0; i < profile.runs; i += 1) {
    const elapsedMs = await timedDownload(transferService, serverName, remotePath, localPath, mode.options);
    const actual = sha256File(localPath);
    if (actual !== expectedSha256) {
      hashMatched = false;
      throw new Error(
        `${mode.name} run ${i + 1}: SHA-256 mismatch — expected ${expectedSha256}, got ${actual}. ` +
          `A throughput number from a corrupted transfer is meaningless, so this fails the run.`,
      );
    }
    samples.push(elapsedMs);
    log(`${mode.name}: run ${i + 1}/${profile.runs} ${Math.round(elapsedMs)} ms (${(throughput(profile.fileBytes, elapsedMs) / (1024 * 1024)).toFixed(2)} MiB/s)`);
  }
  if (fs.existsSync(localPath)) fs.rmSync(localPath);

  return {
    name: mode.name,
    streams: mode.streams,
    options: mode.options,
    samples,
    hashMatched,
    medianElapsedMs: median(samples),
    medianBytesPerSec: throughput(profile.fileBytes, median(samples)),
    coefficientOfVariation: coefficientOfVariation(samples),
  };
}

/**
 * Median TCP-connect RTT from THIS machine to the container's published
 * port -- i.e. over the exact path the benchmark's transfers take, shaping
 * included.
 *
 * An earlier version ran `ping 127.0.0.1` inside the container, which never
 * touches eth0 and therefore never touches the netem qdisc: it would have
 * reported a sub-millisecond RTT on a link deliberately shaped to 50 ms and
 * put that number in the report as if it meant something.
 */
async function measureRttMs(host, port) {
  const net = await import("node:net");
  const samples = [];
  for (let i = 0; i < 5; i += 1) {
    const started = process.hrtime.bigint();
    const ok = await new Promise((resolve) => {
      const socket = net.createConnection({ host, port }, () => {
        socket.end();
        resolve(true);
      });
      socket.setTimeout(5000, () => { socket.destroy(); resolve(false); });
      socket.once("error", () => { socket.destroy(); resolve(false); });
    });
    if (ok) samples.push(Number(process.hrtime.bigint() - started) / 1e6);
  }
  return samples.length > 0 ? Number(median(samples).toFixed(2)) : null;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const logLines = [];
  const log = (line) => {
    const stamped = `[${new Date().toISOString()}] ${line}`;
    logLines.push(stamped);
    process.stderr.write(stamped + "\n");
  };

  let profile;
  try {
    profile = resolveProfile(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`benchmark: ${error.message}\n`);
    process.exitCode = 1;
    return;
  }

  const config = readLabConfig();
  if (!config.ok) {
    const artifact = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      profile: profile.name,
      exitCode: 2,
      classification: "MISSING_REQUIRED_CAPABILITY",
      error:
        `lab host not configured: missing ${config.missing.join(", ")}. This benchmark CANNOT be run on the ` +
        `dev box: it needs real netem shaping on a real Linux Docker host, and an unshaped localhost number ` +
        `would not be evidence for any gate (§7.2, §8.2).`,
      environment: {},
      link: {},
      payload: {},
      modes: [],
      utilisation: null,
      log: logLines,
    };
    log(artifact.error);
    writeArtifacts(artifact);
    process.exitCode = 2;
    return;
  }

  // The product under test, loaded from the real build output.
  const { SSHConnectionManager } = await import(pathToFileURL(path.join(repoRoot, "build", "services", "ssh-connection-manager.js")).href);

  const token = randomBytes(4).toString("hex");
  const conn = createLabConnection(config);
  let lab = buildLabPaths(config, token);
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "handfree-bench-"));
  const keyDir = fs.mkdtempSync(path.join(os.tmpdir(), "handfree-bench-key-"));
  const manager = SSHConnectionManager.getInstance();

  let exitCode = 0;
  let classification = "PASS";
  let errorMessage;
  let modes = [];
  let utilisation = null;
  let payload = {};
  let measuredRttMs = null;
  let attempts = 0;

  try {
    log((process.env.SSH_LAB_MODE ?? "ssh") === "local" ? `running in LOCAL mode on the lab host itself; containers reachable at ${config.host}` : `connecting to lab host ${config.host}:${config.port} as ${config.user}`);
    await conn.connect();
    lab = await upLab(conn, config, lab, log);

    const containerName = `${lab.projectName}-source-1`;
    // The relay rows (PLAN.MD P1-06-A3) copy source -> destination through
    // this host, so the destination container needs the key too.
    const destinationContainerName = `${lab.projectName}-destination-1`;
    const keypair = generateKeypair(keyDir, "bench");
    // generateKeypair returns PATHS, not key material; the public half has to
    // be read off disk. Only the public half ever leaves this machine.
    const publicKey = fs.readFileSync(keypair.publicKeyPath, "utf8").trim();
    for (const target of [containerName, destinationContainerName]) {
    log(`installing the benchmark public key into ${target}`);
    const install = await conn.exec(
      dockerCmd(
        config,
        `exec ${shellQuote(target)} sh -lc ${shellQuote(
          `printf '%s\\n' ${shellQuote(publicKey)} >> /home/labuser/.ssh/authorized_keys`,
        )}`,
      ),
      { timeoutMs: 30000 },
    );
    if (install.code !== 0) {
      throw Object.assign(
        new Error(`could not install the benchmark public key into ${target} (exit ${install.code}): ${install.stderr?.trim()}`),
        { infrastructure: true },
      );
    }
    }

    // Real shaping. This is the whole reason the benchmark cannot run
    // in-process, and the reason compose.yaml grants NET_ADMIN.
    if (profile.shaping) {
      const netem = buildNetemCommand();
      log(`applying shaping inside ${containerName}: ${netem}`);
      const netemResult = await conn.exec(
        dockerCmd(config, `exec ${shellQuote(containerName)} sh -lc ${shellQuote(netem)}`),
        { timeoutMs: 30000 },
      );
      if (netemResult.code !== 0) {
        throw Object.assign(
          new Error(
            `tc netem could not be applied inside the container (exit ${netemResult.code}): ${netemResult.stderr?.trim()}. ` +
              `This usually means the compose fixture is missing 'cap_add: NET_ADMIN'. Without shaping there is no ` +
              `benchmark to run -- an unshaped number would not test what P1-04-A1 specifies.`,
          ),
          { infrastructure: true },
        );
      }
      // Prove the qdisc is really installed rather than trusting exit 0.
      const qdisc = await conn.exec(
        dockerCmd(config, `exec ${shellQuote(containerName)} sh -lc ${shellQuote("tc qdisc show dev eth0")}`),
        { timeoutMs: 20000 },
      );
      if (!/netem/.test(qdisc.stdout ?? "")) {
        throw Object.assign(
          new Error(`tc reported success but 'tc qdisc show dev eth0' has no netem qdisc: ${JSON.stringify(qdisc.stdout)}`),
          { infrastructure: true },
        );
      }
      log(`shaping active: ${qdisc.stdout.trim()}`);
    } else {
      log("CONTROL RUN: shaping deliberately NOT applied. This run can never satisfy a gate; it exists only to separate fixture cost from implementation cost.");
    }
    measuredRttMs = await measureRttMs(config.host, lab.ports.source);

    // Real payload, generated inside the container from /dev/urandom (not a
    // compressible pattern -- a sparse or zero-filled file would let any
    // compression anywhere in the path invent throughput).
    const remotePath = `/home/labuser/data/bench-${token}.bin`;
    log(`generating a ${profile.fileBytes}-byte random payload inside the container`);
    const gen = await conn.exec(
      dockerCmd(
        config,
        `exec ${shellQuote(containerName)} sh -lc ${shellQuote(
          `head -c ${profile.fileBytes} /dev/urandom > ${remotePath} && chown labuser:labuser ${remotePath} && sha256sum ${remotePath}`,
        )}`,
      ),
      { timeoutMs: 600000 },
    );
    if (gen.code !== 0) {
      throw Object.assign(new Error(`payload generation failed (exit ${gen.code}): ${gen.stderr?.trim()}`), { infrastructure: true });
    }
    const expectedSha256 = (gen.stdout ?? "").trim().split(/\s+/)[0];
    if (!/^[0-9a-f]{64}$/.test(expectedSha256)) {
      throw Object.assign(new Error(`could not read the source SHA-256 from: ${JSON.stringify(gen.stdout)}`), { infrastructure: true });
    }
    payload = { bytes: profile.fileBytes, sha256: expectedSha256, remotePath };
    log(`payload ready, source SHA-256 ${expectedSha256}`);

    const serverName = "bench-source";
    const baseServerConfig = {
      host: config.host,
      port: lab.ports.source,
      username: "labuser",
      privateKey: keypair.privateKeyPath,
      disableSftpPathPolicy: true,
    };
    manager.setConfig(
      { [serverName]: baseServerConfig },
      [serverName],
    );
    log("waiting for the container to complete a real SSH handshake");
    await waitForSshReady(config.host, lab.ports.source, "labuser", keypair.privateKeyPath, 60000, log);
    const transferService = manager.getTransferService();

    if (profile.name === "sweep") {
      const grid = buildSweepGrid();
      log(`sweep: ${grid.length} points x (${profile.warmups} warm-up + ${profile.runs} runs) of ${profile.fileBytes} bytes`);
      const rows = [];
      for (const point of grid) {
        // Each "connection" is a SEPARATE configured server pointing at the
        // same container, so reuseConnection caches one real SSH client per
        // name -- genuinely independent TCP connections and channel windows,
        // not N channels on one connection (which is what was removed).
        const names = [];
        // Not named `config`: that would shadow the lab config dockerCmd()
        // needs below (the upload rows verify SHA-256 inside the container).
        const serverConfigs = {};
        for (let i = 0; i < (point.connections ?? 1); i += 1) {
          const n = `${serverName}-conn${i}`;
          names.push(n);
          serverConfigs[n] = { ...baseServerConfig };
        }
        manager.setConfig(serverConfigs, names);
        const svc = manager.getTransferService();
        const opts = { fast: true, reuseConnection: true, timeout: 1_800_000, sftpConcurrency: point.sftpConcurrency, chunkSize: point.chunkSize };

        if (point.relay) {
          const destinationName = "bench-destination";
          manager.setConfig(
            { ...serverConfigs, [destinationName]: { ...baseServerConfig, port: lab.ports.destination } },
            [...names, destinationName],
          );
          const relaySvc = manager.getTransferService();
          const relayDestPath = `/home/labuser/data/relay-${token}.bin`;
          const runOnceRelay = async () => {
            const started = process.hrtime.bigint();
            await relaySvc.transferBetweenServers(names[0], remotePath, destinationName, relayDestPath, {
              ...(point.relay > 1 ? { connections: point.relay } : {}),
              // Every run must really transfer the same bytes to the same path.
              skipIfIdentical: false,
              timeout: 1_800_000,
            });
            const ms = Number(process.hrtime.bigint() - started) / 1e6;
            const check = await conn.exec(
              dockerCmd(config, `exec ${shellQuote(destinationContainerName)} sha256sum ${shellQuote(relayDestPath)}`),
              { timeoutMs: 120000 },
            );
            const destSha = (check.stdout ?? "").trim().split(/\s+/)[0];
            if (destSha !== expectedSha256) {
              throw new Error(`${point.label}: destination SHA-256 ${destSha} != source ${expectedSha256}`);
            }
            return ms;
          };
          for (let i = 0; i < profile.warmups; i += 1) await runOnceRelay();
          const relaySamples = [];
          for (let i = 0; i < profile.runs; i += 1) relaySamples.push(await runOnceRelay());
          const relayThroughput = throughput(profile.fileBytes, median(relaySamples));
          rows.push({ ...point, connections: point.relay, samples: relaySamples, aggregateBytesPerSec: relayThroughput, perConnectionBytesPerSec: relayThroughput / point.relay });
          log(`  ${point.label.padEnd(40)} ${(relayThroughput / (1024 * 1024)).toFixed(2)} MiB/s (median ${median(relaySamples).toFixed(0)} ms)`);
          manager.disconnect();
          continue;
        }

        if (point.upload) {
          // Generated once per sweep, from the same kind of incompressible
          // random data as the download payload.
          const localUpload = path.join(scratchDir, "upload-source.bin");
          if (!fs.existsSync(localUpload)) {
            fs.writeFileSync(localUpload, randomBytes(profile.fileBytes));
          }
          const uploadSha256 = sha256File(localUpload);
          const remoteUploadPath = `/home/labuser/data/upload-${token}.bin`;
          const runOnceUpload = async () => {
            const started = process.hrtime.bigint();
            await svc.upload(localUpload, remoteUploadPath, names[0], {
              connections: point.upload,
              fast: true,
              // Every run must really transfer: the same bytes land on the
              // same path each time, which skip-if-identical would skip.
              skipIfIdentical: false,
              timeout: 1_800_000,
            });
            const ms = Number(process.hrtime.bigint() - started) / 1e6;
            const check = await conn.exec(
              dockerCmd(config, `exec ${shellQuote(containerName)} sha256sum ${shellQuote(remoteUploadPath)}`),
              { timeoutMs: 120000 },
            );
            const remoteSha = (check.stdout ?? "").trim().split(/\s+/)[0];
            if (remoteSha !== uploadSha256) {
              throw new Error(`${point.label}: remote SHA-256 ${remoteSha} != local ${uploadSha256}`);
            }
            return ms;
          };
          for (let i = 0; i < profile.warmups; i += 1) await runOnceUpload();
          const uploadSamples = [];
          for (let i = 0; i < profile.runs; i += 1) uploadSamples.push(await runOnceUpload());
          const uploadThroughput = throughput(profile.fileBytes, median(uploadSamples));
          rows.push({ ...point, connections: point.upload, samples: uploadSamples, aggregateBytesPerSec: uploadThroughput, perConnectionBytesPerSec: uploadThroughput / point.upload });
          log(`  ${point.label.padEnd(40)} ${(uploadThroughput / (1024 * 1024)).toFixed(2)} MiB/s (median ${median(uploadSamples).toFixed(0)} ms)`);
          manager.disconnect();
          continue;
        }

        if (point.setup) {
          const runOnceSetup = async () => {
            const started = process.hrtime.bigint();
            const opened = [];
            try {
              for (let i = 0; i < point.setup; i += 1) {
                const acquired = await manager.acquireSshClient(names[0], { reuseConnection: false, purpose: "sftp" });
                opened.push(acquired);
                const sftp = await new Promise((resolve, reject) => {
                  acquired.client.sftp((err, wrapper) => (err ? reject(err) : resolve(wrapper)));
                });
                sftp.end();
              }
              return Number(process.hrtime.bigint() - started) / 1e6;
            } finally {
              for (const acquired of opened) acquired.close();
            }
          };
          for (let i = 0; i < profile.warmups; i += 1) await runOnceSetup();
          const setupSamples = [];
          for (let i = 0; i < profile.runs; i += 1) setupSamples.push(await runOnceSetup());
          // Not a throughput: reported as elapsed ms. aggregateBytesPerSec is
          // left 0 so it can never win the "best aggregate" line below.
          rows.push({ ...point, connections: point.setup, samples: setupSamples, aggregateBytesPerSec: 0, perConnectionBytesPerSec: 0 });
          log(`  ${point.label.padEnd(40)} median ${median(setupSamples).toFixed(0)} ms`);
          manager.disconnect();
          continue;
        }

        if (point.product) {
          const runOnceProduct = async () => {
            const local = path.join(scratchDir, "sweep-product.bin");
            if (fs.existsSync(local)) fs.rmSync(local);
            const started = process.hrtime.bigint();
            await svc.download(remotePath, local, names[0], { connections: point.product, timeout: 1_800_000 });
            const ms = Number(process.hrtime.bigint() - started) / 1e6;
            if (sha256File(local) !== expectedSha256) throw new Error(`${point.label}: SHA-256 mismatch`);
            fs.rmSync(local);
            return ms;
          };
          for (let i = 0; i < profile.warmups; i += 1) await runOnceProduct();
          const productSamples = [];
          for (let i = 0; i < profile.runs; i += 1) productSamples.push(await runOnceProduct());
          const productThroughput = throughput(profile.fileBytes, median(productSamples));
          rows.push({ ...point, connections: point.product, samples: productSamples, aggregateBytesPerSec: productThroughput, perConnectionBytesPerSec: productThroughput / point.product });
          log(`  ${point.label.padEnd(30)} ${(productThroughput / (1024 * 1024)).toFixed(2)} MiB/s (median ${median(productSamples).toFixed(0)} ms)`);
          manager.disconnect();
          continue;
        }

        const runOnce = async () => {
          const started = process.hrtime.bigint();
          await Promise.all(names.map(async (n, i) => {
            const local = path.join(scratchDir, `sweep-${i}.bin`);
            if (fs.existsSync(local)) fs.rmSync(local);
            await svc.download(remotePath, local, n, opts);
            if (sha256File(local) !== expectedSha256) throw new Error(`${point.label}: SHA-256 mismatch on connection ${i}`);
            fs.rmSync(local);
          }));
          // Aggregate: every connection pulled the whole payload, so the
          // bytes moved are fileBytes x connections.
          return Number(process.hrtime.bigint() - started) / 1e6;
        };

        for (let i = 0; i < profile.warmups; i += 1) await runOnce();
        const samples = [];
        for (let i = 0; i < profile.runs; i += 1) samples.push(await runOnce());
        const totalBytes = profile.fileBytes * point.connections;
        const aggregate = throughput(totalBytes, median(samples));
        const perConn = aggregate / point.connections;
        rows.push({ ...point, samples, aggregateBytesPerSec: aggregate, perConnectionBytesPerSec: perConn });
        log(
          `  ${point.label.padEnd(30)} aggregate ${(aggregate / (1024 * 1024)).toFixed(2)} MiB/s` +
            (point.connections > 1 ? ` (${(perConn / (1024 * 1024)).toFixed(2)} MiB/s per connection)` : "") +
            ` (median ${median(samples).toFixed(0)} ms)`,
        );
        manager.disconnect();
      }
      modes = rows.map((r) => ({
        name: r.label, streams: r.connections, samples: r.samples, hashMatched: true,
        medianElapsedMs: median(r.samples), medianBytesPerSec: r.aggregateBytesPerSec,
        coefficientOfVariation: coefficientOfVariation(r.samples),
      }));
      utilisation = evaluateBandwidthUtilisation({
        bytesPerSec: Math.max(...rows.map((r) => r.aggregateBytesPerSec)),
        shapedBitsPerSec: profile.shaping ? SHAPED_BITS_PER_SEC : 0,
        // The SHAPED delay, not measuredRttMs. measuredRttMs is a TCP-connect
      // time, and in SSH_LAB_MODE=local it is sub-millisecond (the handshake
      // does not traverse the shaped egress path the bulk data does), which
      // made impliedInFlightBytes/bdpBytes come out ~100x too small and
      // therefore meaningless. measuredRttMs stays in the artifact as
      // context, but the in-flight arithmetic uses the delay actually applied.
      rttMs: profile.shaping ? NETEM_DELAY_MS : (measuredRttMs ?? 0),
      });
      log(`sweep best aggregate = ${(utilisation.impliedInFlightBytes / (1024 * 1024)).toFixed(2)} MiB in flight vs BDP ${(utilisation.bdpBytes / (1024 * 1024)).toFixed(2)} MiB`);
    } else {

    // One mode: the shipping `fast` path. Striped was removed from the
    // product (see the module doc comment), so there is no longer a second
    // mode to compare it against.
    const MODES = [
      { name: "fast", streams: 1, options: { fast: true, reuseConnection: true, timeout: 1_800_000 } },
    ];

    // §8.2: CoV > 15% reschedules the whole group, at most twice more.
    const MAX_ATTEMPTS = 3;
    let unstable = [];
    for (attempts = 1; attempts <= MAX_ATTEMPTS; attempts += 1) {
      modes = [];
      for (const mode of MODES) {
        modes.push(
          await measureMode({ transferService, serverName, remotePath, scratchDir, mode, profile, expectedSha256, log }),
        );
      }
      unstable = modes.filter((m) => m.coefficientOfVariation > 0.15);
      if (unstable.length === 0) break;
      log(
        `attempt ${attempts}: unstable (CoV > 15%): ${unstable.map((m) => `${m.name}=${(m.coefficientOfVariation * 100).toFixed(1)}%`).join(", ")}` +
          (attempts < MAX_ATTEMPTS ? " — rescheduling the whole group" : ""),
      );
    }
    if (unstable.length > 0) {
      throw Object.assign(
        new Error(
          `measurements never stabilised after ${MAX_ATTEMPTS} groups (CoV > 15%: ` +
            `${unstable.map((m) => `${m.name}=${(m.coefficientOfVariation * 100).toFixed(1)}%`).join(", ")}). ` +
            `Per §8.2 this blocks release as an infrastructure problem, and is deliberately NOT recorded as an ` +
            `implementation assertion failure.`,
        ),
        { infrastructure: true },
      );
    }

    const fast = modes.find((m) => m.name === "fast");
    utilisation = evaluateBandwidthUtilisation({
      bytesPerSec: fast.medianBytesPerSec,
      shapedBitsPerSec: profile.shaping ? SHAPED_BITS_PER_SEC : 0,
      // The SHAPED delay, not measuredRttMs. measuredRttMs is a TCP-connect
      // time, and in SSH_LAB_MODE=local it is sub-millisecond (the handshake
      // does not traverse the shaped egress path the bulk data does), which
      // made impliedInFlightBytes/bdpBytes come out ~100x too small and
      // therefore meaningless. measuredRttMs stays in the artifact as
      // context, but the in-flight arithmetic uses the delay actually applied.
      rttMs: profile.shaping ? NETEM_DELAY_MS : (measuredRttMs ?? 0),
    });
    log(
      `fast: median ${(fast.medianBytesPerSec / (1024 * 1024)).toFixed(2)} MiB/s` +
        (profile.shaping
          ? `, ${(utilisation.shapedFraction * 100).toFixed(1)}% of the shaped line rate; implied in-flight ` +
            `${(utilisation.impliedInFlightBytes / (1024 * 1024)).toFixed(2)} MiB vs BDP ${(utilisation.bdpBytes / (1024 * 1024)).toFixed(2)} MiB`
          : " (UNSHAPED control run -- not comparable to a shaped result)"),
    );
    }
  } catch (error) {
    // Mirrors scripts/ssh-lab.mjs's classification: a lab that never came up
    // is an INFRASTRUCTURE_ERROR (exit 3), not an implementation failure.
    // Calling a fixture build timeout an ASSERTION_FAILURE would report "the
    // transfer code failed its gate" when in fact nothing was ever measured.
    const infrastructureShaped = error?.infrastructure === true || /remote command timed out|did not accept TCP/.test(error?.message ?? "");
    exitCode = infrastructureShaped ? 3 : 1;
    classification = exitCode === 3 ? "INFRASTRUCTURE_ERROR" : "ASSERTION_FAILURE";
    errorMessage = error.stack ?? String(error);
    log(`ERROR: ${errorMessage}`);
  } finally {
    try {
      manager.disconnect();
      manager.setConfig({}, undefined);
    } catch { /* best effort */ }
    try {
      if (conn.client) await downLab(conn, config, lab, log);
    } catch (teardownError) {
      log(`WARNING: teardown itself failed: ${teardownError.message}`);
    }
    conn.close();
    fs.rmSync(scratchDir, { recursive: true, force: true });
    fs.rmSync(keyDir, { recursive: true, force: true });
  }

  const artifact = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    profile: profile.name,
    exitCode,
    classification,
    environment: {
      commit: gitCommit(),
      node: process.version,
      os: `${os.type()} ${os.release()}`,
      arch: os.arch(),
      cpu: os.cpus()[0]?.model ?? "unknown",
      labHost: config.host,
      // §P0-02: the client is on Windows across the LAN, so LAN latency is
      // stacked on top of the shaping. Same-session relative comparison is
      // still valid (both modes cross the identical path), but the absolute
      // numbers are NOT a WAN result and must not be quoted as one.
      note: "client is off-host across a LAN; absolute throughput is not a WAN result, only the same-session comparison is meaningful",
    },
    link: {
      description: profile.shaping ? `tc netem on the source container's eth0 egress: delay ${NETEM_DELAY_MS}ms, rate ${NETEM_RATE}, limit ${netemQueueLimitPackets()} packets` : "UNSHAPED CONTROL RUN (--no-shaping): no netem applied; not gate-eligible",
      shaping: profile.shaping,
      delayMs: profile.shaping ? NETEM_DELAY_MS : 0,
      rate: NETEM_RATE,
      shapedBitsPerSec: SHAPED_BITS_PER_SEC,
      measuredRttMs,
    },
    payload,
    modes,
    utilisation,
    attempts,
    error: errorMessage,
    log: logLines,
  };
  const { jsonPath, mdPath } = writeArtifacts(artifact);
  log(`artifacts written to ${jsonPath} and ${mdPath}`);
  process.exitCode = exitCode;
}

const isDirectlyExecuted = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectlyExecuted) {
  main().catch((error) => {
    process.stderr.write(`benchmark: unhandled error: ${error?.stack ?? error}\n`);
    process.exitCode = 3;
  });
}
