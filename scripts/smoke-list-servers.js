#!/usr/bin/env node
/**
 * Real-machine smoke for the list-servers hang fix.
 *
 * Loads OpenSSH config (and optional --config servers.yaml), then:
 *   1. list (cache only) — must return immediately
 *   2. refreshStatus() — must finish within the hard budget (not hang forever)
 *   3. list with verbose status from cache
 *
 * Usage:
 *   node scripts/smoke-list-servers.js
 *   node scripts/smoke-list-servers.js --server 4090
 *   node scripts/smoke-list-servers.js --config ./servers.yaml --server dev
 *   node scripts/smoke-list-servers.js --budget-ms 20000
 *
 * Exit 0 on success, 1 on failure / hang past overall deadline.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfigFromSources } from "../build/config/config-loader.js";
import { SSHConnectionManager } from "../build/services/ssh-connection-manager.js";
import { DEFAULT_STATUS_COLLECT_TIMEOUT_MS } from "../build/utils/status-collector.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const out = { server: null, config: null, budgetMs: 45_000 };
  // Accept both `--server X` and a bare first positional as the server name
  // (npm on Windows sometimes strips flags before the script sees them).
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--server" || a === "-s") out.server = argv[++i];
    else if (a === "--config" || a === "-c") out.config = argv[++i];
    else if (a === "--budget-ms") out.budgetMs = Number(argv[++i]);
    else if (a === "--help" || a === "-h") {
      console.log(`Usage: node scripts/smoke-list-servers.js [--server NAME] [--config path] [--budget-ms N]`);
      process.exit(0);
    } else if (!a.startsWith("-") && !out.server) {
      out.server = a;
    }
  }
  return out;
}

function withDeadline(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      reject(new Error(`${label} exceeded overall deadline of ${ms}ms (still hung)`));
    }, ms);
    promise.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log("=== smoke:list-servers (hang fix) ===");
  console.log(`status collect timeout: ${DEFAULT_STATUS_COLLECT_TIMEOUT_MS}ms`);
  console.log(`overall budget: ${args.budgetMs}ms`);

  const loaded = loadConfigFromSources({
    yamlConfigPath: args.config ?? null,
    loadUserSshConfig: true,
  });
  const names = Object.keys(loaded.configs);
  if (names.length === 0) {
    throw new Error("No SSH servers loaded from OpenSSH config / YAML");
  }

  let enabled = names;
  if (args.server) {
    if (!loaded.configs[args.server]) {
      throw new Error(`Server '${args.server}' not found. Available: ${names.join(", ")}`);
    }
    enabled = [args.server];
  }

  console.log(`servers under test: ${enabled.join(", ")} (of ${names.length} loaded)`);

  const manager = SSHConnectionManager.getInstance();
  manager.setConfig(loaded.configs, enabled);

  // 1) Lean list — pure memory, must be instant
  const t0 = Date.now();
  const lean = manager.getAllServerInfos({ verbose: false });
  const leanMs = Date.now() - t0;
  console.log(`[ok] getAllServerInfos(lean) ${leanMs}ms → ${lean.length} server(s)`);
  if (leanMs > 200) {
    throw new Error(`lean list took ${leanMs}ms — expected <200ms`);
  }

  // 2) refreshStatus — this is the path that used to hang forever
  const t1 = Date.now();
  const results = await withDeadline(
    manager.refreshStatus(args.server ?? undefined),
    args.budgetMs,
    "refreshStatus",
  );
  const refreshMs = Date.now() - t1;
  console.log(`[ok] refreshStatus ${refreshMs}ms`);
  for (const name of enabled) {
    const st = results[name];
    console.log(
      `  - ${name}: reachable=${st?.reachable ?? "missing"} hostname=${st?.hostname ?? "-"} gpus=${st?.gpus?.length ?? 0}`,
    );
  }

  // Hard guarantee: never hang past budget. Soft expectation: finishes well under
  // connect budget (15s) + probe (15s) per host when hosts are healthy.
  if (refreshMs > args.budgetMs) {
    throw new Error(`refreshStatus took ${refreshMs}ms > budget ${args.budgetMs}ms`);
  }

  // 3) Verbose list from cache
  const verbose = manager.getAllServerInfos({ verbose: true });
  const withStatus = verbose.filter((s) => s.status).length;
  console.log(`[ok] getAllServerInfos(verbose) status blocks: ${withStatus}/${verbose.length}`);

  // Cleanup connections so the process can exit cleanly.
  for (const name of enabled) {
    try {
      manager.closeConnection?.(name);
    } catch {
      // ignore
    }
  }
  try {
    manager.disconnect?.();
  } catch {
    // ignore
  }

  console.log("=== smoke PASSED ===");
}

main().catch((err) => {
  console.error("=== smoke FAILED ===");
  console.error(err instanceof Error ? err.stack || err.message : err);
  process.exit(1);
});
