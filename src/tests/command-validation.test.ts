/**
 * Command Validation Tests
 * 
 * Tests the whitelist/blacklist pattern matching logic
 * without requiring actual SSH connections.
 */

import { afterEach, describe, it } from "node:test";
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fsForTest from "node:fs";
import { SSHConnectionManager } from "../services/ssh-connection-manager.js";
import { ToolError } from "../utils/tool-error.js";

/**
 * Simulate the whitelist/blacklist checking logic
 * (extracted from ssh-connection-manager.ts for testing)
 */
function isCommandAllowed(
  command: string,
  whitelist: string[],
  blacklist: string[] = []
): { allowed: boolean; matchedPattern?: string; reason?: string } {
  
  // Check whitelist - command must match one pattern to be allowed
  let matchesWhitelist = false;
  let matchedWhitelistPattern: string | undefined;
  
  for (const pattern of whitelist) {
    try {
      const regex = new RegExp(pattern);
      if (regex.test(command)) {
        matchesWhitelist = true;
        matchedWhitelistPattern = pattern;
        break;
      }
    } catch {
      // Invalid regex pattern, skip
    }
  }
  
  if (!matchesWhitelist) {
    return {
      allowed: false,
      reason: `Command does not match any whitelist pattern: "${command}"`
    };
  }
  
  // Check blacklist - command must NOT match any pattern
  for (const pattern of blacklist) {
    try {
      const regex = new RegExp(pattern);
      if (regex.test(command)) {
        return {
          allowed: false,
          matchedPattern: pattern,
          reason: `Command matches blacklist pattern: ${pattern}`
        };
      }
    } catch {
      // Invalid regex pattern, skip
    }
  }
  
  return {
    allowed: true,
    matchedPattern: matchedWhitelistPattern
  };
}

describe("Whitelist Patterns", () => {
  const basicWhitelist = [
    "^ls( .*)?$",
    "^cat .*$",
    "^pwd$",
    "^docker ps.*$",
    "^docker logs.*$",
    "^git .*$",
  ];

  it("should allow 'ls' command", () => {
    const result = isCommandAllowed("ls", basicWhitelist);
    assert.strictEqual(result.allowed, true);
  });

  it("should allow 'ls -la' command", () => {
    const result = isCommandAllowed("ls -la", basicWhitelist);
    assert.strictEqual(result.allowed, true);
  });

  it("should allow 'ls /var/log' command", () => {
    const result = isCommandAllowed("ls /var/log", basicWhitelist);
    assert.strictEqual(result.allowed, true);
  });

  it("should allow 'cat /etc/hosts' command", () => {
    const result = isCommandAllowed("cat /etc/hosts", basicWhitelist);
    assert.strictEqual(result.allowed, true);
  });

  it("should allow 'pwd' command", () => {
    const result = isCommandAllowed("pwd", basicWhitelist);
    assert.strictEqual(result.allowed, true);
  });

  it("should allow 'docker ps' command", () => {
    const result = isCommandAllowed("docker ps", basicWhitelist);
    assert.strictEqual(result.allowed, true);
  });

  it("should allow 'docker ps -a' command", () => {
    const result = isCommandAllowed("docker ps -a", basicWhitelist);
    assert.strictEqual(result.allowed, true);
  });

  it("should allow 'docker logs mycontainer' command", () => {
    const result = isCommandAllowed("docker logs mycontainer", basicWhitelist);
    assert.strictEqual(result.allowed, true);
  });

  it("should allow 'docker logs -f --tail 100 myapp' command", () => {
    const result = isCommandAllowed("docker logs -f --tail 100 myapp", basicWhitelist);
    assert.strictEqual(result.allowed, true);
  });

  it("should allow 'git status' command", () => {
    const result = isCommandAllowed("git status", basicWhitelist);
    assert.strictEqual(result.allowed, true);
  });

  it("should allow 'git pull' command", () => {
    const result = isCommandAllowed("git pull", basicWhitelist);
    assert.strictEqual(result.allowed, true);
  });

  it("should BLOCK 'rm -rf /' command", () => {
    const result = isCommandAllowed("rm -rf /", basicWhitelist);
    assert.strictEqual(result.allowed, false);
  });

  it("should BLOCK 'shutdown' command", () => {
    const result = isCommandAllowed("shutdown", basicWhitelist);
    assert.strictEqual(result.allowed, false);
  });

  it("should BLOCK 'reboot' command", () => {
    const result = isCommandAllowed("reboot", basicWhitelist);
    assert.strictEqual(result.allowed, false);
  });

  it("should BLOCK unknown commands", () => {
    const result = isCommandAllowed("some-random-command --with-args", basicWhitelist);
    assert.strictEqual(result.allowed, false);
  });
});

describe("Blacklist Patterns", () => {
  const permissiveWhitelist = ["^.*$"]; // Allow everything
  const dangerousBlacklist = [
    "^rm .*$",
    "^rmdir .*$",
    "^shutdown.*$",
    "^reboot.*$",
    "^dd .*$",
    "^mkfs.*$",
  ];

  it("should allow 'ls' with permissive whitelist", () => {
    const result = isCommandAllowed("ls", permissiveWhitelist, dangerousBlacklist);
    assert.strictEqual(result.allowed, true);
  });

  it("should BLOCK 'rm file' even with permissive whitelist", () => {
    const result = isCommandAllowed("rm file", permissiveWhitelist, dangerousBlacklist);
    assert.strictEqual(result.allowed, false);
  });

  it("should BLOCK 'rm -rf /' with blacklist", () => {
    const result = isCommandAllowed("rm -rf /", permissiveWhitelist, dangerousBlacklist);
    assert.strictEqual(result.allowed, false);
  });

  it("should BLOCK 'shutdown -h now' with blacklist", () => {
    const result = isCommandAllowed("shutdown -h now", permissiveWhitelist, dangerousBlacklist);
    assert.strictEqual(result.allowed, false);
  });

  it("should BLOCK 'reboot' with blacklist", () => {
    const result = isCommandAllowed("reboot", permissiveWhitelist, dangerousBlacklist);
    assert.strictEqual(result.allowed, false);
  });

  it("should BLOCK 'dd if=/dev/zero of=/dev/sda' with blacklist", () => {
    const result = isCommandAllowed("dd if=/dev/zero of=/dev/sda", permissiveWhitelist, dangerousBlacklist);
    assert.strictEqual(result.allowed, false);
  });
});

describe("Combined Whitelist and Blacklist", () => {
  // Allow docker commands but block dangerous ones
  const whitelist = [
    "^docker .*$",
    "^git .*$",
  ];
  const blacklist = [
    "^docker rm .*$",
    "^docker rmi .*$",
    "^docker system prune.*$",
    "^git push --force.*$",
  ];

  it("should allow 'docker ps'", () => {
    const result = isCommandAllowed("docker ps", whitelist, blacklist);
    assert.strictEqual(result.allowed, true);
  });

  it("should allow 'docker logs app'", () => {
    const result = isCommandAllowed("docker logs app", whitelist, blacklist);
    assert.strictEqual(result.allowed, true);
  });

  it("should BLOCK 'docker rm container'", () => {
    const result = isCommandAllowed("docker rm container", whitelist, blacklist);
    assert.strictEqual(result.allowed, false);
  });

  it("should BLOCK 'docker rmi image'", () => {
    const result = isCommandAllowed("docker rmi image", whitelist, blacklist);
    assert.strictEqual(result.allowed, false);
  });

  it("should BLOCK 'docker system prune -af'", () => {
    const result = isCommandAllowed("docker system prune -af", whitelist, blacklist);
    assert.strictEqual(result.allowed, false);
  });

  it("should allow 'git status'", () => {
    const result = isCommandAllowed("git status", whitelist, blacklist);
    assert.strictEqual(result.allowed, true);
  });

  it("should allow 'git push origin main'", () => {
    const result = isCommandAllowed("git push origin main", whitelist, blacklist);
    assert.strictEqual(result.allowed, true);
  });

  it("should BLOCK 'git push --force origin main'", () => {
    const result = isCommandAllowed("git push --force origin main", whitelist, blacklist);
    assert.strictEqual(result.allowed, false);
  });
});

describe("Regex Edge Cases", () => {
  const whitelist = [
    "^ls( .*)?$",      // ls with optional args
    "^cat .+$",         // cat requires an argument
    "^echo .*$",        // echo with any args
  ];

  it("should match 'ls' without args", () => {
    const result = isCommandAllowed("ls", whitelist);
    assert.strictEqual(result.allowed, true);
  });

  it("should match 'ls -la /var'", () => {
    const result = isCommandAllowed("ls -la /var", whitelist);
    assert.strictEqual(result.allowed, true);
  });

  it("should BLOCK 'cat' without args (requires .+)", () => {
    const result = isCommandAllowed("cat", whitelist);
    assert.strictEqual(result.allowed, false);
  });

  it("should match 'cat file.txt'", () => {
    const result = isCommandAllowed("cat file.txt", whitelist);
    assert.strictEqual(result.allowed, true);
  });

  it("should match 'echo' (echo .* matches empty)", () => {
    const result = isCommandAllowed("echo ", whitelist);
    assert.strictEqual(result.allowed, true);
  });

  it("should match 'echo hello world'", () => {
    const result = isCommandAllowed("echo hello world", whitelist);
    assert.strictEqual(result.allowed, true);
  });

  it("should BLOCK command with leading space", () => {
    const result = isCommandAllowed(" ls", whitelist);
    assert.strictEqual(result.allowed, false); // ^ anchor requires start
  });

  it("should BLOCK command with trailing content beyond pattern", () => {
    // Pattern is ^ls( .*)?$ - the $ requires end
    const result = isCommandAllowed("lsblk", whitelist);
    assert.strictEqual(result.allowed, false);
  });
});

describe("Special Characters in Commands", () => {
  const whitelist = [
    "^echo .*$",
    "^cat .*$",
  ];

  it("should allow echo with quotes", () => {
    const result = isCommandAllowed('echo "hello world"', whitelist);
    assert.strictEqual(result.allowed, true);
  });

  it("should allow echo with single quotes", () => {
    const result = isCommandAllowed("echo 'hello world'", whitelist);
    assert.strictEqual(result.allowed, true);
  });

  it("should allow cat with path containing spaces (quoted)", () => {
    const result = isCommandAllowed('cat "/path/with spaces/file.txt"', whitelist);
    assert.strictEqual(result.allowed, true);
  });
});

/**
 * Test the destructive pattern matching logic
 * (extracted from ssh-connection-manager.ts for testing)
 */
function getDestructiveMatch(command: string): string | null {
  const destructivePatterns: Array<{ regex: RegExp; reason: string }> = [
    { regex: /\brm\b/, reason: "rm in command chain" },
    { regex: /\brmdir\b/, reason: "rmdir in command chain" },
    { regex: /\bunlink\b/, reason: "unlink in command chain" },
    { regex: /\bshred\b/, reason: "shred in command chain" },
    { regex: /\btruncate\b/, reason: "truncate in command chain" },
    { regex: /-delete\b/, reason: "find -delete detected" },
    { regex: /-exec\s+rm\b/, reason: "find -exec rm detected" },
    { regex: /\bdd\b.*\bof=/, reason: "dd with of= (can overwrite files)" },
    { regex: /\bmv\b/, reason: "mv detected (can overwrite)" },
    { regex: /\bcp\b.*-f/, reason: "cp -f detected (force overwrite)" },
    // Allow stderr redirection to /dev/null (2>/dev/null, 2>&1>/dev/null, etc.)
    // Block dangerous writes like: echo x > /etc/passwd, cat > /bin/bash
    { regex: /(?<![0-9])>\s*\/(?!dev\/null)/, reason: "output redirection to absolute path" },
    { regex: />\s*~/, reason: "output redirection to home path" },
  ];
  
  for (const { regex, reason } of destructivePatterns) {
    if (regex.test(command)) {
      return reason;
    }
  }
  return null;
}

describe("Destructive Pattern Detection", () => {
  it("should ALLOW 'find ... 2>/dev/null | head -5' (stderr to /dev/null is safe)", () => {
    const cmd = 'find /var/mobile/Library/Logs -name "*log*" 2>/dev/null | head -5';
    const result = getDestructiveMatch(cmd);
    assert.strictEqual(result, null, `Should allow stderr to /dev/null but got: ${result}`);
  });

  it("should ALLOW 'apt search vnc 2>/dev/null || true'", () => {
    const cmd = "dpkg -l | grep -i vnc; apt search vnc 2>/dev/null || true";
    const result = getDestructiveMatch(cmd);
    assert.strictEqual(result, null, `Should allow stderr to /dev/null but got: ${result}`);
  });

  it("should ALLOW 'cat file 2>/dev/null || echo fallback'", () => {
    const cmd = 'cat /var/mobile/Library/Preferences/file.plist 2>/dev/null || echo "not found"';
    const result = getDestructiveMatch(cmd);
    assert.strictEqual(result, null, `Should allow stderr to /dev/null but got: ${result}`);
  });

  it("should ALLOW '2>&1 > /dev/null' pattern", () => {
    const cmd = "some_command 2>&1 >/dev/null";
    const result = getDestructiveMatch(cmd);
    assert.strictEqual(result, null, `Should allow redirect to /dev/null but got: ${result}`);
  });

  it("should BLOCK 'echo x > /etc/passwd' (dangerous write)", () => {
    const cmd = 'echo "hacked" > /etc/passwd';
    const result = getDestructiveMatch(cmd);
    assert.strictEqual(result, "output redirection to absolute path", `Should block dangerous redirect`);
  });

  it("should BLOCK 'cat malware > /bin/bash' (dangerous write)", () => {
    const cmd = "cat malware > /bin/bash";
    const result = getDestructiveMatch(cmd);
    assert.strictEqual(result, "output redirection to absolute path", `Should block dangerous redirect`);
  });

  it("should BLOCK '> /tmp/file' (stdout redirect to absolute path)", () => {
    const cmd = "echo test > /tmp/file";
    const result = getDestructiveMatch(cmd);
    assert.strictEqual(result, "output redirection to absolute path", `Should block stdout redirect`);
  });

  it("should BLOCK 'rm -rf /' command", () => {
    const result = getDestructiveMatch("rm -rf /");
    assert.strictEqual(result, "rm in command chain");
  });

  it("should BLOCK 'echo test && rm file' (hidden rm)", () => {
    const result = getDestructiveMatch("echo test && rm file");
    assert.strictEqual(result, "rm in command chain");
  });

  it("should BLOCK 'find -delete' pattern", () => {
    const result = getDestructiveMatch("find /tmp -name '*.log' -delete");
    assert.strictEqual(result, "find -delete detected");
  });

  it("should BLOCK 'find -exec rm' pattern", () => {
    const result = getDestructiveMatch("find /tmp -type f -exec rm {} \\;");
    // Note: rm word boundary pattern matches first, which is also correct
    assert.ok(result !== null, "Should block find -exec rm");
    assert.ok(result.includes("rm"), `Should be blocked due to rm, got: ${result}`);
  });

  it("should BLOCK 'dd of=' pattern", () => {
    const result = getDestructiveMatch("dd if=/dev/zero of=/dev/sda bs=4M");
    assert.strictEqual(result, "dd with of= (can overwrite files)");
  });

  it("should BLOCK '> ~/' (home path redirect)", () => {
    const result = getDestructiveMatch("echo test > ~/file");
    assert.strictEqual(result, "output redirection to home path");
  });
});

describe("SSHConnectionManager regressions", () => {
  const manager = SSHConnectionManager.getInstance() as any;

  const baseConfig = (overrides: Record<string, unknown> = {}) => ({
    name: "dev",
    host: "127.0.0.1",
    port: 22,
    username: "root",
    password: "test-password",
    safeDirectory: "/root",
    ...overrides,
  });

  afterEach(() => {
    manager.disconnect();
    manager.setConfig({}, undefined);
  });

  it("should require safe rm to still match the whitelist", () => {
    manager.setConfig(
      {
        dev: baseConfig({
          commandWhitelist: ["^pwd$"],
        }),
      },
      ["dev"],
    );

    const result = manager.validateCommand("rm /root/test-file", "dev");
    assert.strictEqual(result.isAllowed, false);
    assert.match(result.reason ?? "", /whitelist/i);
  });

  it("should let blacklist override a safe rm command", () => {
    manager.setConfig(
      {
        dev: baseConfig({
          commandWhitelist: ["^rm .*$"],
          commandBlacklist: ["^rm .*$"],
        }),
      },
      ["dev"],
    );

    const result = manager.validateCommand("rm /root/test-file", "dev");
    assert.strictEqual(result.isAllowed, false);
    assert.match(result.reason ?? "", /blacklist/i);
  });

  it("should allow safe rm only when it passes policy checks", () => {
    manager.setConfig(
      {
        dev: baseConfig({
          commandWhitelist: ["^rm .*$"],
        }),
      },
      ["dev"],
    );

    const result = manager.validateCommand("rm /root/test-file", "dev");
    assert.strictEqual(result.isAllowed, true);
  });

  it("should not retry command timeout errors", async () => {
    manager.setConfig(
      {
        dev: baseConfig({
          commandWhitelist: ["^pwd$"],
        }),
      },
      ["dev"],
    );

    const originalEnsureConnected = manager.ensureConnected;
    const originalRunCommandStream = manager.runCommandStream;
    const originalReconnect = manager.reconnect;
    const originalCreateLogWriter = manager.createLogWriter;
    let executeCalls = 0;
    let reconnectCalls = 0;

    manager.ensureConnected = async () => ({}) as any;
    manager.createLogWriter = () => null; // skip disk writes in this test
    manager.runCommandStream = async () => {
      executeCalls += 1;
      throw new ToolError("COMMAND_TIMEOUT", "timed out", false);
    };
    manager.reconnect = async () => {
      reconnectCalls += 1;
    };

    try {
      await assert.rejects(
        () => manager.executeCommand("pwd", "dev", { timeout: 1, maxRetries: 2 }),
        (error: unknown) => error instanceof ToolError && error.code === "COMMAND_TIMEOUT",
      );
      assert.strictEqual(executeCalls, 1);
      assert.strictEqual(reconnectCalls, 0);
    } finally {
      manager.ensureConnected = originalEnsureConnected;
      manager.runCommandStream = originalRunCommandStream;
      manager.reconnect = originalReconnect;
      manager.createLogWriter = originalCreateLogWriter;
    }
  });

  it("should continue retrying SSH connection failures", async () => {
    manager.setConfig(
      {
        dev: baseConfig({
          commandWhitelist: ["^pwd$"],
        }),
      },
      ["dev"],
    );

    const originalEnsureConnected = manager.ensureConnected;
    const originalRunCommandStream = manager.runCommandStream;
    const originalReconnect = manager.reconnect;
    const originalCreateLogWriter = manager.createLogWriter;
    let executeCalls = 0;
    let reconnectCalls = 0;

    manager.ensureConnected = async () => ({}) as any;
    manager.createLogWriter = () => null;
    manager.runCommandStream = async (
      _cmd: string,
      _client: unknown,
      _timeout: number,
      sinks: { stdoutCollector?: { push(c: string): void } },
    ) => {
      executeCalls += 1;
      if (executeCalls === 1) {
        throw new ToolError("SSH_CONNECTION_FAILED", "socket closed", true);
      }
      sinks.stdoutCollector?.push("ok");
      return 0;
    };
    manager.reconnect = async () => {
      reconnectCalls += 1;
    };

    try {
      const result = await manager.executeCommand("pwd", "dev", { timeout: 1, maxRetries: 1 });
      assert.strictEqual(result, "ok");
      assert.strictEqual(executeCalls, 2);
      assert.strictEqual(reconnectCalls, 1);
    } finally {
      manager.ensureConnected = originalEnsureConnected;
      manager.runCommandStream = originalRunCommandStream;
      manager.reconnect = originalReconnect;
      manager.createLogWriter = originalCreateLogWriter;
    }
  });

  it("should pre-connect only enabled servers", async () => {
    manager.setConfig(
      {
        dev: baseConfig({ name: "dev" }),
        prod: baseConfig({ name: "prod", host: "127.0.0.2" }),
      },
      ["dev"],
    );

    const originalConnect = manager.connect;
    const connectedNames: string[] = [];
    manager.connect = async (name?: string) => {
      connectedNames.push(name ?? manager.defaultName);
    };

    try {
      await manager.connectAll();
      assert.deepStrictEqual(connectedNames, ["dev"]);
    } finally {
      manager.connect = originalConnect;
    }
  });

  it("should throw a structured validation error for blocked commands", async () => {
    manager.setConfig(
      {
        dev: baseConfig({
          commandWhitelist: ["^pwd$"],
        }),
      },
      ["dev"],
    );

    await assert.rejects(
      () => manager.executeCommand("whoami", "dev", { maxRetries: 0 }),
      (error: unknown) =>
        error instanceof ToolError
        && error.code === "COMMAND_VALIDATION_FAILED"
        && /whitelist/i.test(error.message),
    );
  });

  it("should throw a structured local-path error before upload starts", async () => {
    manager.setConfig(
      {
        dev: baseConfig(),
      },
      ["dev"],
    );

    await assert.rejects(
      () => manager.upload("..\\outside-file.txt", "/tmp/outside-file.txt", "dev"),
      (error: unknown) => error instanceof ToolError && error.code === "LOCAL_PATH_NOT_ALLOWED",
    );
  });

  it("should throw a structured authentication error when no auth method is configured", async () => {
    manager.setConfig(
      {
        dev: {
          name: "dev",
          host: "127.0.0.1",
          port: 22,
          username: "root",
          safeDirectory: "/root",
        },
      },
      ["dev"],
    );

    await assert.rejects(
      () => manager.connect("dev"),
      (error: unknown) => error instanceof ToolError && error.code === "SSH_AUTHENTICATION_MISSING",
    );
  });
});

describe("SFTP path validators", () => {
  const manager = SSHConnectionManager.getInstance() as any;

  const baseConfig = (overrides: Record<string, unknown> = {}) => ({
    name: "dev",
    host: "127.0.0.1",
    port: 22,
    username: "root",
    password: "test-password",
    ...overrides,
  });

  afterEach(() => {
    manager.disconnect();
    manager.setConfig({}, undefined);
  });

  // -------- validateRemotePath --------

  it("should reject SFTP when allowedRemoteDirectories is unset", () => {
    manager.setConfig({ dev: baseConfig() }, ["dev"]);
    assert.throws(
      () => manager.validateRemotePath("/home/test/file.txt", "dev"),
      (e: unknown) =>
        e instanceof ToolError &&
        e.code === "REMOTE_PATH_NOT_ALLOWED" &&
        /no 'allowedRemoteDirectories' configured/.test(e.message),
    );
  });

  it("should reject SFTP when allowedRemoteDirectories is empty", () => {
    manager.setConfig(
      { dev: baseConfig({ allowedRemoteDirectories: [] }) },
      ["dev"],
    );
    assert.throws(
      () => manager.validateRemotePath("/home/test/file.txt", "dev"),
      (e: unknown) => e instanceof ToolError && e.code === "REMOTE_PATH_NOT_ALLOWED",
    );
  });

  it("should accept a remote path inside an allowed directory", () => {
    manager.setConfig(
      { dev: baseConfig({ allowedRemoteDirectories: ["/home/test", "/tmp"] }) },
      ["dev"],
    );
    assert.strictEqual(
      manager.validateRemotePath("/home/test/sub/file.txt", "dev"),
      "/home/test/sub/file.txt",
    );
    assert.strictEqual(
      manager.validateRemotePath("/tmp/file.txt", "dev"),
      "/tmp/file.txt",
    );
  });

  it("should accept an exact-match remote directory path", () => {
    manager.setConfig(
      { dev: baseConfig({ allowedRemoteDirectories: ["/home/test"] }) },
      ["dev"],
    );
    assert.strictEqual(
      manager.validateRemotePath("/home/test", "dev"),
      "/home/test",
    );
  });

  it("should reject a remote path outside the allowed directories", () => {
    manager.setConfig(
      { dev: baseConfig({ allowedRemoteDirectories: ["/home/test"] }) },
      ["dev"],
    );
    assert.throws(
      () => manager.validateRemotePath("/etc/passwd", "dev"),
      (e: unknown) =>
        e instanceof ToolError &&
        e.code === "REMOTE_PATH_NOT_ALLOWED" &&
        /not inside any allowedRemoteDirectories/.test(e.message),
    );
  });

  it("should reject a prefix-match-but-different-directory remote path", () => {
    // "/home/testing/x" must NOT match allowed root "/home/test"
    manager.setConfig(
      { dev: baseConfig({ allowedRemoteDirectories: ["/home/test"] }) },
      ["dev"],
    );
    assert.throws(
      () => manager.validateRemotePath("/home/testing/x", "dev"),
      (e: unknown) => e instanceof ToolError && e.code === "REMOTE_PATH_NOT_ALLOWED",
    );
  });

  it("should reject relative remote paths", () => {
    manager.setConfig(
      { dev: baseConfig({ allowedRemoteDirectories: ["/home/test"] }) },
      ["dev"],
    );
    assert.throws(
      () => manager.validateRemotePath("home/test/file.txt", "dev"),
      (e: unknown) =>
        e instanceof ToolError &&
        e.code === "REMOTE_PATH_NOT_ALLOWED" &&
        /absolute POSIX path/.test(e.message),
    );
  });

  it("should reject '..' segments in remote paths", () => {
    manager.setConfig(
      { dev: baseConfig({ allowedRemoteDirectories: ["/home/test"] }) },
      ["dev"],
    );
    assert.throws(
      () => manager.validateRemotePath("/home/test/../etc/passwd", "dev"),
      (e: unknown) => e instanceof ToolError && e.code === "REMOTE_PATH_NOT_ALLOWED",
    );
  });

  it("should reject null bytes in remote paths", () => {
    manager.setConfig(
      { dev: baseConfig({ allowedRemoteDirectories: ["/home/test"] }) },
      ["dev"],
    );
    assert.throws(
      () => manager.validateRemotePath("/home/test/file\0.txt", "dev"),
      (e: unknown) => e instanceof ToolError && e.code === "REMOTE_PATH_NOT_ALLOWED",
    );
  });

  it("should allow any path under root '/' when '/' is in allowedRemoteDirectories", () => {
    manager.setConfig(
      { dev: baseConfig({ allowedRemoteDirectories: ["/"] }) },
      ["dev"],
    );
    assert.strictEqual(
      manager.validateRemotePath("/etc/hosts", "dev"),
      "/etc/hosts",
    );
  });

  // -------- validateLocalPath --------

  it("should accept a local path inside process.cwd() by default", () => {
    manager.setConfig({ dev: baseConfig() }, ["dev"]);
    const cwdFile = process.cwd() + (process.platform === "win32" ? "\\test.txt" : "/test.txt");
    assert.strictEqual(
      manager.validateLocalPath(cwdFile, "dev"),
      cwdFile,
    );
  });

  it("should accept a local path inside an allowedLocalDirectories entry", () => {
    // Use the temp dir of the OS as an allowed directory
    const tmp = path.resolve(os.tmpdir());

    manager.setConfig(
      { dev: baseConfig({ allowedLocalDirectories: [tmp] }) },
      ["dev"],
    );

    const file = path.join(tmp, "handfree-test-file.txt");
    assert.strictEqual(manager.validateLocalPath(file, "dev"), file);
  });

  it("should reject a local path outside cwd and outside allowedLocalDirectories", () => {
    const tmp = path.resolve(os.tmpdir());

    manager.setConfig({ dev: baseConfig() }, ["dev"]); // no allowedLocalDirectories
    const file = path.join(tmp, "handfree-test-rejected.txt");

    // Skip the case where tmpdir is somehow inside cwd (rare on Windows)
    if (!file.startsWith(process.cwd() + path.sep) && file !== process.cwd()) {
      assert.throws(
        () => manager.validateLocalPath(file, "dev"),
        (e: unknown) =>
          e instanceof ToolError &&
          e.code === "LOCAL_PATH_NOT_ALLOWED" &&
          /not inside any allowed directory/.test(e.message),
      );
    }
  });
});

describe("Upload CRLF auto-fix", () => {
  // Access the private static helper via 'any' for testing.
  const helper = (SSHConnectionManager as any).maybeFixShellScriptLineEndings as (
    localPath: string,
    buffer: Buffer,
  ) => { buffer: Buffer; fixed: boolean; replacedCount: number };

  it("should convert CRLF to LF for .sh files", () => {
    const input = Buffer.from("#!/bin/sh\r\necho hi\r\n", "utf8");
    const result = helper("/x/script.sh", input);
    assert.strictEqual(result.fixed, true);
    assert.strictEqual(result.replacedCount, 2);
    assert.strictEqual(result.buffer.toString("utf8"), "#!/bin/sh\necho hi\n");
  });

  it("should convert CRLF to LF for .bash files", () => {
    const input = Buffer.from("a\r\nb\r\nc", "utf8");
    const result = helper("/x/run.bash", input);
    assert.strictEqual(result.fixed, true);
    assert.strictEqual(result.replacedCount, 2);
    assert.strictEqual(result.buffer.toString("utf8"), "a\nb\nc");
  });

  it("should convert CRLF to LF for .zsh files (case-insensitive)", () => {
    const input = Buffer.from("a\r\nb", "utf8");
    const result = helper("/x/run.ZSH", input);
    assert.strictEqual(result.fixed, true);
    assert.strictEqual(result.replacedCount, 1);
  });

  it("should NOT touch .sh files that already have LF only", () => {
    const input = Buffer.from("#!/bin/sh\necho hi\n", "utf8");
    const result = helper("/x/script.sh", input);
    assert.strictEqual(result.fixed, false);
    assert.strictEqual(result.replacedCount, 0);
    assert.strictEqual(result.buffer, input); // same buffer instance
  });

  it("should NOT touch non-shell-script extensions even with CRLF", () => {
    const input = Buffer.from("a\r\nb\r\n", "utf8");
    const result = helper("/x/data.txt", input);
    assert.strictEqual(result.fixed, false);
    assert.strictEqual(result.replacedCount, 0);
  });

  it("should NOT touch files with no extension", () => {
    const input = Buffer.from("a\r\nb\r\n", "utf8");
    const result = helper("/x/Makefile", input);
    assert.strictEqual(result.fixed, false);
  });

  it("should preserve lone CR (not part of CRLF)", () => {
    const input = Buffer.from("a\rb\r\nc", "utf8");
    const result = helper("/x/run.sh", input);
    assert.strictEqual(result.fixed, true);
    assert.strictEqual(result.replacedCount, 1);
    assert.strictEqual(result.buffer.toString("utf8"), "a\rb\nc");
  });

  it("should preserve binary bytes outside of CRLF sequences", () => {
    const input = Buffer.from([0xff, 0x0d, 0x0a, 0x80, 0x0d, 0x0a]);
    const result = helper("/x/blob.sh", input);
    assert.strictEqual(result.fixed, true);
    assert.strictEqual(result.replacedCount, 2);
    assert.deepStrictEqual(
      Array.from(result.buffer),
      [0xff, 0x0a, 0x80, 0x0a],
    );
  });
});

describe("Upload skip-if-identical", () => {
  const manager = SSHConnectionManager.getInstance() as any;

  const baseConfig = (overrides: Record<string, unknown> = {}) => ({
    name: "dev",
    host: "127.0.0.1",
    port: 22,
    username: "root",
    password: "test-password",
    allowedRemoteDirectories: ["/tmp"],
    ...overrides,
  });

  let tempFile: string;

  afterEach(() => {
    manager.disconnect();
    manager.setConfig({}, undefined);
    if (tempFile && fsForTest.existsSync(tempFile)) {
      fsForTest.unlinkSync(tempFile);
    }
  });

  function writeLocal(content: Buffer | string, ext = ".txt"): string {
    const name = `handfree-upload-test-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`;
    // Place inside cwd so it passes validateLocalPath without extra config
    tempFile = path.resolve(process.cwd(), name);
    fsForTest.writeFileSync(tempFile, content);
    return tempFile;
  }

  it("should skip upload when remote content matches (small file)", async () => {
    manager.setConfig({ dev: baseConfig() }, ["dev"]);

    const local = writeLocal(Buffer.from("hello world", "utf8"));

    // Stub: ensureConnected returns a sentinel client; sftp ops return identical bytes
    manager.ensureConnected = async () => ({}) as any;
    manager.openSftp = async () => ({ end: () => {} }) as any;
    manager.sftpStat = async () => ({ size: Buffer.byteLength("hello world") });
    manager.sftpReadBuffer = async () => Buffer.from("hello world", "utf8");

    let writeCalled = false;
    manager.sftpWriteBuffer = async () => { writeCalled = true; };

    const result = await manager.upload(local, "/tmp/file.txt", "dev");
    assert.match(result, /Upload skipped/);
    assert.match(result, /identical-content/);
    assert.strictEqual(writeCalled, false);
  });

  it("should re-upload when skipIfIdentical=false even if remote matches", async () => {
    manager.setConfig({ dev: baseConfig() }, ["dev"]);

    const local = writeLocal(Buffer.from("hello world", "utf8"));

    manager.ensureConnected = async () => ({}) as any;
    manager.openSftp = async () => ({ end: () => {} }) as any;
    manager.sftpStat = async () => ({ size: Buffer.byteLength("hello world") });
    manager.sftpReadBuffer = async () => Buffer.from("hello world", "utf8");

    let writeCalled = false;
    manager.sftpWriteBuffer = async () => { writeCalled = true; };

    const result = await manager.upload(local, "/tmp/file.txt", "dev", { skipIfIdentical: false });
    assert.match(result, /File uploaded successfully/);
    assert.strictEqual(writeCalled, true);
  });

  it("should upload when remote is missing", async () => {
    manager.setConfig({ dev: baseConfig() }, ["dev"]);

    const local = writeLocal(Buffer.from("payload", "utf8"));

    manager.ensureConnected = async () => ({}) as any;
    manager.openSftp = async () => ({ end: () => {} }) as any;
    manager.sftpStat = async () => { throw new ToolError("SFTP_ERROR", "no such file", false); };

    let writeCalled = false;
    manager.sftpWriteBuffer = async () => { writeCalled = true; };

    const result = await manager.upload(local, "/tmp/file.txt", "dev");
    assert.match(result, /File uploaded successfully/);
    assert.strictEqual(writeCalled, true);
  });

  it("should upload when sizes differ", async () => {
    manager.setConfig({ dev: baseConfig() }, ["dev"]);

    const local = writeLocal(Buffer.from("hello", "utf8"));

    manager.ensureConnected = async () => ({}) as any;
    manager.openSftp = async () => ({ end: () => {} }) as any;
    manager.sftpStat = async () => ({ size: 999 });

    let writeCalled = false;
    manager.sftpWriteBuffer = async () => { writeCalled = true; };

    const result = await manager.upload(local, "/tmp/file.txt", "dev");
    assert.match(result, /File uploaded successfully/);
    assert.strictEqual(writeCalled, true);
  });

  it("should upload when content differs at same size", async () => {
    manager.setConfig({ dev: baseConfig() }, ["dev"]);

    const local = writeLocal(Buffer.from("hello", "utf8"));

    manager.ensureConnected = async () => ({}) as any;
    manager.openSftp = async () => ({ end: () => {} }) as any;
    manager.sftpStat = async () => ({ size: 5 });
    manager.sftpReadBuffer = async () => Buffer.from("world", "utf8");

    let writeCalled = false;
    manager.sftpWriteBuffer = async () => { writeCalled = true; };

    const result = await manager.upload(local, "/tmp/file.txt", "dev");
    assert.match(result, /File uploaded successfully/);
    assert.strictEqual(writeCalled, true);
  });

  it("should report CRLF auto-fix in the response for .sh uploads", async () => {
    manager.setConfig({ dev: baseConfig() }, ["dev"]);

    const local = writeLocal(Buffer.from("#!/bin/sh\r\necho hi\r\n", "utf8"), ".sh");

    manager.ensureConnected = async () => ({}) as any;
    manager.openSftp = async () => ({ end: () => {} }) as any;
    manager.sftpStat = async () => { throw new ToolError("SFTP_ERROR", "missing", false); };

    let written: Buffer | null = null;
    manager.sftpWriteBuffer = async (_c: unknown, _p: string, payload: Buffer) => { written = payload; };

    const result = await manager.upload(local, "/tmp/file.sh", "dev");
    assert.match(result, /CRLF.{0,3}LF auto-fix/);
    assert.match(result, /converted 2 line endings/);
    assert.ok(written, "payload should have been written");
    assert.strictEqual((written as Buffer).toString("utf8"), "#!/bin/sh\necho hi\n");
  });

  it("should reject upload of a directory path", async () => {
    manager.setConfig({ dev: baseConfig() }, ["dev"]);

    // Use cwd itself (a directory) as the local path
    const dirPath = process.cwd();

    manager.ensureConnected = async () => ({}) as any;

    await assert.rejects(
      () => manager.upload(dirPath, "/tmp/whatever", "dev"),
      (e: unknown) =>
        e instanceof ToolError &&
        e.code === "LOCAL_FILE_READ_FAILED" &&
        /not a regular file/i.test(e.message),
    );
  });
});

describe("Upload shell-script line-ending-agnostic compare", () => {
  // Integration through the real upload() method. The underlying byte-level
  // CRLF→LF normalization is already exercised by "Upload CRLF auto-fix" above,
  // so we only assert the end-to-end skip / re-upload behavior here.
  const manager = SSHConnectionManager.getInstance() as any;

  const baseConfig = (overrides: Record<string, unknown> = {}) => ({
    name: "dev",
    host: "127.0.0.1",
    port: 22,
    username: "root",
    password: "test-password",
    allowedRemoteDirectories: ["/tmp"],
    ...overrides,
  });

  let tempFile: string;

  afterEach(() => {
    manager.disconnect();
    manager.setConfig({}, undefined);
    if (tempFile && fsForTest.existsSync(tempFile)) {
      fsForTest.unlinkSync(tempFile);
    }
  });

  function writeLocal(content: Buffer | string, ext: string): string {
    const name = `handfree-shellcmp-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`;
    tempFile = path.resolve(process.cwd(), name);
    fsForTest.writeFileSync(tempFile, content);
    return tempFile;
  }

  it("should skip .sh upload when remote has the same content but with CRLF endings", async () => {
    // Local script has LF (or is fixed to LF before compare).
    // Remote currently stores the same logical content but with CRLF.
    manager.setConfig({ dev: baseConfig() }, ["dev"]);

    const local = writeLocal(Buffer.from("#!/bin/sh\necho hi\n", "utf8"), ".sh");
    const remoteRaw = Buffer.from("#!/bin/sh\r\necho hi\r\n", "utf8");

    manager.ensureConnected = async () => ({}) as any;
    manager.openSftp = async () => ({ end: () => {} }) as any;
    manager.sftpStat = async () => ({ size: remoteRaw.length });
    manager.sftpReadBuffer = async () => remoteRaw;

    let writeCalled = false;
    manager.sftpWriteBuffer = async () => { writeCalled = true; };

    const result = await manager.upload(local, "/tmp/run.sh", "dev");
    assert.match(result, /Upload skipped/);
    assert.match(result, /ignoring-line-endings/);
    assert.strictEqual(writeCalled, false, "should not upload when only line endings differ");
  });

  it("should skip .sh upload when local has CRLF and remote already has LF", async () => {
    // Local is CRLF, will be auto-fixed to LF then compared against an LF remote.
    manager.setConfig({ dev: baseConfig() }, ["dev"]);

    const local = writeLocal(Buffer.from("#!/bin/sh\r\necho hi\r\n", "utf8"), ".sh");
    const remoteRaw = Buffer.from("#!/bin/sh\necho hi\n", "utf8");

    manager.ensureConnected = async () => ({}) as any;
    manager.openSftp = async () => ({ end: () => {} }) as any;
    manager.sftpStat = async () => ({ size: remoteRaw.length });
    manager.sftpReadBuffer = async () => remoteRaw;

    let writeCalled = false;
    manager.sftpWriteBuffer = async () => { writeCalled = true; };

    const result = await manager.upload(local, "/tmp/run.sh", "dev");
    assert.match(result, /Upload skipped/);
    // CRLF auto-fix should still be noted even though the upload itself was skipped
    assert.match(result, /CRLF.{0,3}LF auto-fix/);
    assert.strictEqual(writeCalled, false);
  });

  it("should re-upload .sh when remote content actually differs (not just line endings)", async () => {
    manager.setConfig({ dev: baseConfig() }, ["dev"]);

    const local = writeLocal(Buffer.from("#!/bin/sh\necho hi\n", "utf8"), ".sh");
    const remoteRaw = Buffer.from("#!/bin/sh\r\necho BYE\r\n", "utf8"); // different content

    manager.ensureConnected = async () => ({}) as any;
    manager.openSftp = async () => ({ end: () => {} }) as any;
    manager.sftpStat = async () => ({ size: remoteRaw.length });
    manager.sftpReadBuffer = async () => remoteRaw;

    let writeCalled = false;
    manager.sftpWriteBuffer = async () => { writeCalled = true; };

    const result = await manager.upload(local, "/tmp/run.sh", "dev");
    assert.match(result, /File uploaded successfully/);
    assert.strictEqual(writeCalled, true);
  });

  it("should NOT use line-ending-agnostic compare for non-shell files (txt with CRLF differs from LF)", async () => {
    // A .txt that differs only in line endings is NOT skipped — only shell scripts get the agnostic compare.
    manager.setConfig({ dev: baseConfig() }, ["dev"]);

    const local = writeLocal(Buffer.from("a\nb\n", "utf8"), ".txt");
    const remoteRaw = Buffer.from("a\r\nb\r\n", "utf8");

    manager.ensureConnected = async () => ({}) as any;
    manager.openSftp = async () => ({ end: () => {} }) as any;
    manager.sftpStat = async () => ({ size: remoteRaw.length });
    manager.sftpReadBuffer = async () => remoteRaw;

    let writeCalled = false;
    manager.sftpWriteBuffer = async () => { writeCalled = true; };

    const result = await manager.upload(local, "/tmp/file.txt", "dev");
    // Sizes differ (4 vs 6), so we should re-upload
    assert.match(result, /File uploaded successfully/);
    assert.strictEqual(writeCalled, true);
  });
});

console.log("\n🧪 Running command validation tests...\n");
