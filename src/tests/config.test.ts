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
import {
  getConfigPath,
  getEnabledServersArg,
  getLoadUserSshConfigFlag,
  getNoSshConfigFlag,
  getSshConfigPathsArg,
  loadConfigFromSources,
  loadConfigFromYaml,
} from "../config/config-loader.js";
import { loadSshConfigFiles } from "../config/ssh-config-loader.js";

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

  it("should extract repeated --ssh-config paths", () => {
    const args = ["--ssh-config", "a,b", "--config", "servers.yaml", "--ssh-config", "c"];
    assert.deepStrictEqual(getSshConfigPathsArg(args), ["a", "b", "c"]);
  });

  it("should detect --no-ssh-config", () => {
    assert.strictEqual(getNoSshConfigFlag(["--config", "servers.yaml", "--no-ssh-config"]), true);
    assert.strictEqual(getNoSshConfigFlag(["--config", "servers.yaml"]), false);
  });

  it("should leave OpenSSH config loading to YAML unless CLI disables it", () => {
    assert.strictEqual(getLoadUserSshConfigFlag(["--config", "servers.yaml"]), undefined);
    assert.strictEqual(
      getLoadUserSshConfigFlag(["--config", "servers.yaml", "--no-ssh-config"]),
      false,
    );
  });
});

describe("OpenSSH Config Loading", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "handfree-ssh-mcp-test-"));
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("should load concrete Host entries from an OpenSSH config", () => {
    const keyPath = path.join(tempDir, "id_ed25519");
    const sshConfigPath = path.join(tempDir, "ssh_config");
    fs.writeFileSync(keyPath, "fake-key");
    fs.writeFileSync(sshConfigPath, `
Host dev
  HostName dev.example.com
  User deploy
  Port 2202
  IdentityFile "${keyPath}"

Host *
  User fallback
`);

    const result = loadSshConfigFiles([sshConfigPath]);
    assert.ok(result.files.includes(fs.realpathSync(sshConfigPath)));
    assert.strictEqual(result.configs.dev.host, "dev.example.com");
    assert.strictEqual(result.configs.dev.username, "deploy");
    assert.strictEqual(result.configs.dev.port, 2202);
    assert.strictEqual(result.configs.dev.privateKey, path.normalize(keyPath));
    assert.strictEqual(result.configs.dev.authOptional, true);
  });

  it("should apply wildcard defaults and token replacement", () => {
    const sshConfigPath = path.join(tempDir, "ssh_config");
    fs.writeFileSync(sshConfigPath, `
Host app
  HostName %n.internal

Host *
  User ops
  Port 2222
  IdentityFile ~/.ssh/%r-%n
`);

    const result = loadSshConfigFiles([sshConfigPath]);
    assert.strictEqual(result.configs.app.host, "app.internal");
    assert.strictEqual(result.configs.app.username, "ops");
    assert.strictEqual(result.configs.app.port, 2222);
    assert.strictEqual(
      result.configs.app.privateKey,
      path.normalize(path.join(os.homedir(), ".ssh", "ops-app")),
    );
  });

  it("should parse OpenSSH keyword=value syntax", () => {
    const keyPath = path.join(tempDir, "id_ed25519");
    const sshConfigPath = path.join(tempDir, "ssh_config");
    fs.writeFileSync(keyPath, "fake-key");
    fs.writeFileSync(sshConfigPath, `
Host eq
  HostName=eq.example.com
  User = deploy
  Port=2202
  IdentityFile = "${keyPath}"
`);

    const result = loadSshConfigFiles([sshConfigPath]);
    assert.strictEqual(result.configs.eq.host, "eq.example.com");
    assert.strictEqual(result.configs.eq.username, "deploy");
    assert.strictEqual(result.configs.eq.port, 2202);
    assert.strictEqual(result.configs.eq.privateKey, path.normalize(keyPath));
  });

  it("should respect OpenSSH disabled identity and agent settings", () => {
    const sshConfigPath = path.join(tempDir, "ssh_config");
    fs.writeFileSync(sshConfigPath, `
Host locked
  HostName locked.example.com
  User deploy
  IdentityFile none
  IdentityAgent none
  IdentitiesOnly yes
`);

    const result = loadSshConfigFiles([sshConfigPath]);
    assert.strictEqual(result.configs.locked.privateKey, undefined);
    assert.strictEqual(result.configs.locked.agent, false);
    assert.strictEqual(result.configs.locked.identitiesOnly, true);
  });

  it("should load Include files", () => {
    const includedPath = path.join(tempDir, "included.conf");
    const sshConfigPath = path.join(tempDir, "ssh_config");
    fs.writeFileSync(includedPath, `
Host inc
  HostName inc.example.com
  User included
`);
    fs.writeFileSync(sshConfigPath, `Include "${includedPath}"`);

    const result = loadSshConfigFiles([sshConfigPath]);
    assert.strictEqual(result.configs.inc.host, "inc.example.com");
    assert.strictEqual(result.configs.inc.username, "included");
    assert.ok(result.files.includes(fs.realpathSync(includedPath)));
  });

  it("should merge YAML server settings over OpenSSH config entries", () => {
    const sshConfigPath = path.join(tempDir, "ssh_config");
    const yamlPath = path.join(tempDir, "servers.yaml");
    fs.writeFileSync(sshConfigPath, `
Host dev
  HostName ssh.example.com
  User sshuser
  Port 22
`);
    fs.writeFileSync(yamlPath, `
servers:
  dev:
    host: yaml.example.com
    whitelist:
      - "^pwd$"
    allowedRemoteDirectories: []
`);

    const result = loadConfigFromSources({
      yamlConfigPath: yamlPath,
      sshConfigPaths: [sshConfigPath],
    });
    assert.strictEqual(result.configs.dev.host, "yaml.example.com");
    assert.strictEqual(result.configs.dev.username, "sshuser");
    assert.deepStrictEqual(result.configs.dev.commandWhitelist, ["^pwd$"]);
    assert.deepStrictEqual(result.configs.dev.allowedRemoteDirectories, []);
  });

  it("should still reject YAML-only servers without auth", () => {
    const yamlPath = path.join(tempDir, "servers.yaml");
    fs.writeFileSync(yamlPath, `
sshConfig: false
servers:
  broken:
    host: 192.168.1.1
    username: test
`);

    assert.throws(
      () => loadConfigFromYaml(yamlPath),
      /password.*privateKey.*required/i,
    );
  });

  it("should reject partial YAML servers without a matching OpenSSH host", () => {
    const yamlPath = path.join(tempDir, "servers.yaml");
    fs.writeFileSync(yamlPath, `
sshConfig: false
servers:
  missing-base:
    whitelist:
      - "^pwd$"
`);

    assert.throws(
      () => loadConfigFromSources({ yamlConfigPath: yamlPath }),
      /host.*required/i,
    );
  });

  it("should let explicit --ssh-config paths override YAML sshConfig false", () => {
    const sshConfigPath = path.join(tempDir, "ssh_config");
    const yamlPath = path.join(tempDir, "servers.yaml");
    fs.writeFileSync(sshConfigPath, `
Host explicit
  HostName explicit.example.com
  User deploy
`);
    fs.writeFileSync(yamlPath, `
sshConfig: false
`);

    const result = loadConfigFromSources({
      yamlConfigPath: yamlPath,
      sshConfigPaths: [sshConfigPath],
    });
    assert.strictEqual(result.configs.explicit.host, "explicit.example.com");
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
