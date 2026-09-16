import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, test } from "node:test";

// PLAN.MD P1-04b. Same split as ssh-lab.test.ts, for the same reason:
//
//  - The statistics and the GATE ARITHMETIC in scripts/benchmark.mjs are pure
//    and decide pass/fail for a release gate, so they are white-box tested
//    here unconditionally. A gate that miscomputes its own threshold is the
//    single worst failure mode this script has -- it would either block a
//    correct implementation or, far worse, certify a speedup that did not
//    happen.
//  - The actual measurement run is NOT here and cannot be. It needs a real
//    Docker host with `tc netem` (PLAN.MD class-B "Linux lab"), and an
//    unshaped in-process number would be evidence of nothing (§7.2, §8.2).
//    That run is its own command: `npm run bench:transfer:release`.
//
// The script's missing-capability contract (no SSH_LAB_* -> exit 2) IS real
// and deterministic without any infrastructure, so it is exercised here as a
// genuine child process.

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..", "..");
const benchmarkScript = path.join(repoRoot, "scripts", "benchmark.mjs");

const mod = await import(pathToFileURL(benchmarkScript).href);
const { median, coefficientOfVariation, throughput, evaluateBandwidthUtilisation, resolveProfile, buildNetemCommand, netemQueueLimitPackets, renderMarkdownReport } = mod;

describe("P1-04b benchmark statistics (pure, white-box)", () => {
  test("median picks the middle of an odd sample and averages the middle pair of an even one", () => {
    assert.equal(median([3, 1, 2]), 2);
    assert.equal(median([5]), 5);
    assert.equal(median([1, 2, 3, 4]), 2.5);
    // Must not mutate the caller's array -- the artifact reports `samples` in
    // run order, and an in-place sort would silently reorder the record of
    // what actually happened.
    const input = [9, 1, 5];
    median(input);
    assert.deepEqual(input, [9, 1, 5]);
  });

  test("median rejects an empty sample rather than returning NaN", () => {
    assert.throws(() => median([]), /non-empty/);
  });

  test("coefficient of variation is population stddev over mean, and a single sample is 0 not NaN", () => {
    assert.equal(coefficientOfVariation([5]), 0);
    assert.equal(coefficientOfVariation([4, 4, 4]), 0);
    // mean 5, population variance ((1+1)/2)=1, stddev 1 -> 0.2
    assert.equal(coefficientOfVariation([4, 6]), 0.2);
  });

  test("the 15% stability threshold in §8.2 lands where the script tests it", () => {
    // Constructed to sit just either side of 0.15 so the comparison operator
    // in main() (`> 0.15`) is pinned, not merely approximated.
    const stable = [100, 100, 100, 100, 115];
    const unstable = [100, 100, 100, 100, 200];
    assert.ok(coefficientOfVariation(stable) <= 0.15, `expected stable, got ${coefficientOfVariation(stable)}`);
    assert.ok(coefficientOfVariation(unstable) > 0.15, `expected unstable, got ${coefficientOfVariation(unstable)}`);
  });

  test("throughput converts bytes and milliseconds to bytes/sec, and refuses a zero interval", () => {
    assert.equal(throughput(1000, 1000), 1000);
    assert.equal(throughput(1024 * 1024, 500), 2 * 1024 * 1024);
    assert.throws(() => throughput(1000, 0), /elapsed must be > 0/);
  });
});

describe("P1-04b bandwidth utilisation (pure, white-box)", () => {
  const SHAPED = 1_000_000_000; // 1 Gbps
  const shapedBytes = SHAPED / 8;

  test("reports the measured throughput as a fraction of the shaped line rate", () => {
    const u = evaluateBandwidthUtilisation({ bytesPerSec: shapedBytes * 0.25, shapedBitsPerSec: SHAPED, rttMs: 50 });
    assert.ok(Math.abs(u.shapedFraction - 0.25) < 1e-9);
  });

  test("implied in-flight bytes and BDP are computed from the SAME rtt, so they are directly comparable", () => {
    // This pair is the whole diagnostic: throughput ~= in-flight / RTT, so a
    // measured throughput implies an in-flight window, and comparing that to
    // the link's BDP says whether the transfer is window-limited. Computing
    // them from different RTTs would silently make that comparison a lie.
    const u = evaluateBandwidthUtilisation({ bytesPerSec: shapedBytes * 0.164, shapedBitsPerSec: SHAPED, rttMs: 50 });
    assert.ok(Math.abs(u.bdpBytes - shapedBytes * 0.05) < 1e-6, `BDP ${u.bdpBytes}`);
    assert.ok(Math.abs(u.impliedInFlightBytes / u.bdpBytes - u.shapedFraction) < 1e-9);
  });

  test("reproduces the real .88 measurement: 19.5 MiB/s on 50ms/1Gbps is ~16% of line rate and ~1 MiB in flight", () => {
    // Anchored to the actual release-profile run recorded in PLAN.MD, so a
    // future refactor that breaks the arithmetic is caught against a number
    // that was genuinely observed rather than one invented for the test.
    const u = evaluateBandwidthUtilisation({ bytesPerSec: 19.5 * 1024 * 1024, shapedBitsPerSec: SHAPED, rttMs: 50 });
    assert.ok(u.shapedFraction > 0.15 && u.shapedFraction < 0.18, `shapedFraction ${u.shapedFraction}`);
    const inFlightMiB = u.impliedInFlightBytes / (1024 * 1024);
    assert.ok(inFlightMiB > 0.9 && inFlightMiB < 1.1, `in-flight ${inFlightMiB} MiB`);
    // And the point of the whole exercise: in-flight is far below the BDP,
    // i.e. window-limited with plenty of headroom left on the link.
    assert.ok(u.impliedInFlightBytes < u.bdpBytes / 5);
  });

  test("an unshaped control run reports 0% rather than dividing by zero", () => {
    const u = evaluateBandwidthUtilisation({ bytesPerSec: 50_000_000, shapedBitsPerSec: 0, rttMs: 50 });
    assert.equal(u.shapedFraction, 0);
    assert.equal(u.bdpBytes, 0);
  });
});

describe("P1-04b profile + shaping resolution (pure, white-box)", () => {
  test("defaults to smoke, and shaping is on unless --no-shaping is passed", () => {
    const profile = resolveProfile([]);
    assert.equal(profile.name, "smoke");
    assert.equal(profile.shaping, true);
    assert.equal(resolveProfile(["--no-shaping"]).shaping, false);
  });

  test("the release profile keeps §8.2's sampling: 1 GiB, warm-up + 5 runs", () => {
    const profile = resolveProfile(["--profile", "release"]);
    assert.equal(profile.name, "release");
    assert.equal(profile.fileBytes, 1024 * 1024 * 1024);
    assert.equal(profile.warmups, 1);
    assert.equal(profile.runs, 5);
  });

  test("an unknown profile fails loudly, and says 'full' is deliberately absent", () => {
    assert.throws(() => resolveProfile(["--profile", "nope"]), /unknown --profile/);
    assert.throws(() => resolveProfile(["--profile", "full"]), /intentionally not implemented/);
  });

  test("the netem command shapes with the delay and rate §8.2 names, and replaces rather than stacks qdiscs", () => {
    const command = buildNetemCommand();
    assert.match(command, /delay 50ms/);
    assert.match(command, /rate 1gbit/);
    assert.match(command, /dev eth0/);
    // `replace` not `add`: a rescheduled group (§8.2 allows up to 3) that ran
    // `add` twice would stack a second qdisc and silently double the shaping,
    // quietly invalidating every number after the first group.
    assert.match(command, /qdisc replace/);
  });

  test("the netem queue is sized above the bandwidth-delay product, not left at the 1000-packet default", () => {
    // Regression test for a real fixture defect: with netem's default queue
    // the first live smoke run got ~1 MiB/s on a 1 Gbps link (both modes),
    // because the queue could not hold the data legitimately in flight and
    // the shaping degenerated into constant packet loss.
    const limit = netemQueueLimitPackets();
    const bdpPackets = ((1_000_000_000 / 8) * 0.05) / 1500; // ~4167
    assert.ok(limit > bdpPackets, `queue limit ${limit} must exceed the BDP of ~${Math.round(bdpPackets)} packets`);
    assert.ok(limit >= 1000, "must never be smaller than netem's own default");
    assert.match(buildNetemCommand(), new RegExp(`limit ${limit}\\b`));
  });

  test("a slower or lower-latency link scales the queue down, but never below netem's default", () => {
    // Proves the limit is actually derived from the link rather than being a
    // magic constant that happens to be big enough for this one case.
    assert.ok(netemQueueLimitPackets(10_000_000_000, 50) > netemQueueLimitPackets(1_000_000_000, 50));
    assert.ok(netemQueueLimitPackets(1_000_000_000, 10) < netemQueueLimitPackets(1_000_000_000, 50));
    assert.equal(netemQueueLimitPackets(1_000_000, 1), 1000);
  });
});

describe("P1-04b report (pure, white-box)", () => {
  const artifact = {
    generatedAt: "2026-09-16T00:00:00.000Z",
    profile: "release",
    exitCode: 0,
    classification: "PASS",
    environment: { commit: "abc", node: "v24.0.0", os: "Windows", arch: "x64", cpu: "Test CPU", labHost: "10.0.0.1" },
    link: { description: "netem 50ms 1gbit", measuredRttMs: 51 },
    payload: { bytes: 1024, sha256: "f".repeat(64) },
    modes: [
      { name: "fast", streams: 1, samples: [1000, 1000, 1000], medianBytesPerSec: 1_048_576, coefficientOfVariation: 0, hashMatched: true },
    ],
    utilisation: { shapedFraction: 0.75, shapedBytesPerSec: 125_000_000, bdpBytes: 6_250_000, impliedInFlightBytes: 4_687_500 },
  };

  test("renders every §8.3-required context field alongside the throughput numbers", () => {
    // §8.3: "没有以上上下文的单个 MB/s 数字不得写进 README" -- the context is
    // the point, so every field it names is asserted present, not just the speed.
    const md = renderMarkdownReport(artifact);
    for (const required of ["abc", "v24.0.0", "Test CPU", "10.0.0.1", "netem 50ms 1gbit", "51 ms", "f".repeat(64)]) {
      assert.ok(md.includes(required), `report is missing required context ${JSON.stringify(required)}:\n${md}`);
    }
    assert.match(md, /75\.0% of the shaped line rate/);
    assert.match(md, /bandwidth-delay/);
  });

  test("the report states it does not gate, so a reader cannot mistake it for a pass/fail verdict", () => {
    const md = renderMarkdownReport(artifact);
    assert.match(md, /reports; it does not gate/);
    assert.match(md, /retired together with striped download/);
  });
});

describe("P1-04b missing-capability contract (real child process)", () => {
  test("without SSH_LAB_HOST the script exits 2 and writes a MISSING_REQUIRED_CAPABILITY artifact, never a fabricated number", () => {
    const artifactDir = path.join(repoRoot, "artifacts", "benchmark");
    const artifactPath = path.join(artifactDir, "result.json");
    const preserved = fs.existsSync(artifactPath) ? fs.readFileSync(artifactPath) : null;
    try {
      const env = { ...process.env };
      delete env.SSH_LAB_HOST;
      delete env.SSH_LAB_USER;
      delete env.SSH_LAB_KEY_PATH;
      delete env.SSH_LAB_PASSWORD;
      const result = spawnSync(process.execPath, [benchmarkScript, "--profile", "smoke"], { env, encoding: "utf8" });

      assert.equal(result.status, 2, `expected exit 2, got ${result.status}. stderr:\n${result.stderr}`);
      const written = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
      assert.equal(written.classification, "MISSING_REQUIRED_CAPABILITY");
      assert.equal(written.exitCode, 2);
      assert.deepEqual(written.modes, [], "a run that never measured anything must report no modes");
      assert.equal(written.utilisation, null, "a run that never measured anything must not report a utilisation figure");
      assert.match(written.error, /SSH_LAB_HOST/);
    } finally {
      if (preserved !== null) fs.writeFileSync(artifactPath, preserved);
    }
  });

  test("an unknown profile is rejected before any lab capability is even considered", () => {
    // Ordering matters: if this returned 2 (missing capability) instead of 1,
    // a typo'd profile on a properly-configured CI runner would be reported
    // as "environment not ready" rather than "you asked for something that
    // does not exist".
    const env = { ...process.env, SSH_LAB_HOST: "", SSH_LAB_USER: "", SSH_LAB_KEY_PATH: "" };
    const result = spawnSync(process.execPath, [benchmarkScript, "--profile", "bogus"], { env, encoding: "utf8" });
    assert.equal(result.status, 1, `expected exit 1, got ${result.status}. stderr:\n${result.stderr}`);
    assert.match(result.stderr, /unknown --profile/);
  });
});
