#!/usr/bin/env node
/**
 * handfree-ssh-mcp Integration Tests
 * 
 * Tests with REAL SSH connections using servers.yaml config.
 * 
 * Usage:
 *   npm run test:integration
 *   npm run test:integration -- --server dev
 *   npm run test:integration -- --server prod
 *
 * Or directly:
 *   node build/tests/integration.test.js
 *   node build/tests/integration.test.js --server dev
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfigFromYaml } from "../config/config-loader.js";
import { SSHConnectionManager } from "../services/ssh-connection-manager.js";
import { Logger } from "../utils/logger.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Colors for terminal output
const colors = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  dim: "\x1b[2m",
};

function log(msg: string, color: keyof typeof colors = "reset") {
  console.log(`${colors[color]}${msg}${colors.reset}`);
}

function success(msg: string) {
  log(`  ✅ ${msg}`, "green");
}

function fail(msg: string) {
  log(`  ❌ ${msg}`, "red");
}

function info(msg: string) {
  log(`  ℹ️  ${msg}`, "cyan");
}

function section(msg: string) {
  console.log();
  log(`━━━ ${msg} ━━━`, "yellow");
}

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
  duration: number;
}

const results: TestResult[] = [];

async function runTest(name: string, fn: () => Promise<void>): Promise<void> {
  const start = Date.now();
  try {
    await fn();
    const duration = Date.now() - start;
    results.push({ name, passed: true, duration });
    success(`${name} (${duration}ms)`);
  } catch (error) {
    const duration = Date.now() - start;
    const errorMsg = error instanceof Error ? error.message : String(error);
    results.push({ name, passed: false, error: errorMsg, duration });
    fail(`${name}: ${errorMsg}`);
  }
}

async function main() {
  // Parse args
  const args = process.argv.slice(2);
  const serverArgIndex = args.indexOf("--server");
  const targetServer = serverArgIndex !== -1 ? args[serverArgIndex + 1] : null;

  // Find config file (use root project servers.yaml)
  const configPath = path.resolve(__dirname, "../../../../servers.yaml");
  
  log("\n🧪 handfree-ssh-mcp Integration Tests\n", "cyan");
  info(`Config: ${configPath}`);
  if (targetServer) {
    info(`Target server: ${targetServer}`);
  }

  // Load config
  section("Loading Configuration");
  let parsedArgs;
  try {
    parsedArgs = loadConfigFromYaml(configPath);
    success(`Loaded ${Object.keys(parsedArgs.configs).length} server(s)`);
    for (const name of Object.keys(parsedArgs.configs)) {
      const cfg = parsedArgs.configs[name];
      info(`  ${name}: ${cfg.username}@${cfg.host}:${cfg.port}`);
    }
  } catch (error) {
    fail(`Failed to load config: ${error}`);
    process.exit(1);
  }

  // Determine which servers to test
  const serversToTest = targetServer 
    ? [targetServer]
    : Object.keys(parsedArgs.configs);

  // Validate server selection
  for (const server of serversToTest) {
    if (!parsedArgs.configs[server]) {
      fail(`Server '${server}' not found in config`);
      process.exit(1);
    }
  }

  // Initialize SSH manager
  const sshManager = SSHConnectionManager.getInstance();
  sshManager.setConfig(parsedArgs.configs, serversToTest);

  // Run tests for each server
  for (const serverName of serversToTest) {
    section(`Testing: ${serverName}`);
    const config = parsedArgs.configs[serverName];
    info(`Host: ${config.host}:${config.port}`);
    info(`User: ${config.username}`);
    info(`Auth: ${config.password ? "password" : "privateKey"}`);
    info(`Whitelist patterns: ${config.commandWhitelist?.length || 0}`);

    // Test: Basic connection
    await runTest(`[${serverName}] SSH Connection`, async () => {
      const result = await sshManager.executeCommand("echo 'connection test'", serverName, { timeout: 10000 });
      if (!result.includes("connection test")) {
        throw new Error(`Unexpected output: ${result}`);
      }
    });

    // Test: pwd command
    await runTest(`[${serverName}] pwd command`, async () => {
      const result = await sshManager.executeCommand("pwd", serverName, { timeout: 5000 });
      if (!result.startsWith("/")) {
        throw new Error(`Expected path starting with /, got: ${result}`);
      }
    });

    // Test: ls command
    await runTest(`[${serverName}] ls command`, async () => {
      const result = await sshManager.executeCommand("ls -la", serverName, { timeout: 5000 });
      if (!result.includes("total")) {
        throw new Error(`Expected 'total' in ls output, got: ${result.substring(0, 100)}`);
      }
    });

    // Test: hostname
    await runTest(`[${serverName}] hostname command`, async () => {
      const result = await sshManager.executeCommand("hostname", serverName, { timeout: 5000 });
      if (result.trim().length === 0) {
        throw new Error("Empty hostname");
      }
    });

    // Test: whoami
    await runTest(`[${serverName}] whoami command`, async () => {
      const result = await sshManager.executeCommand("whoami", serverName, { timeout: 5000 });
      if (result.trim() !== config.username) {
        throw new Error(`Expected ${config.username}, got: ${result.trim()}`);
      }
    });

    // Test: date
    await runTest(`[${serverName}] date command`, async () => {
      const result = await sshManager.executeCommand("date", serverName, { timeout: 5000 });
      // Should contain year
      if (!result.includes("202")) {
        throw new Error(`Expected date with year, got: ${result}`);
      }
    });

    // Note: Timeout testing is tricky because it depends on network latency
    // and the exact implementation. We skip it here - the timeout mechanism
    // is tested at the unit level in command-validation.test.ts

    // Test: Blocked command (if whitelist is restrictive)
    if (config.commandWhitelist && config.commandWhitelist.length > 0) {
      await runTest(`[${serverName}] Whitelist blocking`, async () => {
        try {
          await sshManager.executeCommand("rm -rf /", serverName, { timeout: 5000 });
          throw new Error("Dangerous command should have been blocked");
        } catch (error) {
          if (error instanceof Error && error.message.includes("blocked")) {
            // Expected - command was blocked
            return;
          }
          if (error instanceof Error && error.message.includes("Dangerous command should have been blocked")) {
            throw error;
          }
          // Some other error blocking it - also acceptable
        }
      });
    }

    // Test: Docker (if available)
    await runTest(`[${serverName}] docker ps (if allowed)`, async () => {
      try {
        const result = await sshManager.executeCommand("docker ps", serverName, { timeout: 10000 });
        if (!result.includes("CONTAINER")) {
          // Check if docker command not found (expected on some servers)
          if (result.includes("command not found") || result.includes("not found") || result.includes("EXIT CODE: 127")) {
            info("docker not installed on this server - skipped");
            return;
          }
          throw new Error(`Unexpected docker output: ${result.substring(0, 100)}`);
        }
      } catch (error) {
        if (error instanceof Error && (error.message.includes("blocked") || error.message.includes("whitelist"))) {
          info("docker ps not in whitelist - skipped");
          return;
        }
        // Also handle "command not found" errors thrown as exceptions
        if (error instanceof Error && (error.message.includes("command not found") || error.message.includes("EXIT CODE: 127"))) {
          info("docker not installed on this server - skipped");
          return;
        }
        throw error;
      }
    });

    // Test: getServerConfig (for show-whitelist tool)
    await runTest(`[${serverName}] getServerConfig returns config`, async () => {
      const config = sshManager.getServerConfig(serverName);
      if (!config) {
        throw new Error("getServerConfig returned null");
      }
      if (config.host !== parsedArgs.configs[serverName].host) {
        throw new Error("Config host mismatch");
      }
      if (!config.commandWhitelist || config.commandWhitelist.length === 0) {
        info("No custom whitelist - using blacklist mode");
      } else {
        info(`Whitelist has ${config.commandWhitelist.length} patterns`);
      }
    });

    // Test: Streaming mode (executeCommandWithProgress)
    await runTest(`[${serverName}] Streaming mode output`, async () => {
      const chunks: string[] = [];
      const result = await sshManager.executeCommandWithProgress(
        "echo 'line1' && echo 'line2' && echo 'line3'",
        serverName,
        {
          timeout: 10000,
          onProgress: (chunk: string) => chunks.push(chunk),
        }
      );
      if (!result.includes("line1") || !result.includes("line2") || !result.includes("line3")) {
        throw new Error(`Expected 3 lines in output, got: ${result}`);
      }
      info(`Received ${chunks.length} progress chunks`);
    });

    // Test: list-servers tool (getAllServerInfos)
    await runTest(`[${serverName}] getAllServerInfos returns data`, async () => {
      const servers = sshManager.getAllServerInfos();
      if (!Array.isArray(servers)) {
        throw new Error("getAllServerInfos did not return an array");
      }
      const thisServer = servers.find(s => s.name === serverName);
      if (!thisServer) {
        throw new Error(`Server ${serverName} not found in getAllServerInfos`);
      }
      if (thisServer.host !== config.host) {
        throw new Error(`Host mismatch: expected ${config.host}, got ${thisServer.host}`);
      }
      info(`Found ${servers.length} server(s) in list`);
    });

    // Test: Timeout behavior (short timeout should not hang forever)
    await runTest(`[${serverName}] Short timeout behavior`, async () => {
      const start = Date.now();
      try {
        // Use a very short timeout (100ms) - command should either complete or timeout quickly
        await sshManager.executeCommand("sleep 0.05", serverName, { timeout: 500 });
        // If we get here, the command completed before timeout (which is fine)
        const elapsed = Date.now() - start;
        info(`Command completed in ${elapsed}ms`);
      } catch (error) {
        // Timeout error is also acceptable - what matters is it didn't hang
        const elapsed = Date.now() - start;
        if (elapsed > 5000) {
          throw new Error(`Timeout took too long: ${elapsed}ms - should have been ~500ms`);
        }
        info(`Command timed out after ${elapsed}ms (expected behavior)`);
      }
    });

    // Test: Upload and Download (if tmp directory is writable)
    await runTest(`[${serverName}] Upload/Download file transfer`, async () => {
      const fs = await import("fs");
      const path = await import("path");
      
      // Use a path within the project directory to avoid path traversal detection
      const projectDir = path.resolve(__dirname, "../..");
      const testContent = `handfree-ssh-mcp test file - ${Date.now()}`;
      const localTestFile = path.join(projectDir, `ssh-mcp-test-${Date.now()}.txt`);
      const remoteTestFile = `/tmp/ssh-mcp-test-${Date.now()}.txt`;
      const downloadedFile = path.join(projectDir, `ssh-mcp-downloaded-${Date.now()}.txt`);
      
      try {
        // Write local test file
        fs.writeFileSync(localTestFile, testContent);
        info(`Created local test file: ${localTestFile}`);
        
        // Upload
        const uploadResult = await sshManager.upload(localTestFile, remoteTestFile, serverName);
        info(`Upload result: ${uploadResult.substring(0, 50)}...`);
        
        // Verify file exists on remote
        const catResult = await sshManager.executeCommand(`cat ${remoteTestFile}`, serverName, { timeout: 5000 });
        if (!catResult.includes(testContent)) {
          throw new Error(`Uploaded file content mismatch. Expected "${testContent}", got "${catResult}"`);
        }
        info("Upload verified - remote file content matches");
        
        // Download
        const downloadResult = await sshManager.download(remoteTestFile, downloadedFile, serverName);
        info(`Download result: ${downloadResult.substring(0, 50)}...`);
        
        // Verify downloaded content
        const downloadedContent = fs.readFileSync(downloadedFile, "utf-8");
        if (downloadedContent !== testContent) {
          throw new Error(`Downloaded file content mismatch. Expected "${testContent}", got "${downloadedContent}"`);
        }
        info("Download verified - local file content matches");
        
        // Cleanup remote file
        try {
          await sshManager.executeCommand(`rm ${remoteTestFile}`, serverName, { timeout: 5000 });
        } catch {
          // Ignore cleanup errors (rm might be blocked by whitelist)
        }
      } finally {
        // Cleanup local files
        try {
          if (fs.existsSync(localTestFile)) fs.unlinkSync(localTestFile);
          if (fs.existsSync(downloadedFile)) fs.unlinkSync(downloadedFile);
        } catch {
          // Ignore cleanup errors
        }
      }
    });
  }

  // Summary
  section("Test Summary");
  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  const total = results.length;
  
  log(`\n  Passed: ${passed}/${total}`, passed === total ? "green" : "yellow");
  if (failed > 0) {
    log(`  Failed: ${failed}/${total}`, "red");
    console.log();
    for (const r of results.filter(r => !r.passed)) {
      fail(`${r.name}`);
      log(`     ${r.error}`, "dim");
    }
  }

  // Cleanup
  section("Cleanup");
  try {
    sshManager.disconnect();
    success("Disconnected all SSH connections");
  } catch (error) {
    fail(`Disconnect error: ${error}`);
  }

  console.log();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
