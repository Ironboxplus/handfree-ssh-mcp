/**
 * Command Validation Tests
 * 
 * Tests the whitelist/blacklist pattern matching logic
 * without requiring actual SSH connections.
 */

import { describe, it } from "node:test";
import assert from "node:assert";

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

console.log("\n🧪 Running command validation tests...\n");
