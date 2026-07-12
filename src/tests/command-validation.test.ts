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
import { EventEmitter } from "node:events";
import { SocksClient } from "socks";
import { Client } from "ssh2";
import { SSHConnectionManager, BUILT_IN_DESTRUCTIVE_GUARDS } from "../services/ssh-connection-manager.js";
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
 * Test the built-in destructive-guard patterns (the real exported list).
 */
function getDestructiveMatch(command: string): string | null {
  for (const { regex, reason } of BUILT_IN_DESTRUCTIVE_GUARDS) {
    if (regex.test(command)) {
      return reason;
    }
  }
  return null;
}

describe("Destructive Pattern Detection (built-in guards)", () => {
  it("has no built-in destructive guards (output redirection is normal usage)", () => {
    assert.strictEqual(BUILT_IN_DESTRUCTIVE_GUARDS.length, 0);
  });

  it("ALLOWS output redirection to absolute paths (logging, results)", () => {
    assert.strictEqual(getDestructiveMatch('echo "hi" > /etc/motd'), null);
    assert.strictEqual(getDestructiveMatch("echo test > /tmp/file"), null);
    assert.strictEqual(getDestructiveMatch("cat out > /var/log/app.log"), null);
  });

  it("ALLOWS output redirection to home paths (the nohup logging pattern)", () => {
    assert.strictEqual(getDestructiveMatch("echo test > ~/file"), null);
    assert.strictEqual(getDestructiveMatch("nohup ./train.sh > ~/task.log 2>&1 &"), null);
  });

  it("ALLOWS stderr-to-/dev/null and mixed redirects", () => {
    assert.strictEqual(getDestructiveMatch('find / -name "*log*" 2>/dev/null | head -5'), null);
    assert.strictEqual(getDestructiveMatch("some_command 2>&1 >/dev/null"), null);
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

  it("should not cap caller-provided SSH setup timeouts at 30s", () => {
    assert.strictEqual(manager.normalizeConnectTimeout(60000), 60000);
  });

  it("should default to blacklist mode and allow commands outside a whitelist", () => {
    manager.setConfig(
      {
        dev: baseConfig(),
      },
      ["dev"],
    );

    const result = manager.validateCommand("ver", "dev");
    assert.strictEqual(result.isAllowed, true);
  });

  it("should apply the built-in dangerous blacklist in default mode", () => {
    manager.setConfig(
      {
        dev: baseConfig(),
      },
      ["dev"],
    );

    for (const command of [
      "reboot",
      "shutdown /s /t 0",
      "rm -rf /root/test-file",
      "rm -r -f /root/test-file",
      "Remove-Item -Recurse -Force C:\\Users\\Arc\\test-file",
      "del /s /q C:\\Users\\Arc\\test-file",
      "Restart-Computer",
    ]) {
      const result = manager.validateCommand(command, "dev");
      assert.strictEqual(result.isAllowed, false, command);
      assert.match(result.reason ?? "", /blacklist|blocked/i);
    }
  });

  it("should ignore whitelist patterns when commandMode is blacklist", () => {
    manager.setConfig(
      {
        dev: baseConfig({
          commandMode: "blacklist",
          commandWhitelist: ["^pwd$"],
        }),
      },
      ["dev"],
    );

    const result = manager.validateCommand("ver", "dev");
    assert.strictEqual(result.isAllowed, true);
  });

  it("should block non-matching commands in explicit whitelist mode", () => {
    manager.setConfig(
      {
        dev: baseConfig({
          commandMode: "whitelist",
          commandWhitelist: ["^pwd$"],
        }),
      },
      ["dev"],
    );

    const result = manager.validateCommand("ver", "dev");
    assert.strictEqual(result.isAllowed, false);
    assert.match(result.reason ?? "", /whitelist/i);
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

  it("should not retry command timeout errors and should close the command connection", async () => {
    manager.setConfig(
      {
        dev: baseConfig({
          commandWhitelist: ["^pwd$"],
        }),
      },
      ["dev"],
    );

    const originalConnectCommandClient = manager.connectCommandClient;
    const originalRunCommandStream = manager.runCommandStream;
    const originalCreateLogWriter = manager.createLogWriter;
    let connectCalls = 0;
    let closeCalls = 0;
    let executeCalls = 0;

    manager.connectCommandClient = async () => {
      connectCalls += 1;
      return {
        client: {} as any,
        close: () => { closeCalls += 1; },
      };
    };
    manager.createLogWriter = () => null; // skip disk writes in this test
    manager.runCommandStream = async () => {
      executeCalls += 1;
      throw new ToolError("COMMAND_TIMEOUT", "timed out", false);
    };

    try {
      await assert.rejects(
        () => manager.executeCommand("pwd", "dev", { timeout: 1, maxRetries: 2, reuseConnection: false }),
        (error: unknown) => error instanceof ToolError && error.code === "COMMAND_TIMEOUT",
      );
      assert.strictEqual(connectCalls, 1);
      assert.strictEqual(executeCalls, 1);
      assert.strictEqual(closeCalls, 1);
    } finally {
      manager.connectCommandClient = originalConnectCommandClient;
      manager.runCommandStream = originalRunCommandStream;
      manager.createLogWriter = originalCreateLogWriter;
    }
  });

  it("should reuse cached connections by default and reconnect on SSH connection failures", async () => {
    manager.setConfig(
      {
        dev: baseConfig({
          commandWhitelist: ["^pwd$"],
        }),
      },
      ["dev"],
    );

    const originalEnsureConnected = manager.ensureConnected;
    const originalConnectCommandClient = manager.connectCommandClient;
    const originalRunCommandStream = manager.runCommandStream;
    const originalReconnect = manager.reconnect;
    const originalCreateLogWriter = manager.createLogWriter;
    const originalSleep = manager.sleep;
    let ensureCalls = 0;
    let executeCalls = 0;
    let reconnectCalls = 0;

    manager.ensureConnected = async () => {
      ensureCalls += 1;
      return { cached: true } as any;
    };
    manager.connectCommandClient = async () => {
      throw new Error("fresh connection should not be used by default");
    };
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
    manager.sleep = async () => {};

    try {
      const result = await manager.executeCommand("pwd", "dev", { timeout: 1, maxRetries: 1 });
      assert.strictEqual(result, "ok");
      assert.strictEqual(ensureCalls, 2);
      assert.strictEqual(executeCalls, 2);
      assert.strictEqual(reconnectCalls, 1);
    } finally {
      manager.ensureConnected = originalEnsureConnected;
      manager.connectCommandClient = originalConnectCommandClient;
      manager.runCommandStream = originalRunCommandStream;
      manager.reconnect = originalReconnect;
      manager.createLogWriter = originalCreateLogWriter;
      manager.sleep = originalSleep;
    }
  });

  it("should retry SSH connection failures with a fresh command connection", async () => {
    manager.setConfig(
      {
        dev: baseConfig({
          commandWhitelist: ["^pwd$"],
        }),
      },
      ["dev"],
    );

    const originalConnectCommandClient = manager.connectCommandClient;
    const originalRunCommandStream = manager.runCommandStream;
    const originalCreateLogWriter = manager.createLogWriter;
    const originalSleep = manager.sleep;
    let connectCalls = 0;
    let closeCalls = 0;
    let executeCalls = 0;

    manager.connectCommandClient = async () => {
      connectCalls += 1;
      return {
        client: { attempt: connectCalls } as any,
        close: () => { closeCalls += 1; },
      };
    };
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
    manager.sleep = async () => {};

    try {
      const result = await manager.executeCommand("pwd", "dev", {
        timeout: 1,
        maxRetries: 1,
        reuseConnection: false,
      });
      assert.strictEqual(result, "ok");
      assert.strictEqual(connectCalls, 2);
      assert.strictEqual(executeCalls, 2);
      assert.strictEqual(closeCalls, 2);
    } finally {
      manager.connectCommandClient = originalConnectCommandClient;
      manager.runCommandStream = originalRunCommandStream;
      manager.createLogWriter = originalCreateLogWriter;
      manager.sleep = originalSleep;
    }
  });

  it("should close a one-shot command connection after a successful command", async () => {
    manager.setConfig(
      {
        dev: baseConfig({
          commandWhitelist: ["^pwd$"],
        }),
      },
      ["dev"],
    );

    const originalConnectCommandClient = manager.connectCommandClient;
    const originalRunCommandStream = manager.runCommandStream;
    const originalCreateLogWriter = manager.createLogWriter;
    let closeCalls = 0;

    manager.connectCommandClient = async () => ({
      client: {} as any,
      close: () => {
        closeCalls += 1;
      },
    });
    manager.createLogWriter = () => null;
    manager.runCommandStream = async (
      _cmd: string,
      _client: unknown,
      _timeout: number,
      sinks: { stdoutCollector?: { push(c: string): void } },
    ) => {
      sinks.stdoutCollector?.push("ok");
      return 0;
    };

    try {
      const result = await manager.executeCommand("pwd", "dev", {
        timeout: 1,
        maxRetries: 0,
        reuseConnection: false,
      });
      assert.strictEqual(result, "ok");
      assert.strictEqual(closeCalls, 1);
    } finally {
      manager.connectCommandClient = originalConnectCommandClient;
      manager.runCommandStream = originalRunCommandStream;
      manager.createLogWriter = originalCreateLogWriter;
    }
  });

  it("should use the shared cached SSH acquisition path for SFTP by default", async () => {
    manager.setConfig(
      {
        dev: baseConfig({
          allowedRemoteDirectories: ["/tmp"],
        }),
      },
      ["dev"],
    );

    const originalAcquireSshClient = manager.acquireSshClient;
    const originalSftpWriteBuffer = manager.sftpWriteBuffer;
    let acquireCalls = 0;
    let writeClient: unknown;
    const tempPath = path.resolve(
      process.cwd(),
      `handfree-sftp-reuse-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`,
    );
    fsForTest.writeFileSync(tempPath, "payload");

    manager.acquireSshClient = async (_key: string, options: { reuseConnection?: boolean; debug?: (line: string) => void }) => {
      acquireCalls += 1;
      assert.strictEqual(options.reuseConnection, true);
      assert.strictEqual(options.debug, undefined);
      return {
        client: { cached: true },
        close: () => {},
      };
    };
    manager.sftpWriteBuffer = async (client: unknown) => {
      writeClient = client;
    };

    try {
      const result = await manager.upload(tempPath, "/tmp/file.txt", "dev", {
        skipIfIdentical: false,
      });
      assert.match(result, /File uploaded successfully/);
      assert.strictEqual(acquireCalls, 1);
      assert.deepStrictEqual(writeClient, { cached: true });
    } finally {
      manager.acquireSshClient = originalAcquireSshClient;
      manager.sftpWriteBuffer = originalSftpWriteBuffer;
      fsForTest.unlinkSync(tempPath);
    }
  });

  it("should make cached acquired SSH close a no-op", async () => {
    manager.setConfig(
      {
        dev: baseConfig(),
      },
      ["dev"],
    );

    const originalEnsureConnected = manager.ensureConnected;
    let endCalls = 0;
    manager.ensureConnected = async () => ({
      end: () => {
        endCalls += 1;
      },
    }) as any;

    try {
      const connection = await manager.acquireSshClient("dev", { reuseConnection: true });
      connection.close();
      assert.strictEqual(endCalls, 0, "cached acquire close must not end the reused SSH client");
    } finally {
      manager.ensureConnected = originalEnsureConnected;
    }
  });

  it("should close one-shot SFTP SSH clients when reuseConnection=false", async () => {
    manager.setConfig(
      {
        dev: baseConfig({
          allowedRemoteDirectories: ["/tmp"],
        }),
      },
      ["dev"],
    );

    const originalAcquireSshClient = manager.acquireSshClient;
    const originalSftpWriteBuffer = manager.sftpWriteBuffer;
    let acquireCalls = 0;
    let closeCalls = 0;
    let writeClient: unknown;
    const tempPath = path.resolve(
      process.cwd(),
      `handfree-sftp-fresh-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`,
    );
    fsForTest.writeFileSync(tempPath, "payload");

    manager.acquireSshClient = async (
      _key: string,
      options: { reuseConnection?: boolean; timeout?: number; debug?: (line: string) => void },
    ) => {
      acquireCalls += 1;
      assert.strictEqual(options.reuseConnection, false);
      assert.strictEqual(options.timeout, 123);
      assert.strictEqual(typeof options.debug, "function");
      options.debug?.("[ssh2] sftp fresh handshake");
      return {
        client: { fresh: true },
        close: () => {
          closeCalls += 1;
        },
      };
    };
    manager.sftpWriteBuffer = async (client: unknown) => {
      writeClient = client;
    };

    try {
      const result = await manager.upload(tempPath, "/tmp/file.txt", "dev", {
        skipIfIdentical: false,
        reuseConnection: false,
        timeout: 123,
        vvv: true,
      });
      assert.match(result, /File uploaded successfully/);
      assert.match(result, /\[SSH DEBUG\]/);
      assert.match(result, /sftp fresh handshake/);
      assert.strictEqual(acquireCalls, 1);
      assert.deepStrictEqual(writeClient, { fresh: true });
      assert.strictEqual(closeCalls, 1, "one-shot SFTP clients must close after use");
    } finally {
      manager.acquireSshClient = originalAcquireSshClient;
      manager.sftpWriteBuffer = originalSftpWriteBuffer;
      fsForTest.unlinkSync(tempPath);
    }
  });

  it("should use ssh2 fastPut when fast SFTP upload is enabled", async () => {
    manager.setConfig(
      {
        dev: baseConfig({
          allowedRemoteDirectories: ["/tmp"],
        }),
      },
      ["dev"],
    );

    const originalAcquireSshClient = manager.acquireSshClient;
    const originalOpenSftp = manager.openSftp;
    const originalSftpWriteBuffer = manager.sftpWriteBuffer;
    let sftpEndCalls = 0;
    let fastPutArgs: unknown[] | null = null;
    const tempPath = path.resolve(
      process.cwd(),
      `handfree-sftp-fast-put-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`,
    );
    fsForTest.writeFileSync(tempPath, "payload");

    manager.acquireSshClient = async () => ({
      client: { cached: true },
      close: () => {},
    });
    manager.openSftp = async () => ({
      end: () => {
        sftpEndCalls += 1;
      },
      fastPut: (
        localPath: string,
        remotePath: string,
        options: unknown,
        callback: (err?: Error) => void,
      ) => {
        fastPutArgs = [localPath, remotePath, options];
        callback();
      },
    }) as any;
    manager.sftpWriteBuffer = async () => {
      throw new Error("buffer upload should not be used when fast=true");
    };

    try {
      const result = await manager.upload(tempPath, "/tmp/file.txt", "dev", {
        skipIfIdentical: false,
        fast: true,
        sftpConcurrency: 8,
        chunkSize: 65536,
      });
      assert.match(result, /File uploaded successfully/);
      assert.match(result, /fast SFTP/);
      const [putLocal, putRemote, putOpts] = fastPutArgs as unknown as [
        string,
        string,
        { concurrency?: number; chunkSize?: number; step?: unknown },
      ];
      assert.strictEqual(putLocal, tempPath);
      assert.strictEqual(putRemote, "/tmp/file.txt");
      assert.strictEqual(putOpts.concurrency, 8);
      assert.strictEqual(putOpts.chunkSize, 65536);
      assert.strictEqual(typeof putOpts.step, "function");
      assert.strictEqual(sftpEndCalls, 1);
    } finally {
      manager.acquireSshClient = originalAcquireSshClient;
      manager.openSftp = originalOpenSftp;
      manager.sftpWriteBuffer = originalSftpWriteBuffer;
      fsForTest.unlinkSync(tempPath);
    }
  });

  it("should use ssh2 fastGet when fast SFTP download is enabled", async () => {
    manager.setConfig(
      {
        dev: baseConfig({
          allowedRemoteDirectories: ["/tmp"],
        }),
      },
      ["dev"],
    );

    const originalAcquireSshClient = manager.acquireSshClient;
    const originalOpenSftp = manager.openSftp;
    let sftpEndCalls = 0;
    let fastGetArgs: unknown[] | null = null;
    const tempPath = path.resolve(
      process.cwd(),
      `handfree-sftp-fast-get-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`,
    );

    manager.acquireSshClient = async () => ({
      client: { cached: true },
      close: () => {},
    });
    manager.openSftp = async () => ({
      end: () => {
        sftpEndCalls += 1;
      },
      fastGet: (
        remotePath: string,
        localPath: string,
        options: unknown,
        callback: (err?: Error) => void,
      ) => {
        fastGetArgs = [remotePath, localPath, options];
        callback();
      },
    }) as any;

    try {
      const result = await manager.download("/tmp/file.txt", tempPath, "dev", {
        fast: true,
        sftpConcurrency: 4,
        chunkSize: 131072,
      });
      assert.match(result, /File downloaded successfully/);
      assert.match(result, /fast SFTP/);
      const [getRemote, getLocal, getOpts] = fastGetArgs as unknown as [
        string,
        string,
        { concurrency?: number; chunkSize?: number; step?: unknown },
      ];
      assert.strictEqual(getRemote, "/tmp/file.txt");
      assert.strictEqual(getLocal, tempPath);
      assert.strictEqual(getOpts.concurrency, 4);
      assert.strictEqual(getOpts.chunkSize, 131072);
      assert.strictEqual(typeof getOpts.step, "function");
      assert.strictEqual(sftpEndCalls, 1);
    } finally {
      manager.acquireSshClient = originalAcquireSshClient;
      manager.openSftp = originalOpenSftp;
      if (fsForTest.existsSync(tempPath)) {
        fsForTest.unlinkSync(tempPath);
      }
    }
  });

  it("should reject sftpMkdirRecursive on a connection-shaped mkdir error", async () => {
    const originalOpenSftp = manager.openSftp;
    let sftpEndCalls = 0;
    manager.openSftp = async () => ({
      end: () => {
        sftpEndCalls += 1;
      },
      mkdir: (_p: string, cb: (err?: Error) => void) => {
        // ssh2 surfaces a dropped channel as a connection-shaped error.
        cb(new Error("Not connected"));
      },
    });

    try {
      await assert.rejects(
        () => manager.sftpMkdirRecursive({}, "/tmp/a/b"),
        (err: Error) =>
          err instanceof ToolError &&
          err.code === "SSH_CONNECTION_FAILED" &&
          /Not connected/i.test(err.message),
      );
      assert.strictEqual(
        sftpEndCalls,
        1,
        "sftp channel must be closed after a mkdir failure",
      );
    } finally {
      manager.openSftp = originalOpenSftp;
    }
  });

  it("should tolerate existing-directory mkdir errors and walk the full path", async () => {
    const originalOpenSftp = manager.openSftp;
    const attempted: string[] = [];
    let sftpEndCalls = 0;
    manager.openSftp = async () => ({
      end: () => {
        sftpEndCalls += 1;
      },
      mkdir: (p: string, cb: (err?: Error) => void) => {
        attempted.push(p);
        // A non-connection "Failure" (e.g. dir already exists) must not abort.
        cb(new Error("Failure"));
      },
    });

    try {
      await manager.sftpMkdirRecursive({}, "/tmp/a/b");
      assert.deepStrictEqual(attempted, ["/tmp", "/tmp/a", "/tmp/a/b"]);
      assert.strictEqual(sftpEndCalls, 1);
    } finally {
      manager.openSftp = originalOpenSftp;
    }
  });

  it("should reject a stalled fast SFTP upload via the inactivity timeout", async () => {
    const originalOpenSftp = manager.openSftp;
    let sftpEndCalls = 0;
    manager.openSftp = async () => ({
      end: () => {
        sftpEndCalls += 1;
      },
      // Never invokes the callback and never reports progress -> would hang
      // forever without an inactivity watchdog.
      fastPut: () => {},
    });

    try {
      await assert.rejects(
        () =>
          manager.sftpFastPut({}, "/local/file", "/tmp/file", {}, 40),
        (err: Error) =>
          err instanceof ToolError &&
          err.code === "SSH_CONNECTION_FAILED" &&
          /stall|no progress/i.test(err.message),
      );
      assert.ok(
        sftpEndCalls >= 1,
        "sftp channel must be closed when a stalled transfer is aborted",
      );
    } finally {
      manager.openSftp = originalOpenSftp;
    }
  });

  it("should reset the fast-transfer inactivity timer while progress is reported", async () => {
    const originalOpenSftp = manager.openSftp;
    manager.openSftp = async () => ({
      end: () => {},
      fastPut: (
        _localPath: string,
        _remotePath: string,
        options: { step?: (t: number, c: number, total: number) => void },
        cb: (err?: Error) => void,
      ) => {
        // Report progress every 20ms for 100ms, then finish. A 40ms
        // inactivity window must NOT trip because progress keeps arriving.
        let ticks = 0;
        const iv = setInterval(() => {
          ticks += 1;
          options.step?.(ticks * 10, 10, 50);
          if (ticks >= 5) {
            clearInterval(iv);
            cb();
          }
        }, 20);
      },
    });

    try {
      await manager.sftpFastPut({}, "/local/file", "/tmp/file", {}, 40);
    } finally {
      manager.openSftp = originalOpenSftp;
    }
  });

  it("should not double-acquire or double-close on a self-relay", async () => {
    manager.setConfig(
      {
        dev: baseConfig({
          allowedRemoteDirectories: ["/tmp"],
        }),
      },
      ["dev"],
    );

    const originalAcquireSshClient = manager.acquireSshClient;
    const originalOpenSftp = manager.openSftp;
    const originalSftpStat = manager.sftpStat;
    const originalRemoteMd5 = manager.remoteMd5;
    let acquireCalls = 0;
    let closeCalls = 0;

    manager.acquireSshClient = async () => {
      acquireCalls += 1;
      return {
        client: { cached: true },
        close: () => {
          closeCalls += 1;
        },
      };
    };
    manager.openSftp = async () => ({ end: () => {} });
    manager.sftpStat = async () => ({ size: 100 });
    manager.remoteMd5 = async () => "abc123";

    try {
      const result = await manager.transferBetweenServers(
        "dev",
        "/tmp/a",
        "dev",
        "/tmp/b",
        { skipIfIdentical: true },
      );
      assert.match(result, /skipped/i);
      assert.strictEqual(acquireCalls, 1, "self-relay must acquire one client");
      assert.strictEqual(closeCalls, 1, "self-relay must close the client once");
    } finally {
      manager.acquireSshClient = originalAcquireSshClient;
      manager.openSftp = originalOpenSftp;
      manager.sftpStat = originalSftpStat;
      manager.remoteMd5 = originalRemoteMd5;
    }
  });

  it("should tear down streams when a normal SFTP download read fails", async () => {
    manager.setConfig(
      {
        dev: baseConfig({
          allowedRemoteDirectories: ["/tmp"],
        }),
      },
      ["dev"],
    );

    const originalAcquireSshClient = manager.acquireSshClient;
    const originalOpenSftp = manager.openSftp;
    const originalCreateWriteStream = (fsForTest as any).createWriteStream;
    let sftpEndCalls = 0;
    let readUnpipeCalls = 0;
    let readDestroyCalls = 0;
    let writeDestroyCalls = 0;
    const tempPath = path.resolve(
      process.cwd(),
      `handfree-sftp-download-fail-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`,
    );

    manager.acquireSshClient = async () => ({
      client: { cached: true },
      close: () => {},
    });
    manager.openSftp = async () => ({
      end: () => {
        sftpEndCalls += 1;
      },
      createReadStream: () => {
        const stream = new EventEmitter() as any;
        stream.pipe = (dest: unknown) => {
          setImmediate(() => stream.emit("error", new Error("remote read failed")));
          return dest;
        };
        stream.unpipe = () => {
          readUnpipeCalls += 1;
        };
        stream.destroy = () => {
          readDestroyCalls += 1;
        };
        return stream;
      },
    }) as any;
    (fsForTest as any).createWriteStream = () => {
      const stream = new EventEmitter() as any;
      stream.destroy = () => {
        writeDestroyCalls += 1;
      };
      return stream;
    };

    try {
      await assert.rejects(
        () => manager.download("/tmp/file.txt", tempPath, "dev"),
        (error: unknown) => error instanceof ToolError && error.code === "SFTP_ERROR",
      );
      assert.strictEqual(readUnpipeCalls, 1);
      assert.strictEqual(readDestroyCalls, 1);
      assert.strictEqual(writeDestroyCalls, 1);
      assert.strictEqual(sftpEndCalls, 1);
    } finally {
      manager.acquireSshClient = originalAcquireSshClient;
      manager.openSftp = originalOpenSftp;
      (fsForTest as any).createWriteStream = originalCreateWriteStream;
      if (fsForTest.existsSync(tempPath)) {
        fsForTest.unlinkSync(tempPath);
      }
    }
  });

  it("should drop the stale cached SSH client when an SFTP channel open fails with a non-keyword message", async () => {
    manager.setConfig(
      {
        dev: baseConfig({
          allowedRemoteDirectories: ["/tmp"],
        }),
      },
      ["dev"],
    );

    const originalAcquireSshClient = manager.acquireSshClient;
    const originalCloseClient = manager.closeClient;
    let closeArgs: unknown[] | null = null;
    const tempPath = path.resolve(
      process.cwd(),
      `handfree-sftp-open-fail-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`,
    );
    fsForTest.writeFileSync(tempPath, "payload");

    // The real openSftp runs here: the fake client's sftp() fails with a message
    // that contains NONE of the connection keywords. An SFTP channel-open failure
    // means the cached client is unusable, so it must be classified as a
    // connection error and force-dropped for self-heal — regardless of wording.
    manager.acquireSshClient = async () => ({
      client: {
        sftp: (cb: (err: Error | undefined, sftp?: unknown) => void) =>
          cb(new Error("administratively prohibited")),
      },
      close: () => {},
    });
    manager.closeClient = (name: string, force?: boolean) => {
      closeArgs = [name, force];
    };

    try {
      await assert.rejects(
        () =>
          manager.upload(tempPath, "/tmp/file.txt", "dev", {
            skipIfIdentical: false,
            fast: true,
          }),
        (error: unknown) =>
          error instanceof ToolError && error.code === "SSH_CONNECTION_FAILED",
      );
      assert.deepStrictEqual(
        closeArgs,
        ["dev", true],
        "SFTP channel-open failure must force-drop the stale cached client",
      );
    } finally {
      manager.acquireSshClient = originalAcquireSshClient;
      manager.closeClient = originalCloseClient;
      if (fsForTest.existsSync(tempPath)) {
        fsForTest.unlinkSync(tempPath);
      }
    }
  });

  it("should not leak an SFTP channel when fast upload options are invalid", async () => {
    manager.setConfig(
      {
        dev: baseConfig({
          allowedRemoteDirectories: ["/tmp"],
        }),
      },
      ["dev"],
    );

    const originalAcquireSshClient = manager.acquireSshClient;
    const originalOpenSftp = manager.openSftp;
    let openSftpCalls = 0;
    let sftpEndCalls = 0;
    const tempPath = path.resolve(
      process.cwd(),
      `handfree-sftp-fast-badopt-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`,
    );
    fsForTest.writeFileSync(tempPath, "payload");

    manager.acquireSshClient = async () => ({
      client: { cached: true },
      close: () => {},
    });
    manager.openSftp = async () => {
      openSftpCalls += 1;
      return {
        end: () => {
          sftpEndCalls += 1;
        },
        fastPut: (
          _localPath: string,
          _remotePath: string,
          _options: unknown,
          callback: (err?: Error) => void,
        ) => callback(),
      };
    };

    try {
      await assert.rejects(
        () =>
          manager.upload(tempPath, "/tmp/file.txt", "dev", {
            skipIfIdentical: false,
            fast: true,
            sftpConcurrency: -1,
          }),
        (error: unknown) =>
          error instanceof ToolError && error.code === "INVALID_CONFIGURATION",
      );
      // Invariant: every opened SFTP channel must be closed. Invalid transfer
      // options must not leak a channel (either validate before opening, or
      // end() the channel on the throw path).
      assert.strictEqual(
        openSftpCalls,
        sftpEndCalls,
        "fast upload must not leak an SFTP channel when options are invalid",
      );
    } finally {
      manager.acquireSshClient = originalAcquireSshClient;
      manager.openSftp = originalOpenSftp;
      if (fsForTest.existsSync(tempPath)) {
        fsForTest.unlinkSync(tempPath);
      }
    }
  });

  it("should close one-shot SSH clients after fast SFTP transfers", async () => {
    manager.setConfig(
      {
        dev: baseConfig({
          allowedRemoteDirectories: ["/tmp"],
        }),
      },
      ["dev"],
    );

    const originalAcquireSshClient = manager.acquireSshClient;
    const originalOpenSftp = manager.openSftp;
    let closeCalls = 0;
    let fastPutCalls = 0;
    const tempPath = path.resolve(
      process.cwd(),
      `handfree-sftp-fast-fresh-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`,
    );
    fsForTest.writeFileSync(tempPath, "payload");

    manager.acquireSshClient = async (_key: string, options: { reuseConnection?: boolean }) => {
      assert.strictEqual(options.reuseConnection, false);
      return {
        client: { fresh: true },
        close: () => {
          closeCalls += 1;
        },
      };
    };
    manager.openSftp = async () => ({
      end: () => {},
      fastPut: (
        _localPath: string,
        _remotePath: string,
        _options: unknown,
        callback: (err?: Error) => void,
      ) => {
        fastPutCalls += 1;
        callback();
      },
    }) as any;

    try {
      const result = await manager.upload(tempPath, "/tmp/file.txt", "dev", {
        skipIfIdentical: false,
        reuseConnection: false,
        fast: true,
      });
      assert.match(result, /fast SFTP/);
      assert.strictEqual(fastPutCalls, 1);
      assert.strictEqual(closeCalls, 1, "one-shot fast SFTP clients must close after use");
    } finally {
      manager.acquireSshClient = originalAcquireSshClient;
      manager.openSftp = originalOpenSftp;
      fsForTest.unlinkSync(tempPath);
    }
  });

  it("should close both one-shot relay SSH clients when reuseConnection=false", async () => {
    manager.setConfig(
      {
        src: baseConfig({
          name: "src",
          allowedRemoteDirectories: ["/tmp"],
        }),
        dst: baseConfig({
          name: "dst",
          host: "127.0.0.2",
          allowedRemoteDirectories: ["/tmp"],
        }),
      },
      ["src", "dst"],
    );

    const originalAcquireSshClient = manager.acquireSshClient;
    const originalOpenSftp = manager.openSftp;
    const originalSftpStat = manager.sftpStat;
    let closeCalls = 0;
    const acquired: string[] = [];

    manager.acquireSshClient = async (
      key: string,
      options: { reuseConnection?: boolean; debug?: (line: string) => void },
    ) => {
      acquired.push(key);
      assert.strictEqual(options.reuseConnection, false);
      assert.strictEqual(typeof options.debug, "function");
      options.debug?.(`[ssh2] ${key} relay handshake`);
      return {
        client: { key },
        close: () => {
          closeCalls += 1;
        },
      };
    };
    manager.openSftp = async () => ({
      end: () => {},
      createReadStream: () => {
        const stream = new EventEmitter() as any;
        stream.pipe = (dest: EventEmitter) => {
          setImmediate(() => dest.emit("close"));
          return dest;
        };
        return stream;
      },
      createWriteStream: () => new EventEmitter(),
    }) as any;
    manager.sftpStat = async () => ({ size: 7 });

    try {
      const result = await manager.transferBetweenServers(
        "src",
        "/tmp/source.txt",
        "dst",
        "/tmp/dest.txt",
        {
          skipIfIdentical: false,
          reuseConnection: false,
          vvv: true,
        },
      );
      assert.match(result, /Transfer complete/);
      assert.match(result, /\[SSH DEBUG\]/);
      assert.match(result, /src relay handshake/);
      assert.match(result, /dst relay handshake/);
      assert.deepStrictEqual(acquired, ["src", "dst"]);
      assert.strictEqual(closeCalls, 2);
    } finally {
      manager.acquireSshClient = originalAcquireSshClient;
      manager.openSftp = originalOpenSftp;
      manager.sftpStat = originalSftpStat;
    }
  });

  it("should tear down both relay streams when the destination write fails", async () => {
    manager.setConfig(
      {
        src: baseConfig({
          name: "src",
          allowedRemoteDirectories: ["/tmp"],
        }),
        dst: baseConfig({
          name: "dst",
          host: "127.0.0.2",
          allowedRemoteDirectories: ["/tmp"],
        }),
      },
      ["src", "dst"],
    );

    const originalAcquireSshClient = manager.acquireSshClient;
    const originalOpenSftp = manager.openSftp;
    const originalSftpStat = manager.sftpStat;
    let readUnpipeCalls = 0;
    let readDestroyCalls = 0;
    let writeDestroyCalls = 0;

    manager.acquireSshClient = async (key: string) => ({
      client: { key },
      close: () => {},
    });
    manager.sftpStat = async () => ({ size: 7 });
    manager.openSftp = async (_client: unknown, label: string) => {
      if (label === "source") {
        return {
          end: () => {},
          createReadStream: () => {
            const stream = new EventEmitter() as any;
            stream.pipe = (dest: EventEmitter) => {
              setImmediate(() => dest.emit("error", new Error("dest write failed")));
              return dest;
            };
            stream.unpipe = () => {
              readUnpipeCalls += 1;
            };
            stream.destroy = () => {
              readDestroyCalls += 1;
            };
            return stream;
          },
        } as any;
      }

      return {
        end: () => {},
        createWriteStream: () => {
          const stream = new EventEmitter() as any;
          stream.destroy = () => {
            writeDestroyCalls += 1;
          };
          return stream;
        },
      } as any;
    };

    try {
      await assert.rejects(
        () => manager.transferBetweenServers(
          "src",
          "/tmp/source.txt",
          "dst",
          "/tmp/dest.txt",
          { skipIfIdentical: false },
        ),
        (error: unknown) => error instanceof ToolError && error.code === "SFTP_ERROR",
      );
      assert.strictEqual(readUnpipeCalls, 1);
      assert.strictEqual(readDestroyCalls, 1);
      assert.strictEqual(writeDestroyCalls, 1);
    } finally {
      manager.acquireSshClient = originalAcquireSshClient;
      manager.openSftp = originalOpenSftp;
      manager.sftpStat = originalSftpStat;
    }
  });

  it("should retry cached connections when exec channel opening never returns", async () => {
    manager.setConfig(
      {
        dev: baseConfig({
          commandWhitelist: ["^pwd$"],
        }),
      },
      ["dev"],
    );

    const originalEnsureConnected = manager.ensureConnected;
    const originalReconnect = manager.reconnect;
    const originalCreateLogWriter = manager.createLogWriter;
    const originalSleep = manager.sleep;
    let execCalls = 0;
    let reconnectCalls = 0;

    const fakeClient = {
      exec: () => {
        execCalls += 1;
        // Simulate a stale ssh2 client whose channel-open callback never fires.
      },
    };

    manager.ensureConnected = async () => fakeClient;
    manager.reconnect = async () => {
      reconnectCalls += 1;
    };
    manager.createLogWriter = () => null;
    manager.sleep = async () => {};

    try {
      await assert.rejects(
        () => manager.executeCommand("pwd", "dev", { timeout: 1, maxRetries: 1 }),
        (error: unknown) => error instanceof ToolError && error.code === "SSH_CONNECTION_FAILED",
      );
      assert.strictEqual(execCalls, 2);
      assert.strictEqual(reconnectCalls, 1);
    } finally {
      manager.ensureConnected = originalEnsureConnected;
      manager.reconnect = originalReconnect;
      manager.createLogWriter = originalCreateLogWriter;
      manager.sleep = originalSleep;
    }
  });

  it("should drop a cached connection after final exec channel opening failure", async () => {
    manager.setConfig(
      {
        dev: baseConfig({
          commandWhitelist: ["^pwd$"],
        }),
      },
      ["dev"],
    );

    const originalCreateLogWriter = manager.createLogWriter;
    let execCalls = 0;
    let endCalls = 0;
    const fakeClient = {
      exec: () => {
        execCalls += 1;
        // Simulate a stale ssh2 client whose channel-open callback never fires.
      },
      end: () => {
        endCalls += 1;
      },
    };

    manager.clients.set("dev", fakeClient);
    manager.connected.set("dev", true);
    manager.createLogWriter = () => null;

    try {
      await assert.rejects(
        () => manager.executeCommand("pwd", "dev", { timeout: 1, maxRetries: 0 }),
        (error: unknown) => error instanceof ToolError && error.code === "SSH_CONNECTION_FAILED",
      );
      assert.strictEqual(execCalls, 1);
      assert.strictEqual(endCalls, 1);
      assert.strictEqual(manager.clients.has("dev"), false);
      assert.strictEqual(manager.connected.get("dev"), false);
    } finally {
      manager.createLogWriter = originalCreateLogWriter;
      manager.closeConnection("dev");
    }
  });

  it("should close one-shot command connections when exec channel opening times out", async () => {
    manager.setConfig(
      {
        dev: baseConfig({
          commandWhitelist: ["^pwd$"],
        }),
      },
      ["dev"],
    );

    const originalConnectCommandClient = manager.connectCommandClient;
    const originalCreateLogWriter = manager.createLogWriter;
    let closeCalls = 0;
    let execCalls = 0;

    manager.connectCommandClient = async () => ({
      client: {
        exec: () => {
          execCalls += 1;
          // Simulate channel-open callback never firing.
        },
      } as any,
      close: () => {
        closeCalls += 1;
      },
    });
    manager.createLogWriter = () => null;

    try {
      await assert.rejects(
        () => manager.executeCommand("pwd", "dev", {
          timeout: 1,
          maxRetries: 0,
          reuseConnection: false,
        }),
        (error: unknown) => error instanceof ToolError && error.code === "SSH_CONNECTION_FAILED",
      );
      assert.strictEqual(execCalls, 1);
      assert.strictEqual(closeCalls, 1);
    } finally {
      manager.connectCommandClient = originalConnectCommandClient;
      manager.createLogWriter = originalCreateLogWriter;
    }
  });

  it("should pass caller timeout through to exec channel opening without a 30s cap", async () => {
    const originalSetTimeout = globalThis.setTimeout;
    const observedDelays: number[] = [];
    const fakeClient = {
      exec: () => {
        // Simulate channel-open callback never firing.
      },
    };

    (globalThis as any).setTimeout = (
      callback: (...args: unknown[]) => void,
      delay?: number,
      ...args: unknown[]
    ) => {
      observedDelays.push(Number(delay));
      return originalSetTimeout(callback, 0, ...args);
    };

    try {
      await assert.rejects(
        () => manager.runCommandStream("pwd", fakeClient, 60000, {}),
        (error: unknown) => error instanceof ToolError && error.code === "SSH_CONNECTION_FAILED",
      );
      assert.strictEqual(observedDelays[0], 60000);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }
  });

  it("should fail immediately when the SSH client closes while opening an exec channel", async () => {
    const fakeClient = new EventEmitter() as any;
    let execCalls = 0;

    fakeClient.exec = () => {
      execCalls += 1;
      setImmediate(() => fakeClient.emit("close"));
    };

    await assert.rejects(
      () => manager.runCommandStream("pwd", fakeClient, 60000, {}),
      (error: unknown) =>
        error instanceof ToolError &&
        error.code === "SSH_CONNECTION_FAILED" &&
        /closed while opening command channel/.test(error.message),
    );
    assert.strictEqual(execCalls, 1);
  });

  it("should fail immediately when the SSH client closes while a command is running", async () => {
    const fakeClient = new EventEmitter() as any;
    const stream = new EventEmitter() as any;
    stream.stderr = new EventEmitter();
    stream.close = () => {
      stream.emit("close", 0);
    };
    let execCalls = 0;

    fakeClient.exec = (_cmd: string, callback: (err: Error | undefined, stream: unknown) => void) => {
      execCalls += 1;
      callback(undefined, stream);
      setImmediate(() => fakeClient.emit("close"));
    };

    await assert.rejects(
      () => manager.runCommandStream("pwd", fakeClient, 60000, {}),
      (error: unknown) =>
        error instanceof ToolError &&
        error.code === "SSH_CONNECTION_FAILED" &&
        /closed while running command/.test(error.message),
    );
    assert.strictEqual(execCalls, 1);
  });

  it("should not retry a connection failure after the remote command is running", async () => {
    manager.setConfig(
      {
        dev: baseConfig({
          commandWhitelist: ["^pwd$"],
        }),
      },
      ["dev"],
    );

    const originalAcquireSshClient = manager.acquireSshClient;
    const originalRunCommandStream = manager.runCommandStream;
    const originalReconnect = manager.reconnect;
    const originalCreateLogWriter = manager.createLogWriter;
    let runCalls = 0;
    let reconnectCalls = 0;

    manager.acquireSshClient = async () => ({
      client: {},
      close: () => {},
    });
    manager.runCommandStream = async () => {
      runCalls += 1;
      throw new ToolError(
        "SSH_CONNECTION_FAILED",
        "SSH connection closed while running command",
        true,
      );
    };
    manager.reconnect = async () => {
      reconnectCalls += 1;
    };
    manager.createLogWriter = () => null;

    try {
      await assert.rejects(
        () => manager.executeCommandWithProgress("pwd", "dev", { maxRetries: 2 }),
        (error: unknown) =>
          error instanceof ToolError &&
          error.code === "SSH_CONNECTION_FAILED" &&
          /running command/.test(error.message),
      );
      assert.strictEqual(runCalls, 1);
      assert.strictEqual(reconnectCalls, 0);
    } finally {
      manager.acquireSshClient = originalAcquireSshClient;
      manager.runCommandStream = originalRunCommandStream;
      manager.reconnect = originalReconnect;
      manager.createLogWriter = originalCreateLogWriter;
    }
  });

  it("should not close a replacement cached client after an older acquired client fails", async () => {
    manager.setConfig(
      {
        dev: baseConfig({
          commandWhitelist: ["^pwd$"],
        }),
      },
      ["dev"],
    );

    const originalAcquireSshClient = manager.acquireSshClient;
    const originalRunCommandStream = manager.runCommandStream;
    const originalCreateLogWriter = manager.createLogWriter;
    let replacementEndCalls = 0;
    const failedClient = {};
    const replacementClient = {
      end: () => {
        replacementEndCalls += 1;
      },
    };

    manager.acquireSshClient = async () => {
      manager.clients.set("dev", replacementClient);
      manager.connected.set("dev", true);
      return {
        client: failedClient,
        close: () => {},
      };
    };
    manager.runCommandStream = async () => {
      throw new ToolError(
        "SSH_CONNECTION_FAILED",
        "SSH exec channel timeout: no response from server within 1ms while opening command channel",
        true,
      );
    };
    manager.createLogWriter = () => null;

    try {
      await assert.rejects(
        () => manager.executeCommand("pwd", "dev", { timeout: 1, maxRetries: 0 }),
        (error: unknown) => error instanceof ToolError && error.code === "SSH_CONNECTION_FAILED",
      );
      assert.strictEqual(manager.clients.get("dev"), replacementClient);
      assert.strictEqual(manager.connected.get("dev"), true);
      assert.strictEqual(replacementEndCalls, 0);
    } finally {
      manager.acquireSshClient = originalAcquireSshClient;
      manager.runCommandStream = originalRunCommandStream;
      manager.createLogWriter = originalCreateLogWriter;
    }
  });

  it("should not reconnect cached clients when an opened remote command times out", async () => {
    manager.setConfig(
      {
        dev: baseConfig({
          commandWhitelist: ["^pwd$"],
        }),
      },
      ["dev"],
    );

    const originalEnsureConnected = manager.ensureConnected;
    const originalReconnect = manager.reconnect;
    const originalCreateLogWriter = manager.createLogWriter;
    let execCalls = 0;
    let signalCalls = 0;
    let closeCalls = 0;
    let reconnectCalls = 0;

    const stream = new EventEmitter() as any;
    stream.stderr = new EventEmitter();
    stream.signal = () => {
      signalCalls += 1;
    };
    stream.close = () => {
      closeCalls += 1;
      stream.emit("close", 0);
    };

    const fakeClient = {
      exec: (_cmd: string, callback: (err: Error | undefined, stream: unknown) => void) => {
        execCalls += 1;
        callback(undefined, stream);
      },
    };

    manager.ensureConnected = async () => fakeClient;
    manager.reconnect = async () => {
      reconnectCalls += 1;
    };
    manager.createLogWriter = () => null;

    try {
      await assert.rejects(
        () => manager.executeCommand("pwd", "dev", { timeout: 1, maxRetries: 2 }),
        (error: unknown) => error instanceof ToolError && error.code === "COMMAND_TIMEOUT",
      );
      assert.strictEqual(execCalls, 1);
      assert.strictEqual(signalCalls, 1);
      assert.strictEqual(closeCalls, 1);
      assert.strictEqual(reconnectCalls, 0);
    } finally {
      manager.ensureConnected = originalEnsureConnected;
      manager.reconnect = originalReconnect;
      manager.createLogWriter = originalCreateLogWriter;
    }
  });

  it("should append bounded SSH debug output when vvv is enabled", async () => {
    manager.setConfig(
      {
        dev: baseConfig({
          commandWhitelist: ["^pwd$"],
        }),
      },
      ["dev"],
    );

    const originalEnsureConnected = manager.ensureConnected;
    const originalCreateLogWriter = manager.createLogWriter;

    const stream = new EventEmitter() as any;
    stream.stderr = new EventEmitter();
    stream.signal = () => {};
    stream.close = () => {};

    const fakeClient = {
      exec: (_cmd: string, callback: (err: Error | undefined, stream: unknown) => void) => {
        callback(undefined, stream);
        setImmediate(() => stream.emit("close", 0));
      },
    };

    manager.ensureConnected = async () => fakeClient;
    manager.createLogWriter = () => null;

    try {
      const result = await manager.executeCommand("pwd", "dev", {
        timeout: 100,
        maxRetries: 0,
        vvv: true,
      });
      assert.match(result, /\[SSH DEBUG\]/);
      assert.match(result, /reuseConnection=true/);
      assert.match(result, /exec channel opened/);
    } finally {
      manager.ensureConnected = originalEnsureConnected;
      manager.createLogWriter = originalCreateLogWriter;
    }
  });

  it("should close one-shot streaming command connections and append vvv debug output", async () => {
    manager.setConfig(
      {
        dev: baseConfig({
          commandWhitelist: ["^pwd$"],
        }),
      },
      ["dev"],
    );

    const originalConnectCommandClient = manager.connectCommandClient;
    const originalRunCommandStream = manager.runCommandStream;
    const originalCreateLogWriter = manager.createLogWriter;
    let closeCalls = 0;
    const progressChunks: string[] = [];

    manager.connectCommandClient = async (_key: string, _timeout: number, debug?: (line: string) => void) => {
      debug?.("[ssh2] fresh handshake");
      return {
        client: {} as any,
        close: () => {
          closeCalls += 1;
        },
      };
    };
    manager.createLogWriter = () => null;
    manager.runCommandStream = async (
      _cmd: string,
      _client: unknown,
      _timeout: number,
      sinks: {
        stdoutCollector?: { push(c: string): void };
        onProgress?: (chunk: string) => void;
        debug?: (line: string) => void;
      },
    ) => {
      sinks.stdoutCollector?.push("ok");
      sinks.onProgress?.("ok");
      sinks.debug?.("[mcp] streaming runner debug");
      return 0;
    };

    try {
      const result = await manager.executeCommandWithProgress("pwd", "dev", {
        timeout: 1,
        maxRetries: 0,
        reuseConnection: false,
        vvv: true,
        onProgress: (chunk: string) => progressChunks.push(chunk),
      });
      assert.match(result, /^ok/);
      assert.match(result, /\[SSH DEBUG\]/);
      assert.match(result, /streaming command attempt 1\/1/);
      assert.match(result, /fresh handshake/);
      assert.match(result, /streaming runner debug/);
      assert.deepStrictEqual(progressChunks, ["ok"]);
      assert.strictEqual(closeCalls, 1);
    } finally {
      manager.connectCommandClient = originalConnectCommandClient;
      manager.runCommandStream = originalRunCommandStream;
      manager.createLogWriter = originalCreateLogWriter;
    }
  });

  it("should start background commands immediately and expose live log status", async () => {
    manager.setConfig(
      {
        dev: baseConfig({
          commandWhitelist: ["^pwd$"],
        }),
      },
      ["dev"],
    );

    const originalAcquireSshClient = manager.acquireSshClient;
    const originalRunCommandStream = manager.runCommandStream;
    const tempRoot = path.resolve(
      process.cwd(),
      `handfree-background-log-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    let finishCommand!: () => void;
    let commandStarted = false;

    manager.setOutputLogRoot(tempRoot);
    manager.acquireSshClient = async () => ({
      client: {},
      close: () => {},
    });
    manager.runCommandStream = async (
      _cmd: string,
      _client: unknown,
      _timeout: number,
      sinks: { logWriter?: { appendStdout?: (chunk: string) => void } },
    ) => {
      commandStarted = true;
      sinks.logWriter?.appendStdout?.("hello\n");
      await new Promise<void>((resolve) => {
        finishCommand = resolve;
      });
      sinks.logWriter?.appendStdout?.("world\n");
      return 0;
    };

    try {
      const started = manager.startCommandBackground("pwd", "dev", {
        timeout: 100,
        maxRetries: 0,
      });
      assert.strictEqual(started.status, "running");
      assert.strictEqual(started.serverName, "dev");
      assert.ok(started.runId);
      assert.ok(started.logPath.startsWith(tempRoot));

      for (let i = 0; i < 20 && !commandStarted; i++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.strictEqual(commandStarted, true);

      let running = manager.getBackgroundCommandStatus(started.runId, 4096);
      assert.strictEqual(running.status, "running");
      assert.match(running.outputTail ?? "", /hello/);

      finishCommand();
      for (let i = 0; i < 20; i++) {
        const status = manager.getBackgroundCommandStatus(started.runId, 4096);
        if (status.status === "completed") {
          running = status;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }

      assert.strictEqual(running.status, "completed");
      assert.match(running.outputTail ?? "", /world/);
      assert.match(running.outputTail ?? "", /=== END ===/);
    } finally {
      manager.acquireSshClient = originalAcquireSshClient;
      manager.runCommandStream = originalRunCommandStream;
      manager.setOutputLogRoot(null);
      fsForTest.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("should fail background commands when the background promise exceeds its timeout", async () => {
    manager.setConfig(
      {
        dev: baseConfig({
          commandWhitelist: ["^pwd$"],
        }),
      },
      ["dev"],
    );

    const originalAcquireSshClient = manager.acquireSshClient;
    const originalRunCommandStream = manager.runCommandStream;
    const tempRoot = path.resolve(
      process.cwd(),
      `handfree-background-timeout-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    let closeCalls = 0;

    manager.setOutputLogRoot(tempRoot);
    manager.acquireSshClient = async () => ({
      client: {},
      close: () => {
        closeCalls += 1;
      },
    });
    manager.runCommandStream = async () => {
      await new Promise<void>(() => {
        // Simulate an internal path that never settles.
      });
      return 0;
    };

    try {
      const started = manager.startCommandBackground("pwd", "dev", {
        timeout: 10,
        maxRetries: 0,
      });

      let status = manager.getBackgroundCommandStatus(started.runId, 4096);
      for (let i = 0; i < 40 && status.status === "running"; i++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        status = manager.getBackgroundCommandStatus(started.runId, 4096);
      }

      assert.strictEqual(status.status, "failed");
      assert.match(status.error ?? "", /watchdog fired/);
      assert.match(status.outputTail ?? "", /COMMAND_TIMEOUT/);
      assert.match(status.outputTail ?? "", /=== END ===/);
      assert.ok(closeCalls >= 1);
    } finally {
      manager.acquireSshClient = originalAcquireSshClient;
      manager.runCommandStream = originalRunCommandStream;
      manager.setOutputLogRoot(null);
      fsForTest.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("should retry cached streaming connections when exec channel opening never returns", async () => {
    manager.setConfig(
      {
        dev: baseConfig({
          commandWhitelist: ["^pwd$"],
        }),
      },
      ["dev"],
    );

    const originalEnsureConnected = manager.ensureConnected;
    const originalReconnect = manager.reconnect;
    const originalCreateLogWriter = manager.createLogWriter;
    const originalSleep = manager.sleep;
    let execCalls = 0;
    let reconnectCalls = 0;

    const fakeClient = {
      exec: () => {
        execCalls += 1;
        // Simulate a stale ssh2 client whose channel-open callback never fires.
      },
    };

    manager.ensureConnected = async () => fakeClient;
    manager.reconnect = async () => {
      reconnectCalls += 1;
    };
    manager.sleep = async () => {};
    manager.createLogWriter = () => null;

    try {
      await assert.rejects(
        () => manager.executeCommandWithProgress("pwd", "dev", { timeout: 1, maxRetries: 1 }),
        (error: unknown) => error instanceof ToolError && error.code === "SSH_CONNECTION_FAILED",
      );
      assert.strictEqual(execCalls, 2);
      assert.strictEqual(reconnectCalls, 1);
    } finally {
      manager.ensureConnected = originalEnsureConnected;
      manager.reconnect = originalReconnect;
      manager.createLogWriter = originalCreateLogWriter;
      manager.sleep = originalSleep;
    }
  });

  it("should drop a cached streaming connection after final exec channel opening failure", async () => {
    manager.setConfig(
      {
        dev: baseConfig({
          commandWhitelist: ["^pwd$"],
        }),
      },
      ["dev"],
    );

    const originalCreateLogWriter = manager.createLogWriter;
    let execCalls = 0;
    let endCalls = 0;
    const fakeClient = {
      exec: () => {
        execCalls += 1;
        // Simulate a stale ssh2 client whose channel-open callback never fires.
      },
      end: () => {
        endCalls += 1;
      },
    };

    manager.clients.set("dev", fakeClient);
    manager.connected.set("dev", true);
    manager.createLogWriter = () => null;

    try {
      await assert.rejects(
        () => manager.executeCommandWithProgress("pwd", "dev", { timeout: 1, maxRetries: 0 }),
        (error: unknown) => error instanceof ToolError && error.code === "SSH_CONNECTION_FAILED",
      );
      assert.strictEqual(execCalls, 1);
      assert.strictEqual(endCalls, 1);
      assert.strictEqual(manager.clients.has("dev"), false);
      assert.strictEqual(manager.connected.get("dev"), false);
    } finally {
      manager.createLogWriter = originalCreateLogWriter;
      manager.closeConnection("dev");
    }
  });

  it("should close one-shot streaming command connections when exec channel opening times out", async () => {
    manager.setConfig(
      {
        dev: baseConfig({
          commandWhitelist: ["^pwd$"],
        }),
      },
      ["dev"],
    );

    const originalConnectCommandClient = manager.connectCommandClient;
    const originalCreateLogWriter = manager.createLogWriter;
    let closeCalls = 0;
    let execCalls = 0;

    manager.connectCommandClient = async () => ({
      client: {
        exec: () => {
          execCalls += 1;
          // Simulate channel-open callback never firing.
        },
      } as any,
      close: () => {
        closeCalls += 1;
      },
    });
    manager.createLogWriter = () => null;

    try {
      await assert.rejects(
        () => manager.executeCommandWithProgress("pwd", "dev", {
          timeout: 1,
          maxRetries: 0,
          reuseConnection: false,
        }),
        (error: unknown) => error instanceof ToolError && error.code === "SSH_CONNECTION_FAILED",
      );
      assert.strictEqual(execCalls, 1);
      assert.strictEqual(closeCalls, 1);
    } finally {
      manager.connectCommandClient = originalConnectCommandClient;
      manager.createLogWriter = originalCreateLogWriter;
    }
  });

  it("should time out cached jump setup on the buffered default reuse path", async () => {
    manager.setConfig(
      {
        bastion: baseConfig({ name: "bastion" }),
        dev: baseConfig({
          name: "dev",
          jumpHost: "bastion",
          commandWhitelist: ["^pwd$"],
        }),
      },
      ["bastion", "dev"],
    );

    const originalOpenJumpTunnel = manager.openJumpTunnel;
    const originalRunCommandStream = manager.runCommandStream;
    let observedTimeout: number | undefined;
    let runCalls = 0;

    manager.openJumpTunnel = async (
      _targetKey: string,
      _config: unknown,
      _debug?: unknown,
      timeout?: number,
    ) => {
      observedTimeout = timeout;
      return new Promise(() => {});
    };
    manager.runCommandStream = async () => {
      runCalls += 1;
      return 0;
    };

    try {
      await assert.rejects(
        () => manager.executeCommand("pwd", "dev", { timeout: 1, maxRetries: 0 }),
        (error: unknown) =>
          error instanceof ToolError &&
          error.code === "SSH_CONNECTION_FAILED" &&
          /jump tunnel.*timed out/.test(error.message),
      );
      assert.strictEqual(observedTimeout, 1);
      assert.strictEqual(runCalls, 0);
      assert.notStrictEqual(manager.connected.get("dev"), true);
      assert.strictEqual(manager.clients.has("dev"), false);
    } finally {
      manager.openJumpTunnel = originalOpenJumpTunnel;
      manager.runCommandStream = originalRunCommandStream;
    }
  });

  it("should time out cached jump setup on the streaming default reuse path", async () => {
    manager.setConfig(
      {
        bastion: baseConfig({ name: "bastion" }),
        dev: baseConfig({
          name: "dev",
          jumpHost: "bastion",
          commandWhitelist: ["^pwd$"],
        }),
      },
      ["bastion", "dev"],
    );

    const originalOpenJumpTunnel = manager.openJumpTunnel;
    const originalRunCommandStream = manager.runCommandStream;
    let observedTimeout: number | undefined;
    let runCalls = 0;

    manager.openJumpTunnel = async (
      _targetKey: string,
      _config: unknown,
      _debug?: unknown,
      timeout?: number,
    ) => {
      observedTimeout = timeout;
      return new Promise(() => {});
    };
    manager.runCommandStream = async () => {
      runCalls += 1;
      return 0;
    };

    try {
      await assert.rejects(
        () => manager.executeCommandWithProgress("pwd", "dev", { timeout: 1, maxRetries: 0 }),
        (error: unknown) =>
          error instanceof ToolError &&
          error.code === "SSH_CONNECTION_FAILED" &&
          /jump tunnel.*timed out/.test(error.message),
      );
      assert.strictEqual(observedTimeout, 1);
      assert.strictEqual(runCalls, 0);
      assert.notStrictEqual(manager.connected.get("dev"), true);
      assert.strictEqual(manager.clients.has("dev"), false);
    } finally {
      manager.openJumpTunnel = originalOpenJumpTunnel;
      manager.runCommandStream = originalRunCommandStream;
    }
  });

  it("should time out cached SOCKS setup on the buffered default reuse path", async () => {
    manager.setConfig(
      {
        dev: baseConfig({
          socksProxy: "socks5://127.0.0.1:1080",
          commandWhitelist: ["^pwd$"],
        }),
      },
      ["dev"],
    );

    const originalCreateConnection = SocksClient.createConnection;
    const originalRunCommandStream = manager.runCommandStream;
    let observedTimeout: number | undefined;
    let runCalls = 0;

    (SocksClient as any).createConnection = (options: { timeout?: number }) => {
      observedTimeout = options.timeout;
      return new Promise(() => {});
    };
    manager.runCommandStream = async () => {
      runCalls += 1;
      return 0;
    };

    try {
      await assert.rejects(
        () => manager.executeCommand("pwd", "dev", { timeout: 1, maxRetries: 0 }),
        (error: unknown) =>
          error instanceof ToolError &&
          error.code === "SSH_CONNECTION_FAILED" &&
          /SOCKS proxy connection.*timed out/.test(error.message),
      );
      assert.strictEqual(observedTimeout, 1);
      assert.strictEqual(runCalls, 0);
      assert.notStrictEqual(manager.connected.get("dev"), true);
      assert.strictEqual(manager.clients.has("dev"), false);
    } finally {
      (SocksClient as any).createConnection = originalCreateConnection;
      manager.runCommandStream = originalRunCommandStream;
    }
  });

  it("should time out cached SOCKS setup on the streaming default reuse path", async () => {
    manager.setConfig(
      {
        dev: baseConfig({
          socksProxy: "socks5://127.0.0.1:1080",
          commandWhitelist: ["^pwd$"],
        }),
      },
      ["dev"],
    );

    const originalCreateConnection = SocksClient.createConnection;
    const originalRunCommandStream = manager.runCommandStream;
    let observedTimeout: number | undefined;
    let runCalls = 0;

    (SocksClient as any).createConnection = (options: { timeout?: number }) => {
      observedTimeout = options.timeout;
      return new Promise(() => {});
    };
    manager.runCommandStream = async () => {
      runCalls += 1;
      return 0;
    };

    try {
      await assert.rejects(
        () => manager.executeCommandWithProgress("pwd", "dev", { timeout: 1, maxRetries: 0 }),
        (error: unknown) =>
          error instanceof ToolError &&
          error.code === "SSH_CONNECTION_FAILED" &&
          /SOCKS proxy connection.*timed out/.test(error.message),
      );
      assert.strictEqual(observedTimeout, 1);
      assert.strictEqual(runCalls, 0);
      assert.notStrictEqual(manager.connected.get("dev"), true);
      assert.strictEqual(manager.clients.has("dev"), false);
    } finally {
      (SocksClient as any).createConnection = originalCreateConnection;
      manager.runCommandStream = originalRunCommandStream;
    }
  });

  it("should time out one-shot jump setup with the caller timeout", async () => {
    manager.setConfig(
      {
        bastion: baseConfig({ name: "bastion" }),
        dev: baseConfig({
          name: "dev",
          jumpHost: "bastion",
          commandWhitelist: ["^pwd$"],
        }),
      },
      ["bastion", "dev"],
    );

    const originalOpenJumpTunnel = manager.openJumpTunnel;
    const debugLines: string[] = [];
    let observedTimeout: number | undefined;
    let observedDebug = false;

    manager.openJumpTunnel = async (
      _targetKey: string,
      _config: unknown,
      debug?: (line: string) => void,
      timeout?: number,
    ) => {
      observedTimeout = timeout;
      observedDebug = Boolean(debug);
      return new Promise(() => {});
    };

    try {
      await assert.rejects(
        () => manager.connectCommandClient("dev", 1, (line: string) => debugLines.push(line)),
        (error: unknown) =>
          error instanceof ToolError &&
          error.code === "SSH_CONNECTION_FAILED" &&
          /jump tunnel.*timed out/.test(error.message),
      );
      assert.strictEqual(observedTimeout, 1);
      assert.strictEqual(observedDebug, true);
      assert.ok(debugLines.some((line) => /jump tunnel.*timed out/.test(line)));
    } finally {
      manager.openJumpTunnel = originalOpenJumpTunnel;
    }
  });

  it("should time out one-shot SOCKS setup with the caller timeout", async () => {
    manager.setConfig(
      {
        dev: baseConfig({
          socksProxy: "socks5://127.0.0.1:1080",
          commandWhitelist: ["^pwd$"],
        }),
      },
      ["dev"],
    );

    const originalCreateConnection = SocksClient.createConnection;
    const debugLines: string[] = [];
    let observedTimeout: number | undefined;

    (SocksClient as any).createConnection = (options: { timeout?: number }) => {
      observedTimeout = options.timeout;
      return new Promise(() => {});
    };

    try {
      await assert.rejects(
        () => manager.connectCommandClient("dev", 1, (line: string) => debugLines.push(line)),
        (error: unknown) =>
          error instanceof ToolError &&
          error.code === "SSH_CONNECTION_FAILED" &&
          /SOCKS proxy connection.*timed out/.test(error.message),
      );
      assert.strictEqual(observedTimeout, 1);
      assert.ok(debugLines.some((line) => /SOCKS proxy connection.*timed out/.test(line)));
    } finally {
      (SocksClient as any).createConnection = originalCreateConnection;
    }
  });

  it("should pass readyTimeout and vvv debug through jump-host clients", async () => {
    const originalConnect = (Client.prototype as any).connect;
    const debugLines: string[] = [];
    let capturedReadyTimeout: number | undefined;

    (Client.prototype as any).connect = function connect(config: {
      readyTimeout?: number;
      debug?: (line: string) => void;
    }) {
      capturedReadyTimeout = config.readyTimeout;
      config.debug?.("jump handshake");
      setImmediate(() => this.emit("ready"));
      return this;
    };

    try {
      const jumpClient = await manager.connectJumpClient(
        "dev",
        "bastion",
        baseConfig({ name: "bastion" }),
        undefined,
        (line: string) => debugLines.push(line),
        123,
      );
      assert.ok(jumpClient);
      assert.strictEqual(capturedReadyTimeout, 123);
      assert.deepStrictEqual(debugLines, ["[ssh2:bastion] jump handshake"]);
    } finally {
      (Client.prototype as any).connect = originalConnect;
    }
  });

  it("should close cached targets that depend on a closed jump host", () => {
    manager.setConfig(
      {
        scnet: baseConfig({ name: "scnet", host: "zzeshell.scnet.cn" }),
        dcu: baseConfig({ name: "dcu", host: "e03r1n03", jumpHost: "scnet" }),
        other: baseConfig({ name: "other", host: "127.0.0.2" }),
      },
      ["scnet", "dcu", "other"],
    );

    let scnetClosed = 0;
    let dcuClosed = 0;
    let jumpClosed = 0;
    let otherClosed = 0;

    manager.clients.set("scnet", { end: () => { scnetClosed += 1; } });
    manager.clients.set("dcu", { end: () => { dcuClosed += 1; } });
    manager.clients.set("other", { end: () => { otherClosed += 1; } });
    manager.jumpClients.set("dcu", [{ end: () => { jumpClosed += 1; } }]);
    manager.connected.set("scnet", true);
    manager.connected.set("dcu", true);
    manager.connected.set("other", true);

    const result = manager.closeConnection("scnet");

    assert.strictEqual(result.requested, "scnet");
    assert.deepStrictEqual(new Set(result.closed), new Set(["scnet", "dcu"]));
    assert.strictEqual(scnetClosed, 1);
    assert.strictEqual(dcuClosed, 1);
    assert.strictEqual(jumpClosed, 1);
    assert.strictEqual(otherClosed, 0);
    assert.strictEqual(manager.clients.has("scnet"), false);
    assert.strictEqual(manager.clients.has("dcu"), false);
    assert.strictEqual(manager.clients.has("other"), true);
    assert.strictEqual(manager.connected.get("scnet"), false);
    assert.strictEqual(manager.connected.get("dcu"), false);
    assert.strictEqual(manager.connected.get("other"), true);
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
      // Forward-slash parent traversal escapes the allowed dir (cwd) on BOTH
      // Windows and POSIX; a backslash is only a separator on Windows and would
      // be a literal filename char on Linux CI (leaving the path inside cwd).
      () => manager.upload("../outside-file.txt", "/tmp/outside-file.txt", "dev"),
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

  it("should allow any absolute remote path by default when allowedRemoteDirectories is unset", () => {
    manager.setConfig({ dev: baseConfig() }, ["dev"]);
    assert.strictEqual(
      manager.validateRemotePath("/home/test/file.txt", "dev"),
      "/home/test/file.txt",
    );
    assert.strictEqual(
      manager.validateRemotePath("/etc/passwd", "dev"),
      "/etc/passwd",
    );
  });

  it("should allow any absolute remote path when allowedRemoteDirectories is empty", () => {
    manager.setConfig(
      { dev: baseConfig({ allowedRemoteDirectories: [] }) },
      ["dev"],
    );
    assert.strictEqual(
      manager.validateRemotePath("/home/test/file.txt", "dev"),
      "/home/test/file.txt",
    );
  });

  it("should allow any absolute remote path when disableSftpPathPolicy is set, even with a restrictive allowlist", () => {
    manager.setConfig(
      { dev: baseConfig({ allowedRemoteDirectories: ["/home/test"], disableSftpPathPolicy: true }) },
      ["dev"],
    );
    assert.strictEqual(
      manager.validateRemotePath("/etc/passwd", "dev"),
      "/etc/passwd",
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

  it("should allow any local path when disableSftpPathPolicy is set", () => {
    const tmp = path.resolve(os.tmpdir());
    manager.setConfig(
      { dev: baseConfig({ disableSftpPathPolicy: true }) },
      ["dev"],
    );
    const file = path.join(tmp, "handfree-test-open.txt");
    assert.strictEqual(manager.validateLocalPath(file, "dev"), file);
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
