/**
 * Command Validation Tests
 * 
 * Tests the whitelist/blacklist pattern matching logic
 * without requiring actual SSH connections.
 */

import { afterEach, describe, it } from "node:test";
import assert from "node:assert";
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
    const originalExecuteCommandInternal = manager.executeCommandInternal;
    const originalReconnect = manager.reconnect;
    let executeCalls = 0;
    let reconnectCalls = 0;

    manager.ensureConnected = async () => ({}) as any;
    manager.executeCommandInternal = async () => {
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
      manager.executeCommandInternal = originalExecuteCommandInternal;
      manager.reconnect = originalReconnect;
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
    const originalExecuteCommandInternal = manager.executeCommandInternal;
    const originalReconnect = manager.reconnect;
    let executeCalls = 0;
    let reconnectCalls = 0;

    manager.ensureConnected = async () => ({}) as any;
    manager.executeCommandInternal = async () => {
      executeCalls += 1;
      if (executeCalls === 1) {
        throw new ToolError("SSH_CONNECTION_FAILED", "socket closed", true);
      }
      return "ok";
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
      manager.executeCommandInternal = originalExecuteCommandInternal;
      manager.reconnect = originalReconnect;
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

console.log("\n🧪 Running command validation tests...\n");
