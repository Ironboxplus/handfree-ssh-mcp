#!/usr/bin/env node
// PLAN.MD P0-00 — environment preflight and gate classification.
//
// Checks real, local capabilities (no simulated/stubbed results) and
// classifies each into class A (required in every dev/release environment),
// B (required for the Linux/Windows CI matrix, specifically the P0-02 SSH
// lab), or C (specialised qualification: GPU/CUDA, Slurm, conda, rclone,
// Playwright — only required when a profile/adapter that needs it is
// enabled; Playwright is additionally NOT_APPLICABLE this round because
// PLAN.MD Rev.3 §0 defers Phase 3/4).
//
// Exit code contract (PLAN.MD §7.4):
//   0 = pass                        (every required-class capability PASSed)
//   1 = assertion failure           (bad CLI usage, or the script's own
//                                    output violates its own contract —
//                                    e.g. a NOT_APPLICABLE item with no
//                                    reason string)
//   2 = missing required capability (a required-class item is FAIL or
//                                    NOT_APPLICABLE — NOT_APPLICABLE does not
//                                    satisfy a requirement)
//   3 = infrastructure error        (unexpected exception, or the JSON
//                                    artifact itself could not be written)
//
// The same classification is written into the JSON artifact alongside the
// exit code, per §7.4 ("并在 artifacts/<gate>/result.json 写相同分类").

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

const VALID_CLASSES = ["A", "B", "C"];

function parseArgs(argv) {
  const result = { require: [], json: null, unknown: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--require") {
      const value = argv[++i];
      if (value === undefined) {
        result.unknown.push("--require (missing value)");
        continue;
      }
      for (const piece of value.split(",")) {
        const trimmed = piece.trim().toUpperCase();
        if (trimmed.length > 0) result.require.push(trimmed);
      }
    } else if (arg.startsWith("--require=")) {
      for (const piece of arg.slice("--require=".length).split(",")) {
        const trimmed = piece.trim().toUpperCase();
        if (trimmed.length > 0) result.require.push(trimmed);
      }
    } else if (arg === "--json") {
      result.json = argv[++i] ?? null;
    } else if (arg.startsWith("--json=")) {
      result.json = arg.slice("--json=".length);
    } else {
      result.unknown.push(arg);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Small real-execution helpers (no mocks, no simulated output)
// ---------------------------------------------------------------------------

/**
 * Run a version-probe command. On Windows some CLIs (npm in particular) are
 * `.cmd` shims that spawnSync cannot resolve directly, so this builds one
 * shell-escaped command string and uses shell:true — passing a single string
 * (not an args array) avoids Node's DEP0190 "unescaped concatenation"
 * deprecation warning, and every argument here is a static, script-controlled
 * literal, never external input.
 */
function runCommand(cmd, args) {
  try {
    if (process.platform === "win32") {
      const quoted = [cmd, ...args]
        .map((part) => (/[\s"]/.test(part) ? `"${part.replace(/"/g, '\\"')}"` : part))
        .join(" ");
      return spawnSync(quoted, { shell: true, encoding: "utf8", timeout: 15000 });
    }
    return spawnSync(cmd, args, { encoding: "utf8", timeout: 15000 });
  } catch (error) {
    return { status: null, error, stdout: "", stderr: String(error?.message ?? error) };
  }
}

function firstLine(text) {
  return (text ?? "").split(/\r?\n/).find((line) => line.trim().length > 0)?.trim() ?? "";
}

/** PASS/FAIL a binary purely by whether it ran successfully; never inspects
 * message text for the decision (only the exit code / spawn error), so this
 * works unchanged on a localized OS. */
function probeBinary(cmd, args, { class: cls, id, label }) {
  const result = runCommand(cmd, args);
  const ok = result.status === 0;
  return {
    id,
    class: cls,
    label,
    status: ok ? "PASS" : "FAIL",
    reason: ok ? undefined : `'${cmd}' did not run successfully (exit ${result.status ?? "spawn error"})`,
    details: {
      command: `${cmd} ${args.join(" ")}`,
      exitCode: result.status,
      version: ok ? firstLine(result.stdout) : undefined,
    },
  };
}

function semverAtLeast(actual, required) {
  const a = actual.replace(/^v/, "").split(".").map((n) => parseInt(n, 10) || 0);
  const r = required.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(a.length, r.length); i++) {
    const av = a[i] ?? 0;
    const rv = r[i] ?? 0;
    if (av !== rv) return av > rv;
  }
  return true;
}

/** Real loopback-bind probe: actually opens a TCP server on 127.0.0.1:0 and
 * closes it. No simulation — a genuinely blocked/firewalled loopback stack
 * will genuinely fail this. */
function checkLoopbackBind() {
  return new Promise((resolve) => {
    const server = net.createServer();
    const timer = setTimeout(() => {
      server.close();
      resolve({ ok: false, reason: "listen() on 127.0.0.1:0 did not complete within 3000ms" });
    }, 3000);
    server.once("error", (error) => {
      clearTimeout(timer);
      resolve({ ok: false, reason: `listen() on 127.0.0.1:0 failed: ${error.message}` });
    });
    server.listen(0, "127.0.0.1", () => {
      clearTimeout(timer);
      const address = server.address();
      server.close(() => {
        resolve({ ok: true, port: typeof address === "object" && address ? address.port : undefined });
      });
    });
  });
}

/** Real filesystem-watcher probe: creates a temp directory, watches it with
 * fs.watch, writes into it, and waits for a genuine change event within a
 * bounded timeout. No simulated event is ever injected. */
function checkFilesystemWatcher() {
  return new Promise((resolve) => {
    let dir;
    try {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "handfree-preflight-watch-"));
    } catch (error) {
      resolve({ ok: false, reason: `could not create a temp directory to watch: ${error.message}` });
      return;
    }
    const target = path.join(dir, "probe.txt");
    fs.writeFileSync(target, "initial");
    let settled = false;
    let watcher;
    const cleanup = () => {
      try { watcher?.close(); } catch { /* already closed */ }
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    };
    const finish = (ok, reason) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(ok ? { ok: true } : { ok: false, reason });
    };
    try {
      watcher = fs.watch(dir, () => finish(true));
    } catch (error) {
      finish(false, `fs.watch threw: ${error.message}`);
      return;
    }
    const writeTimer = setTimeout(() => {
      try {
        fs.appendFileSync(target, "-changed");
      } catch (error) {
        finish(false, `could not write into the watched directory: ${error.message}`);
      }
    }, 100);
    const timeoutTimer = setTimeout(() => {
      clearTimeout(writeTimer);
      finish(false, "no fs.watch event observed within 4000ms of a real file write");
    }, 4000);
    // Ensure timers don't keep the process alive if something else fails.
    writeTimer.unref?.();
    timeoutTimer.unref?.();
  });
}

/** Real free-disk-space probe via fs.statfsSync (cross-platform since Node
 * added Windows support), not a shelled-out `df` whose output format would
 * differ per platform/locale. */
function checkDiskSpace(targetDir, minBytes) {
  try {
    const stats = fs.statfsSync(targetDir);
    const freeBytes = stats.bavail * stats.bsize;
    return {
      ok: freeBytes >= minBytes,
      freeBytes,
      reason: freeBytes >= minBytes
        ? undefined
        : `only ${(freeBytes / 1024 / 1024 / 1024).toFixed(2)} GiB free under ${targetDir}, need >= ${(minBytes / 1024 / 1024 / 1024).toFixed(2)} GiB`,
    };
  } catch (error) {
    return { ok: false, reason: `fs.statfsSync('${targetDir}') failed: ${error.message}` };
  }
}

/**
 * Real writable-temp-dir probe: creates a directory under os.tmpdir(),
 * writes a file, reads it back, and removes everything.
 */
function checkWritableTempDir() {
  let dir;
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "handfree-preflight-write-"));
    const file = path.join(dir, "probe.txt");
    const payload = createHash("sha256").update(String(Math.random())).digest("hex");
    fs.writeFileSync(file, payload);
    const readBack = fs.readFileSync(file, "utf8");
    fs.rmSync(dir, { recursive: true, force: true });
    return { ok: readBack === payload, reason: readBack === payload ? undefined : "read-back content mismatch" };
  } catch (error) {
    try { if (dir) fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    return { ok: false, reason: `${os.tmpdir()} is not writable: ${error.message}` };
  }
}

/**
 * Real WSL2-distro probe. `wsl.exe -l -q` writes UTF-16LE to stdout when the
 * output is redirected/piped (a well-known WSL quirk); decoding as UTF-8
 * renders as mojibake on a non-English Windows install, and pattern-matching
 * localized message text (as `wsl --status`'s prose is) is explicitly
 * disallowed. `-l -q` instead prints one distro name per line with no other
 * prose, in any locale, so decoding it as UTF-16LE and counting non-empty
 * lines is a locale-proof capability check.
 */
function checkWslDistro() {
  if (process.platform !== "win32") {
    return { available: false, reason: "WSL is Windows-only", distros: [] };
  }
  const result = spawnSync("wsl.exe", ["-l", "-q"], { encoding: "buffer", timeout: 15000 });
  if (result.error || result.status !== 0) {
    return {
      available: false,
      reason: result.error
        ? `wsl.exe is not available: ${result.error.message}`
        : `wsl.exe -l -q exited ${result.status}`,
      distros: [],
    };
  }
  const distros = result.stdout
    .toString("utf16le")
    .split(/\r?\n/)
    .map((line) => line.replace(/\0/g, "").trim())
    .filter((line) => line.length > 0);
  return {
    available: distros.length > 0,
    reason: distros.length > 0 ? undefined : "wsl.exe -l -q listed 0 distros",
    distros,
  };
}

/** Real Docker + Compose probe: CLI presence is not enough (the daemon may
 * not be running), so this also asks the daemon a real question via
 * `docker info`. */
function checkDocker() {
  const cli = runCommand("docker", ["--version"]);
  if (cli.status !== 0) {
    return { available: false, reason: "docker CLI not found on PATH" };
  }
  const daemon = runCommand("docker", ["info", "--format", "{{.ServerVersion}}"]);
  if (daemon.status !== 0) {
    return { available: false, reason: "docker CLI is present but the daemon did not respond to `docker info`" };
  }
  const compose = runCommand("docker", ["compose", "version"]);
  if (compose.status !== 0) {
    return { available: false, reason: "docker is available but the `compose` plugin is not" };
  }
  return { available: true };
}

// ---------------------------------------------------------------------------
// Class C: opt-in binary detection. Real detection, but status is always
// NOT_APPLICABLE unless a future revision wires an actual enabled profile to
// one of these (see reason strings below) — that is a fact about program
// scope this round, not a fabricated result.
// ---------------------------------------------------------------------------

function detectOptionalBinary(cmd, args) {
  const result = runCommand(cmd, args);
  return { detected: result.status === 0, version: result.status === 0 ? firstLine(result.stdout) : undefined };
}

// ---------------------------------------------------------------------------
// Build the full capability list
// ---------------------------------------------------------------------------

async function buildCapabilities() {
  const capabilities = [];

  // ---- Class A: required in every dev/release environment -----------------
  {
    const required = "24.15.0";
    const ok = semverAtLeast(process.version, required);
    capabilities.push({
      id: "node-version",
      class: "A",
      label: `Node.js >= ${required}`,
      status: ok ? "PASS" : "FAIL",
      reason: ok ? undefined : `running ${process.version}, need >= ${required} (node:sqlite target per PLAN.MD §3.3)`,
      details: { actual: process.version, required: `>=${required}` },
    });
  }

  capabilities.push(probeBinary("npm", ["--version"], { class: "A", id: "npm", label: "npm" }));
  capabilities.push(probeBinary("git", ["--version"], { class: "A", id: "git", label: "git" }));
  capabilities.push(probeBinary("tar", ["--version"], { class: "A", id: "tar", label: "tar" }));

  {
    const writable = checkWritableTempDir();
    capabilities.push({
      id: "writable-temp-dir",
      class: "A",
      label: "writable OS temp directory",
      status: writable.ok ? "PASS" : "FAIL",
      reason: writable.ok ? undefined : writable.reason,
      details: { tmpdir: os.tmpdir() },
    });
  }

  {
    // 2 GiB is a conservative floor for build output, node_modules, transfer
    // fixtures, and archive workspaces (moved to os.tmpdir() in v1.0.19).
    const minBytes = 2 * 1024 * 1024 * 1024;
    const disk = checkDiskSpace(repoRoot, minBytes);
    capabilities.push({
      id: "free-disk-space",
      class: "A",
      label: "free disk space (repo volume)",
      status: disk.ok ? "PASS" : "FAIL",
      reason: disk.ok ? undefined : disk.reason,
      details: { path: repoRoot, freeBytes: disk.freeBytes, minBytes },
    });
  }

  {
    const loopback = await checkLoopbackBind();
    capabilities.push({
      id: "loopback-port-bind",
      class: "A",
      label: "can bind a loopback TCP port",
      status: loopback.ok ? "PASS" : "FAIL",
      reason: loopback.ok ? undefined : loopback.reason,
      details: loopback.ok ? { boundPort: loopback.port } : undefined,
    });
  }

  {
    const watcher = await checkFilesystemWatcher();
    capabilities.push({
      id: "filesystem-watcher",
      class: "A",
      label: `filesystem watcher works on ${process.platform}`,
      status: watcher.ok ? "PASS" : "FAIL",
      reason: watcher.ok ? undefined : watcher.reason,
    });
  }

  // ---- Class B: Linux/Windows CI matrix (P0-02 SSH lab) --------------------
  // On a native Linux host, the checks run directly (no Docker/WSL needed —
  // the host already is the environment). On Windows/macOS dev machines a
  // Linux environment has to be provisioned locally via Docker+Compose or,
  // Windows-only, a WSL2 distro.
  if (process.platform === "linux") {
    capabilities.push({
      id: "linux-lab-environment",
      class: "B",
      label: "Linux environment for the P0-02 SSH lab",
      status: "PASS",
      details: { note: "running natively on Linux; no Docker/WSL provisioning needed" },
    });
    capabilities.push(probeBinary("sshd", ["-V"], { class: "B", id: "linux-lab-openssh-server", label: "OpenSSH server (sshd)" }));
    capabilities.push(probeBinary("rsync", ["--version"], { class: "B", id: "linux-lab-rsync", label: "rsync" }));
    capabilities.push(probeBinary("zstd", ["--version"], { class: "B", id: "linux-lab-zstd", label: "zstd" }));
    capabilities.push(probeBinary("python3", ["-c", "import venv"], { class: "B", id: "linux-lab-python-venv", label: "Python 3 venv module" }));
    {
      const tc = runCommand("tc", ["-Version"]);
      // A real, non-destructive CAP_NET_ADMIN probe: add and immediately
      // remove a netem qdisc on a scratch-safe interface selector. If `tc`
      // itself is missing there is nothing further to probe.
      let capOk = false;
      let capReason = "tc not found";
      if (tc.status === 0 || tc.status === 1 /* some tc builds exit 1 on -Version but still work */) {
        const add = runCommand("tc", ["qdisc", "add", "dev", "lo", "root", "netem", "delay", "1ms"]);
        if (add.status === 0) {
          capOk = true;
          runCommand("tc", ["qdisc", "del", "dev", "lo", "root", "netem"]);
        } else {
          capReason = "tc is present but adding a netem qdisc on lo failed (likely missing CAP_NET_ADMIN)";
        }
      }
      capabilities.push({
        id: "linux-lab-netem-cap-net-admin",
        class: "B",
        label: "tc/netem with CAP_NET_ADMIN",
        status: capOk ? "PASS" : "FAIL",
        reason: capOk ? undefined : capReason,
      });
    }
  } else {
    const docker = checkDocker();
    const wsl = checkWslDistro();
    const labAvailable = docker.available || wsl.available;
    capabilities.push({
      id: "linux-lab-environment",
      class: "B",
      label: "Linux environment for the P0-02 SSH lab (Docker+Compose or WSL2 distro)",
      status: labAvailable ? "PASS" : "FAIL",
      reason: labAvailable
        ? undefined
        : `docker: ${docker.reason}; wsl: ${wsl.reason}`,
      details: { docker, wsl: { available: wsl.available, distros: wsl.distros } },
    });
    // These cannot be checked without something to check them inside; a
    // deeper exec-into-Docker/WSL probe is real future work, not implemented
    // here because there is nothing on this class of host to validate it
    // against yet (implementing it untested would itself be a simulated
    // result, which PLAN.MD §7.2 forbids).
    const insideReason = labAvailable
      ? "a Linux environment is present, but this preflight does not yet probe inside it (see code comment); run P0-02's own SSH-lab bring-up to verify"
      : "no Linux environment (Docker/WSL2 distro) is available on this host to probe inside — see linux-lab-environment";
    for (const [id, label] of [
      ["linux-lab-openssh-server", "OpenSSH server (sshd) inside the Linux lab"],
      ["linux-lab-rsync", "rsync inside the Linux lab"],
      ["linux-lab-zstd", "zstd inside the Linux lab"],
      ["linux-lab-python-venv", "Python 3 venv module inside the Linux lab"],
      ["linux-lab-netem-cap-net-admin", "tc/netem with CAP_NET_ADMIN inside the Linux lab"],
    ]) {
      capabilities.push({ id, class: "B", label, status: "NOT_APPLICABLE", reason: insideReason });
    }
  }

  // ---- Class C: specialised qualification, opt-in ---------------------------
  {
    // `gh` participates in neither build nor test — it backs the one-off
    // reference-repo research clone (PLAN.MD §2.2, already done) and later
    // release-gate PR/artifact automation (P5-03). Appearing in P0-00's own
    // check-list bullet alongside Docker/Playwright does not imply class A
    // (neither of those is A either): only things every dev/release
    // environment needs to build and test are A, and `gh` is not one of
    // them. A contributor without `gh` must not be hard-blocked from running
    // preflight for no reason.
    const gh = detectOptionalBinary("gh", ["--version"]);
    capabilities.push({
      id: "gh",
      class: "C",
      label: "GitHub CLI (gh)",
      status: "NOT_APPLICABLE",
      reason: "gh is only required for release automation (PLAN.MD P5-03), not for building or testing",
      details: gh,
    });
  }
  {
    // PLAN.MD Rev.3 §0 defers Phase 3 (sync) and Phase 4 (WebUI) this round;
    // Playwright backs the WebUI's browser E2E suite, so it is out of scope
    // regardless of whether it happens to be installed.
    const playwright = detectOptionalBinary("npx", ["--no-install", "playwright", "--version"]);
    capabilities.push({
      id: "playwright-browsers",
      class: "C",
      label: "Playwright browsers",
      status: "NOT_APPLICABLE",
      reason: "PLAN.MD Rev.3 §0 defers Phase 4 (WebUI) this round; Playwright is not required until that phase is scheduled",
      details: playwright,
    });
  }
  {
    const nvidia = detectOptionalBinary("nvidia-smi", []);
    capabilities.push({
      id: "gpu-cuda",
      class: "C",
      label: "GPU / CUDA (nvidia-smi)",
      status: "NOT_APPLICABLE",
      reason: "no runProfiles.*.gpu.required profile is configured/enabled this round",
      details: nvidia,
    });
  }
  {
    const slurm = detectOptionalBinary("sbatch", ["--version"]);
    capabilities.push({
      id: "slurm",
      class: "C",
      label: "Slurm (sbatch)",
      status: "NOT_APPLICABLE",
      reason: "no runProfiles.*.environment.type=slurm profile is configured/enabled this round",
      details: slurm,
    });
  }
  {
    const conda = detectOptionalBinary("conda", ["--version"]);
    capabilities.push({
      id: "conda",
      class: "C",
      label: "conda",
      status: "NOT_APPLICABLE",
      reason: "no runProfiles.*.environment.type=conda profile is configured/enabled this round",
      details: conda,
    });
  }
  {
    const rclone = detectOptionalBinary("rclone", ["version"]);
    capabilities.push({
      id: "rclone",
      class: "C",
      label: "rclone (optional external transfer engine)",
      status: "NOT_APPLICABLE",
      reason: "rclone is an optional external engine (PLAN.MD §3.1); no transfer this round selects engine=rclone",
      details: rclone,
    });
  }

  return capabilities;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderTable(capabilities) {
  const rows = capabilities.map((c) => [c.class, c.id, c.status, c.reason ?? ""]);
  const header = ["CLASS", "ID", "STATUS", "REASON"];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const line = (cells) => cells.map((c, i) => String(c).padEnd(widths[i])).join("  ");
  const out = [line(header), line(widths.map((w) => "-".repeat(w)))];
  for (const row of rows) out.push(line(row));
  return out.join("\n");
}

function computeConfigFingerprint({ requiredClasses }) {
  // This is an environment/invocation fingerprint scoped to this script — it
  // identifies "these inputs produced this preflight artifact" for later
  // comparison. It is intentionally NOT the full config-schema fingerprint
  // (instanceId/configRevision/policyFingerprint) described in PLAN.MD §4.2 /
  // §2.2's contracts, which land in P0-03 once src/contracts/ exists.
  let packageVersion = "unknown";
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
    packageVersion = pkg.version ?? "unknown";
  } catch {
    // Leave as "unknown"; this must never throw the whole preflight run.
  }
  const canonical = JSON.stringify({
    packageVersion,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    requiredClasses: [...requiredClasses].sort(),
  });
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);

  if (args.unknown.length > 0) {
    const artifact = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      command: { argv, require: args.require },
      exitCode: 1,
      classification: "ASSERTION_FAILURE",
      error: `unrecognized or malformed argument(s): ${args.unknown.join(", ")}`,
    };
    process.stderr.write(`preflight: ${artifact.error}\n`);
    writeArtifactBestEffort(args.json, artifact);
    process.exitCode = 1;
    return;
  }

  const invalidClasses = args.require.filter((c) => !VALID_CLASSES.includes(c));
  if (invalidClasses.length > 0) {
    const artifact = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      command: { argv, require: args.require },
      exitCode: 1,
      classification: "ASSERTION_FAILURE",
      error: `--require must only contain ${VALID_CLASSES.join("/")}, got: ${invalidClasses.join(", ")}`,
    };
    process.stderr.write(`preflight: ${artifact.error}\n`);
    writeArtifactBestEffort(args.json, artifact);
    process.exitCode = 1;
    return;
  }

  let capabilities;
  try {
    capabilities = await buildCapabilities();
  } catch (error) {
    const artifact = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      command: { argv, require: args.require },
      exitCode: 3,
      classification: "INFRASTRUCTURE_ERROR",
      error: `unexpected exception while running capability checks: ${error?.stack ?? error}`,
    };
    process.stderr.write(`preflight: infrastructure error: ${error?.stack ?? error}\n`);
    writeArtifactBestEffort(args.json, artifact);
    process.exitCode = 3;
    return;
  }

  // Self-consistency assertion: every NOT_APPLICABLE must carry a reason.
  // A violation here is a bug in this script, not an environment fact, so it
  // maps to ASSERTION_FAILURE rather than MISSING_REQUIRED_CAPABILITY.
  const missingReasons = capabilities.filter((c) => c.status === "NOT_APPLICABLE" && !c.reason);
  if (missingReasons.length > 0) {
    const artifact = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      command: { argv, require: args.require },
      exitCode: 1,
      classification: "ASSERTION_FAILURE",
      error: `internal contract violation: NOT_APPLICABLE without a reason: ${missingReasons.map((c) => c.id).join(", ")}`,
      capabilities,
    };
    process.stderr.write(`preflight: ${artifact.error}\n`);
    writeArtifactBestEffort(args.json, artifact);
    process.exitCode = 1;
    return;
  }

  const unmet = capabilities.filter((c) => args.require.includes(c.class) && c.status !== "PASS");
  const classification = unmet.length > 0 ? "MISSING_REQUIRED_CAPABILITY" : "PASS";
  const exitCode = unmet.length > 0 ? 2 : 0;

  const summary = {};
  for (const cls of VALID_CLASSES) {
    const inClass = capabilities.filter((c) => c.class === cls);
    summary[cls] = {
      pass: inClass.filter((c) => c.status === "PASS").length,
      fail: inClass.filter((c) => c.status === "FAIL").length,
      notApplicable: inClass.filter((c) => c.status === "NOT_APPLICABLE").length,
    };
  }

  const artifact = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    command: { argv, require: args.require },
    exitCode,
    classification,
    platform: {
      os: process.platform,
      arch: process.arch,
      release: os.release(),
      hostname: os.hostname(),
    },
    versions: {
      node: process.version,
      npm: capabilities.find((c) => c.id === "npm")?.details?.version,
      git: capabilities.find((c) => c.id === "git")?.details?.version,
      gh: capabilities.find((c) => c.id === "gh")?.details?.version,
      tar: capabilities.find((c) => c.id === "tar")?.details?.version,
    },
    configFingerprint: computeConfigFingerprint({ requiredClasses: args.require }),
    capabilities,
    summary,
    unmetRequired: unmet.map((c) => c.id),
  };

  process.stdout.write(renderTable(capabilities) + "\n\n");
  process.stdout.write(
    `require=[${args.require.join(",") || "(none)"}] classification=${classification} exitCode=${exitCode}\n`,
  );

  const writeOutcome = writeArtifact(args.json, artifact);
  if (!writeOutcome.ok) {
    // The requested artifact destination is itself broken (e.g. a parent
    // path component is a file, or the volume is unwritable) — a genuine
    // infrastructure error, not a missing/failed capability. Still attempt a
    // fallback write to os.tmpdir() so the classification and full
    // capability data remain discoverable (by a human or a test) instead of
    // vanishing along with the primary write failure.
    artifact.exitCode = 3;
    artifact.classification = "INFRASTRUCTURE_ERROR";
    artifact.error = `failed to write JSON artifact to '${writeOutcome.path}': ${writeOutcome.error}`;
    process.stderr.write(`preflight: ${artifact.error}\n`);
    const fallbackPath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "handfree-preflight-fallback-")),
      "result.json",
    );
    const fallbackOutcome = writeArtifact(fallbackPath, artifact);
    if (fallbackOutcome.ok) {
      process.stderr.write(`preflight: fallback artifact written to ${fallbackOutcome.path}\n`);
    } else {
      process.stderr.write(`preflight: fallback artifact write also failed: ${fallbackOutcome.error}\n`);
    }
    process.exitCode = 3;
    return;
  }
  process.stdout.write(`artifact written to ${writeOutcome.path}\n`);

  process.exitCode = exitCode;
}

function defaultArtifactPath() {
  return path.join(repoRoot, "artifacts", "preflight", "result.json");
}

function writeArtifact(jsonArg, artifact) {
  const target = jsonArg ? path.resolve(process.cwd(), jsonArg) : defaultArtifactPath();
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(artifact, null, 2) + "\n", "utf8");
    return { ok: true, path: target };
  } catch (error) {
    return { ok: false, error: error?.message ?? String(error), path: target };
  }
}

/** Used on early-exit (usage/infra error) paths: best-effort so a failure to
 * write the artifact there doesn't mask the original, more specific error by
 * overwriting process.exitCode. */
function writeArtifactBestEffort(jsonArg, artifact) {
  const outcome = writeArtifact(jsonArg, artifact);
  if (!outcome.ok) {
    process.stderr.write(`preflight: (best-effort) could not also write JSON artifact: ${outcome.error}\n`);
  } else {
    process.stderr.write(`preflight: artifact written to ${outcome.path}\n`);
  }
}

main().catch((error) => {
  process.stderr.write(`preflight: unhandled error: ${error?.stack ?? error}\n`);
  process.exitCode = 3;
});
