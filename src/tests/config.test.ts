/**
 * handfree-ssh-mcp Test Suite
 * 
 * Run: npm test
 * 
 * Tests config loading, argument parsing, and tool registration
 * without needing an MCP client.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Import modules to test
import { loadConfigFromYaml, getConfigPath, getEnabledServersArg } from "../config/config-loader.js";

describe("Config Loader", () => {
  let tempDir: string;
  let tempConfigPath: string;

  beforeEach(() => {
    // Create temp directory for test configs
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "handfree-ssh-mcp-test-"));
  });

  afterEach(() => {
    // Cleanup temp files
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("should load valid YAML config", () => {
    const configContent = `
defaultServer: dev
servers:
  dev:
    host: 192.168.1.1
    port: 22
    username: testuser
    password: testpass
    whitelist:
      - "^ls.*$"
      - "^pwd$"
`;
    tempConfigPath = path.join(tempDir, "servers.yaml");
    fs.writeFileSync(tempConfigPath, configContent);

    const result = loadConfigFromYaml(tempConfigPath);

    assert.ok(result.configs);
    assert.ok(result.configs["dev"]);
    assert.strictEqual(result.configs["dev"].host, "192.168.1.1");
    assert.strictEqual(result.configs["dev"].port, 22);
    assert.strictEqual(result.configs["dev"].username, "testuser");
    assert.strictEqual(result.configs["dev"].password, "testpass");
    assert.deepStrictEqual(result.configs["dev"].commandWhitelist, ["^ls.*$", "^pwd$"]);
  });

  it("should load multiple servers", () => {
    const configContent = `
servers:
  dev:
    host: 10.0.0.1
    username: dev
    password: devpass
  prod:
    host: 10.0.0.2
    username: prod
    password: prodpass
  staging:
    host: 10.0.0.3
    username: staging
    privateKey: ~/.ssh/id_rsa
`;
    tempConfigPath = path.join(tempDir, "multi.yaml");
    fs.writeFileSync(tempConfigPath, configContent);

    const result = loadConfigFromYaml(tempConfigPath);

    assert.strictEqual(Object.keys(result.configs).length, 3);
    assert.ok(result.configs["dev"]);
    assert.ok(result.configs["prod"]);
    assert.ok(result.configs["staging"]);
  });

  it("should throw on missing host", () => {
    const configContent = `
servers:
  broken:
    username: test
    password: test
`;
    tempConfigPath = path.join(tempDir, "broken.yaml");
    fs.writeFileSync(tempConfigPath, configContent);

    assert.throws(
      () => loadConfigFromYaml(tempConfigPath),
      /host.*required/i
    );
  });

  it("should throw on missing username", () => {
    const configContent = `
servers:
  broken:
    host: 192.168.1.1
    password: test
`;
    tempConfigPath = path.join(tempDir, "broken.yaml");
    fs.writeFileSync(tempConfigPath, configContent);

    assert.throws(
      () => loadConfigFromYaml(tempConfigPath),
      /username.*required/i
    );
  });

  it("should throw on missing auth (no password or privateKey)", () => {
    const configContent = `
servers:
  broken:
    host: 192.168.1.1
    username: test
`;
    tempConfigPath = path.join(tempDir, "broken.yaml");
    fs.writeFileSync(tempConfigPath, configContent);

    assert.throws(
      () => loadConfigFromYaml(tempConfigPath),
      /password.*privateKey.*required/i
    );
  });

  it("should expand ~ in privateKey path", () => {
    const configContent = `
servers:
  dev:
    host: 192.168.1.1
    username: test
    privateKey: ~/.ssh/id_rsa
`;
    tempConfigPath = path.join(tempDir, "key.yaml");
    fs.writeFileSync(tempConfigPath, configContent);

    const result = loadConfigFromYaml(tempConfigPath);
    
    assert.ok(result.configs["dev"].privateKey);
    assert.ok(!result.configs["dev"].privateKey!.startsWith("~"));
    assert.ok(result.configs["dev"].privateKey!.includes(os.homedir()));
  });

  it("should handle preConnect flag", () => {
    const configContent = `
preConnect: true
servers:
  dev:
    host: 192.168.1.1
    username: test
    password: test
`;
    tempConfigPath = path.join(tempDir, "preconnect.yaml");
    fs.writeFileSync(tempConfigPath, configContent);

    const result = loadConfigFromYaml(tempConfigPath);
    
    assert.strictEqual(result.preConnect, true);
  });

  it("should throw on non-existent config file", () => {
    assert.throws(
      () => loadConfigFromYaml("/nonexistent/path/servers.yaml"),
      /not found/i
    );
  });

  it("should throw on invalid YAML", () => {
    const configContent = `
servers:
  dev:
    host: 192.168.1.1
    username: test
    password: test
  invalid yaml here [[[
`;
    tempConfigPath = path.join(tempDir, "invalid.yaml");
    fs.writeFileSync(tempConfigPath, configContent);

    assert.throws(
      () => loadConfigFromYaml(tempConfigPath),
      /parse|yaml/i
    );
  });
});

describe("Argument Parsing", () => {
  it("should extract --config path", () => {
    const args = ["--config", "/path/to/servers.yaml", "--enable-servers", "dev"];
    const configPath = getConfigPath(args);
    assert.strictEqual(configPath, "/path/to/servers.yaml");
  });

  it("should return null if --config not provided", () => {
    const args = ["--enable-servers", "dev"];
    const configPath = getConfigPath(args);
    assert.strictEqual(configPath, null);
  });

  it("should extract --enable-servers list", () => {
    const args = ["--config", "test.yaml", "--enable-servers", "dev,prod,staging"];
    const servers = getEnabledServersArg(args);
    assert.deepStrictEqual(servers, ["dev", "prod", "staging"]);
  });

  it("should return null if --enable-servers not provided", () => {
    const args = ["--config", "test.yaml"];
    const servers = getEnabledServersArg(args);
    assert.strictEqual(servers, null);
  });

  it("should handle single server in --enable-servers", () => {
    const args = ["--enable-servers", "dev"];
    const servers = getEnabledServersArg(args);
    assert.deepStrictEqual(servers, ["dev"]);
  });

  it("should trim whitespace from server names", () => {
    const args = ["--enable-servers", "dev , prod , staging"];
    const servers = getEnabledServersArg(args);
    assert.deepStrictEqual(servers, ["dev", "prod", "staging"]);
  });
});

describe("Whitelist/Blacklist Config", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "handfree-ssh-mcp-test-"));
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("should load whitelist patterns", () => {
    const configContent = `
servers:
  dev:
    host: 192.168.1.1
    username: test
    password: test
    whitelist:
      - "^ls( .*)?$"
      - "^cat .*$"
      - "^docker ps.*$"
`;
    const tempConfigPath = path.join(tempDir, "whitelist.yaml");
    fs.writeFileSync(tempConfigPath, configContent);

    const result = loadConfigFromYaml(tempConfigPath);
    
    assert.deepStrictEqual(result.configs["dev"].commandWhitelist, [
      "^ls( .*)?$",
      "^cat .*$",
      "^docker ps.*$"
    ]);
  });

  it("should load blacklist patterns", () => {
    const configContent = `
servers:
  dev:
    host: 192.168.1.1
    username: test
    password: test
    blacklist:
      - "^rm .*$"
      - "^shutdown.*$"
`;
    const tempConfigPath = path.join(tempDir, "blacklist.yaml");
    fs.writeFileSync(tempConfigPath, configContent);

    const result = loadConfigFromYaml(tempConfigPath);
    
    assert.deepStrictEqual(result.configs["dev"].commandBlacklist, [
      "^rm .*$",
      "^shutdown.*$"
    ]);
  });

  it("should load both whitelist and blacklist", () => {
    const configContent = `
servers:
  dev:
    host: 192.168.1.1
    username: test
    password: test
    whitelist:
      - "^.*$"
    blacklist:
      - "^rm -rf.*$"
`;
    const tempConfigPath = path.join(tempDir, "both.yaml");
    fs.writeFileSync(tempConfigPath, configContent);

    const result = loadConfigFromYaml(tempConfigPath);
    
    assert.deepStrictEqual(result.configs["dev"].commandWhitelist, ["^.*$"]);
    assert.deepStrictEqual(result.configs["dev"].commandBlacklist, ["^rm -rf.*$"]);
  });
});

describe("SFTP Path Allowlist Config", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "handfree-ssh-mcp-test-"));
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("should load allowedRemoteDirectories", () => {
    const configContent = `
servers:
  dev:
    host: 192.168.1.1
    username: test
    password: test
    allowedRemoteDirectories:
      - /home/test
      - /tmp
`;
    const p = path.join(tempDir, "ard.yaml");
    fs.writeFileSync(p, configContent);

    const result = loadConfigFromYaml(p);
    assert.deepStrictEqual(
      result.configs["dev"].allowedRemoteDirectories,
      ["/home/test", "/tmp"],
    );
  });

  it("should strip trailing slashes from allowedRemoteDirectories", () => {
    const configContent = `
servers:
  dev:
    host: 192.168.1.1
    username: test
    password: test
    allowedRemoteDirectories:
      - /home/test/
      - /tmp/
      - /
`;
    const p = path.join(tempDir, "ard-slash.yaml");
    fs.writeFileSync(p, configContent);

    const result = loadConfigFromYaml(p);
    assert.deepStrictEqual(
      result.configs["dev"].allowedRemoteDirectories,
      ["/home/test", "/tmp", "/"],
    );
  });

  it("should reject relative paths in allowedRemoteDirectories", () => {
    const configContent = `
servers:
  dev:
    host: 192.168.1.1
    username: test
    password: test
    allowedRemoteDirectories:
      - home/test
`;
    const p = path.join(tempDir, "ard-rel.yaml");
    fs.writeFileSync(p, configContent);

    assert.throws(
      () => loadConfigFromYaml(p),
      /absolute POSIX path/i,
    );
  });

  it("should reject '..' segments in allowedRemoteDirectories", () => {
    const configContent = `
servers:
  dev:
    host: 192.168.1.1
    username: test
    password: test
    allowedRemoteDirectories:
      - /home/test/../etc
`;
    const p = path.join(tempDir, "ard-dotdot.yaml");
    fs.writeFileSync(p, configContent);

    assert.throws(
      () => loadConfigFromYaml(p),
      /'\.\.'/,
    );
  });

  it("should reject empty string entries in allowedRemoteDirectories", () => {
    const configContent = `
servers:
  dev:
    host: 192.168.1.1
    username: test
    password: test
    allowedRemoteDirectories:
      - ""
`;
    const p = path.join(tempDir, "ard-empty.yaml");
    fs.writeFileSync(p, configContent);

    assert.throws(
      () => loadConfigFromYaml(p),
      /non-empty/i,
    );
  });

  it("should resolve allowedLocalDirectories to absolute paths", () => {
    const configContent = `
servers:
  dev:
    host: 192.168.1.1
    username: test
    password: test
    allowedLocalDirectories:
      - ~/uploads
`;
    const p = path.join(tempDir, "ald.yaml");
    fs.writeFileSync(p, configContent);

    const result = loadConfigFromYaml(p);
    const resolved = result.configs["dev"].allowedLocalDirectories;
    assert.ok(resolved && resolved.length === 1);
    assert.ok(path.isAbsolute(resolved[0]));
    assert.ok(resolved[0].includes(os.homedir()));
  });

  it("should leave allowedRemoteDirectories undefined when not set", () => {
    const configContent = `
servers:
  dev:
    host: 192.168.1.1
    username: test
    password: test
`;
    const p = path.join(tempDir, "no-ard.yaml");
    fs.writeFileSync(p, configContent);

    const result = loadConfigFromYaml(p);
    assert.strictEqual(result.configs["dev"].allowedRemoteDirectories, undefined);
    assert.strictEqual(result.configs["dev"].allowedLocalDirectories, undefined);
  });
});

describe("Output Log Dir Config", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "handfree-ssh-mcp-test-"));
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("should leave outputLogDir undefined when not set", () => {
    const configContent = `
servers:
  dev:
    host: 192.168.1.1
    username: test
    password: test
`;
    const p = path.join(tempDir, "no-log.yaml");
    fs.writeFileSync(p, configContent);
    const result = loadConfigFromYaml(p);
    assert.strictEqual(result.outputLogDir, undefined);
  });

  it("should resolve outputLogDir to an absolute path", () => {
    const configContent = `
outputLogDir: ./logs
servers:
  dev:
    host: 192.168.1.1
    username: test
    password: test
`;
    const p = path.join(tempDir, "log.yaml");
    fs.writeFileSync(p, configContent);
    const result = loadConfigFromYaml(p);
    assert.ok(result.outputLogDir);
    assert.ok(path.isAbsolute(result.outputLogDir!));
    assert.ok(result.outputLogDir!.endsWith(path.normalize("logs")));
  });

  it("should expand ~ in outputLogDir", () => {
    const configContent = `
outputLogDir: ~/handfree-logs
servers:
  dev:
    host: 192.168.1.1
    username: test
    password: test
`;
    const p = path.join(tempDir, "log-tilde.yaml");
    fs.writeFileSync(p, configContent);
    const result = loadConfigFromYaml(p);
    assert.ok(result.outputLogDir);
    assert.ok(result.outputLogDir!.includes(os.homedir()));
  });

  it("should reject non-string outputLogDir", () => {
    const configContent = `
outputLogDir: 42
servers:
  dev:
    host: 192.168.1.1
    username: test
    password: test
`;
    const p = path.join(tempDir, "log-bad.yaml");
    fs.writeFileSync(p, configContent);
    assert.throws(() => loadConfigFromYaml(p), /non-empty string/i);
  });
});

console.log("\n🧪 Running handfree-ssh-mcp tests...\n");
