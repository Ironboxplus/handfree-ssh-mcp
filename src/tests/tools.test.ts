/**
 * Tools Unit Tests
 * 
 * Tests for list-servers, upload, download, show-whitelist tools
 * Uses mock SSHConnectionManager to avoid actual SSH connections.
 */

import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert";
import { z } from "zod";
import {
  BUILT_IN_COMMAND_BLACKLIST,
  BUILT_IN_DESTRUCTIVE_GUARDS,
  SSHConnectionManager,
} from "../services/ssh-connection-manager.js";
import { registerCloseConnectionTool } from "../tools/close-connection.js";
import { registerCommandStatusTool } from "../tools/command-status.js";
import { registerDownloadTool } from "../tools/download.js";
import { registerExecuteCommandTool } from "../tools/execute-command.js";
import { registerTransferTool } from "../tools/transfer.js";
import { registerUploadTool } from "../tools/upload.js";
import { formatCommandPolicy } from "../tools/show-whitelist.js";
import { ToolError } from "../utils/tool-error.js";

/**
 * Mock SSHConnectionManager for testing tools without real SSH connections
 */
class MockSSHConnectionManager {
  private configs: Record<string, any> = {};
  private enabledServers: string[] = [];
  private defaultName: string = "default";

  setConfig(configs: Record<string, any>, enabledServers?: string[]): void {
    this.configs = configs;
    this.enabledServers = enabledServers || Object.keys(configs);
    if (this.enabledServers.length > 0) {
      this.defaultName = this.enabledServers[0];
    }
  }

  getServerConfig(name?: string): any | null {
    const serverName = name || this.defaultName;
    if (!this.enabledServers.includes(serverName)) {
      return null;
    }
    return this.configs[serverName] || null;
  }

  getAllServerInfos(): Array<{ name: string; host: string; port: number; username: string; connected: boolean }> {
    return this.enabledServers.map(name => {
      const config = this.configs[name];
      return {
        name,
        host: config?.host || "unknown",
        port: config?.port || 22,
        username: config?.username || "unknown",
        connected: false,
      };
    });
  }

  async upload(localPath: string, remotePath: string, connectionName?: string): Promise<string> {
    const serverName = connectionName || this.defaultName;
    if (!this.enabledServers.includes(serverName)) {
      throw new Error(`Server '${serverName}' not enabled`);
    }
    // Mock implementation - just return success message
    return `Uploaded ${localPath} to ${remotePath} on ${serverName}`;
  }

  async download(remotePath: string, localPath: string, connectionName?: string): Promise<string> {
    const serverName = connectionName || this.defaultName;
    if (!this.enabledServers.includes(serverName)) {
      throw new Error(`Server '${serverName}' not enabled`);
    }
    // Mock implementation - just return success message
    return `Downloaded ${remotePath} to ${localPath} from ${serverName}`;
  }

  async executeCommand(command: string, connectionName?: string, options?: any): Promise<string> {
    const serverName = connectionName || this.defaultName;
    if (!this.enabledServers.includes(serverName)) {
      throw new Error(`Server '${serverName}' not enabled`);
    }
    // Mock implementation - simulate command execution
    if (command === "pwd") return "/home/testuser";
    if (command.startsWith("ls")) return "file1.txt\nfile2.txt\ndir1";
    if (command === "hostname") return "test-server";
    if (command === "whoami") return "testuser";
    if (command === "date") return "Sat Jan 24 12:00:00 UTC 2026";
    return `Executed: ${command}`;
  }

  async executeCommandWithProgress(
    command: string,
    connectionName?: string,
    options?: { timeout?: number; onProgress?: (chunk: string) => void }
  ): Promise<string> {
    const serverName = connectionName || this.defaultName;
    if (!this.enabledServers.includes(serverName)) {
      throw new Error(`Server '${serverName}' not enabled`);
    }
    
    // Simulate streaming output
    if (options?.onProgress) {
      options.onProgress("line 1\n");
      options.onProgress("line 2\n");
      options.onProgress("line 3\n");
    }
    return "line 1\nline 2\nline 3\n";
  }

  disconnect(): void {
    // No-op for mock
  }
}

function captureRegisteredTools(): {
  server: { tool: (...args: any[]) => void };
  handlers: Map<string, (args: any, extra?: any) => Promise<any>>;
  schemas: Map<string, Record<string, unknown>>;
} {
  const handlers = new Map<string, (args: any, extra?: any) => Promise<any>>();
  const schemas = new Map<string, Record<string, unknown>>();
  return {
    handlers,
    schemas,
    server: {
      tool(name: string, _description: string, schema: Record<string, unknown>, handler: (args: any, extra?: any) => Promise<any>) {
        handlers.set(name, handler);
        schemas.set(name, schema);
      },
    },
  };
}

// ============================================
// list-servers Tool Tests
// ============================================

describe("list-servers Tool", () => {
  let mockManager: MockSSHConnectionManager;

  beforeEach(() => {
    mockManager = new MockSSHConnectionManager();
  });

  it("should return empty array when no servers configured", () => {
    mockManager.setConfig({}, []);
    const result = mockManager.getAllServerInfos();
    assert.deepStrictEqual(result, []);
  });

  it("should return single server info", () => {
    mockManager.setConfig({
      dev: {
        host: "192.168.1.1",
        port: 22,
        username: "testuser",
        password: "testpass",
      }
    }, ["dev"]);

    const result = mockManager.getAllServerInfos();
    
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].name, "dev");
    assert.strictEqual(result[0].host, "192.168.1.1");
    assert.strictEqual(result[0].port, 22);
    assert.strictEqual(result[0].username, "testuser");
    assert.strictEqual(result[0].connected, false);
  });

  it("should return multiple servers info", () => {
    mockManager.setConfig({
      dev: { host: "10.0.0.1", port: 22, username: "dev" },
      prod: { host: "10.0.0.2", port: 2222, username: "prod" },
      staging: { host: "10.0.0.3", port: 22, username: "staging" },
    }, ["dev", "prod", "staging"]);

    const result = mockManager.getAllServerInfos();
    
    assert.strictEqual(result.length, 3);
    assert.strictEqual(result[0].name, "dev");
    assert.strictEqual(result[1].name, "prod");
    assert.strictEqual(result[2].name, "staging");
    assert.strictEqual(result[1].port, 2222);
  });

  it("should only return enabled servers", () => {
    mockManager.setConfig({
      dev: { host: "10.0.0.1", port: 22, username: "dev" },
      prod: { host: "10.0.0.2", port: 22, username: "prod" },
      staging: { host: "10.0.0.3", port: 22, username: "staging" },
    }, ["dev", "staging"]); // prod not enabled

    const result = mockManager.getAllServerInfos();
    
    assert.strictEqual(result.length, 2);
    const names = result.map(s => s.name);
    assert.ok(names.includes("dev"));
    assert.ok(names.includes("staging"));
    assert.ok(!names.includes("prod"));
  });
});

// ============================================
// show-whitelist Tool Tests
// ============================================

describe("show-whitelist Tool", () => {
  let mockManager: MockSSHConnectionManager;

  beforeEach(() => {
    mockManager = new MockSSHConnectionManager();
  });

  it("should return null for non-existent server", () => {
    mockManager.setConfig({
      dev: { host: "192.168.1.1", username: "test", password: "test" }
    }, ["dev"]);

    const result = mockManager.getServerConfig("nonexistent");
    assert.strictEqual(result, null);
  });

  it("should return config for valid server", () => {
    const devConfig = {
      host: "192.168.1.1",
      port: 22,
      username: "testuser",
      password: "testpass",
      commandWhitelist: ["^ls.*$", "^pwd$"],
    };
    mockManager.setConfig({ dev: devConfig }, ["dev"]);

    const result = mockManager.getServerConfig("dev");
    
    assert.ok(result);
    assert.strictEqual(result.host, "192.168.1.1");
    assert.deepStrictEqual(result.commandWhitelist, ["^ls.*$", "^pwd$"]);
  });

  it("should return default server config when name not specified", () => {
    const devConfig = {
      host: "192.168.1.1",
      username: "dev",
      password: "test",
    };
    mockManager.setConfig({ dev: devConfig }, ["dev"]);

    const result = mockManager.getServerConfig(); // No name - uses default
    
    assert.ok(result);
    assert.strictEqual(result.host, "192.168.1.1");
  });

  it("should return null for disabled server", () => {
    mockManager.setConfig({
      dev: { host: "10.0.0.1", username: "dev", password: "test" },
      prod: { host: "10.0.0.2", username: "prod", password: "test" },
    }, ["dev"]); // Only dev enabled

    const result = mockManager.getServerConfig("prod");
    assert.strictEqual(result, null);
  });

  it("should return config with blacklist", () => {
    const devConfig = {
      host: "192.168.1.1",
      username: "test",
      password: "test",
      commandWhitelist: ["^.*$"],
      commandBlacklist: ["^rm.*$", "^shutdown.*$"],
    };
    mockManager.setConfig({ dev: devConfig }, ["dev"]);

    const result = mockManager.getServerConfig("dev");
    
    assert.ok(result);
    assert.deepStrictEqual(result.commandBlacklist, ["^rm.*$", "^shutdown.*$"]);
  });

  it("should show every built-in command policy blocker", () => {
    const output = formatCommandPolicy({
      name: "dev",
      host: "192.168.1.1",
      port: 22,
      username: "test",
      commandMode: "blacklist",
    });

    for (const { regex, reason } of [
      ...BUILT_IN_DESTRUCTIVE_GUARDS,
      ...BUILT_IN_COMMAND_BLACKLIST,
    ]) {
      assert.ok(output.includes(regex.source), regex.source);
      assert.ok(output.includes(reason), reason);
    }
  });
});

// ============================================
// upload Tool Tests
// ============================================

describe("upload Tool", () => {
  let mockManager: MockSSHConnectionManager;

  beforeEach(() => {
    mockManager = new MockSSHConnectionManager();
    mockManager.setConfig({
      dev: { host: "192.168.1.1", username: "test", password: "test" }
    }, ["dev"]);
  });

  it("should upload file to default server", async () => {
    const result = await mockManager.upload("/local/file.txt", "/remote/file.txt");
    
    assert.ok(result.includes("Uploaded"));
    assert.ok(result.includes("/local/file.txt"));
    assert.ok(result.includes("/remote/file.txt"));
  });

  it("should upload file to specified server", async () => {
    const result = await mockManager.upload("/local/file.txt", "/remote/file.txt", "dev");
    
    assert.ok(result.includes("dev"));
  });

  it("should throw error for disabled server", async () => {
    mockManager.setConfig({
      dev: { host: "192.168.1.1", username: "test", password: "test" },
      prod: { host: "192.168.1.2", username: "test", password: "test" },
    }, ["dev"]); // Only dev enabled

    await assert.rejects(
      () => mockManager.upload("/local/file.txt", "/remote/file.txt", "prod"),
      /not enabled/
    );
  });
});

// ============================================
// download Tool Tests
// ============================================

describe("download Tool", () => {
  let mockManager: MockSSHConnectionManager;

  beforeEach(() => {
    mockManager = new MockSSHConnectionManager();
    mockManager.setConfig({
      dev: { host: "192.168.1.1", username: "test", password: "test" }
    }, ["dev"]);
  });

  it("should download file from default server", async () => {
    const result = await mockManager.download("/remote/file.txt", "/local/file.txt");
    
    assert.ok(result.includes("Downloaded"));
    assert.ok(result.includes("/remote/file.txt"));
    assert.ok(result.includes("/local/file.txt"));
  });

  it("should download file from specified server", async () => {
    const result = await mockManager.download("/remote/file.txt", "/local/file.txt", "dev");
    
    assert.ok(result.includes("dev"));
  });

  it("should throw error for disabled server", async () => {
    mockManager.setConfig({
      dev: { host: "192.168.1.1", username: "test", password: "test" },
      prod: { host: "192.168.1.2", username: "test", password: "test" },
    }, ["dev"]); // Only dev enabled

    await assert.rejects(
      () => mockManager.download("/remote/file.txt", "/local/file.txt", "prod"),
      /not enabled/
    );
  });
});

// ============================================
// execute-command Streaming Mode Tests
// ============================================

describe("execute-command Streaming Mode", () => {
  let mockManager: MockSSHConnectionManager;

  beforeEach(() => {
    mockManager = new MockSSHConnectionManager();
    mockManager.setConfig({
      dev: { host: "192.168.1.1", username: "test", password: "test" }
    }, ["dev"]);
  });

  it("should execute command without streaming", async () => {
    const result = await mockManager.executeCommand("pwd", "dev");
    
    assert.strictEqual(result, "/home/testuser");
  });

  it("should execute command with streaming and receive chunks", async () => {
    const chunks: string[] = [];
    const onProgress = (chunk: string) => chunks.push(chunk);

    const result = await mockManager.executeCommandWithProgress("ls -la", "dev", {
      onProgress,
    });

    assert.ok(chunks.length > 0);
    assert.ok(result.includes("line 1"));
    assert.ok(result.includes("line 2"));
    assert.ok(result.includes("line 3"));
  });

  it("should handle custom timeout", async () => {
    const result = await mockManager.executeCommandWithProgress("long-command", "dev", {
      timeout: 60000,
    });

    assert.ok(result);
  });

  it("should throw error for disabled server in streaming mode", async () => {
    mockManager.setConfig({
      dev: { host: "192.168.1.1", username: "test", password: "test" },
      prod: { host: "192.168.1.2", username: "test", password: "test" },
    }, ["dev"]);

    await assert.rejects(
      () => mockManager.executeCommandWithProgress("pwd", "prod"),
      /not enabled/
    );
  });
});

describe("MCP tool handlers", () => {
  const manager = SSHConnectionManager.getInstance() as any;

  afterEach(() => {
    manager.disconnect();
    manager.setConfig({}, undefined);
  });

  it("should start stream=true commands in the background and return immediately", async () => {
    const originalResolveServer = manager.resolveServer;
    const originalStartCommandBackground = manager.startCommandBackground;
    const originalExecuteCommandWithProgress = manager.executeCommandWithProgress;
    const { server, handlers } = captureRegisteredTools();
    let captured: any;

    manager.resolveServer = (name?: string) => name ?? "dev";
    manager.startCommandBackground = (cmdString: string, connectionName: string, options: any) => {
      captured = { cmdString, connectionName, options };
      return {
        runId: "run-1",
        status: "running",
        serverName: connectionName,
        command: cmdString,
        startedAt: "2026-07-12T00:00:00.000Z",
        logPath: "E:\\logs\\run-1.log",
      };
    };
    manager.executeCommandWithProgress = async () => {
      throw new Error("stream=true should not block waiting for command completion");
    };

    try {
      registerExecuteCommandTool(server as any);
      const handler = handlers.get("execute-command");
      assert.ok(handler, "execute-command handler should be registered");

      const result = await handler(
        {
          cmdString: "pwd",
          connectionName: "dev",
          timeout: 123,
          reuseConnection: false,
          vvv: true,
          maxOutputBytes: 456,
        },
        { _meta: {}, sendNotification: () => {} },
      );

      assert.strictEqual(result.isError, undefined);
      const body = JSON.parse(result.content[0].text);
      assert.strictEqual(body.runId, "run-1");
      assert.strictEqual(body.status, "running");
      assert.strictEqual(body.logPath, "E:\\logs\\run-1.log");
      assert.match(body.next, /command-status/);
      assert.strictEqual(captured.cmdString, "pwd");
      assert.strictEqual(captured.connectionName, "dev");
      assert.strictEqual(captured.options.timeout, 123);
      assert.strictEqual(captured.options.reuseConnection, false);
      assert.strictEqual(captured.options.vvv, true);
      assert.strictEqual(captured.options.maxOutputBytes, 456);
    } finally {
      manager.resolveServer = originalResolveServer;
      manager.startCommandBackground = originalStartCommandBackground;
      manager.executeCommandWithProgress = originalExecuteCommandWithProgress;
    }
  });

  it("should forward reuseConnection and vvv on the non-streaming execute-command path", async () => {
    const originalResolveServer = manager.resolveServer;
    const originalExecuteCommand = manager.executeCommand;
    const { server, handlers } = captureRegisteredTools();
    let captured: any;

    manager.resolveServer = (name?: string) => name ?? "dev";
    manager.executeCommand = async (cmdString: string, connectionName: string, options: any) => {
      captured = { cmdString, connectionName, options };
      return "ok";
    };

    try {
      registerExecuteCommandTool(server as any);
      const handler = handlers.get("execute-command");
      assert.ok(handler, "execute-command handler should be registered");

      const result = await handler(
        {
          cmdString: "pwd",
          connectionName: "dev",
          stream: false,
          timeout: 123,
          reuseConnection: false,
          vvv: true,
          maxOutputBytes: 456,
        },
        { _meta: {}, sendNotification: () => {} },
      );

      assert.deepStrictEqual(result, { content: [{ type: "text", text: "ok" }] });
      assert.strictEqual(captured.cmdString, "pwd");
      assert.strictEqual(captured.connectionName, "dev");
      assert.strictEqual(captured.options.timeout, 123);
      assert.strictEqual(captured.options.reuseConnection, false);
      assert.strictEqual(captured.options.vvv, true);
      assert.strictEqual(captured.options.maxOutputBytes, 456);
    } finally {
      manager.resolveServer = originalResolveServer;
      manager.executeCommand = originalExecuteCommand;
    }
  });

  it("should reject a non-positive timeout in the execute-command schema", () => {
    const { server, schemas } = captureRegisteredTools();
    registerExecuteCommandTool(server as any);
    const schema = schemas.get("execute-command");
    assert.ok(schema, "execute-command schema should be captured");

    const shape = z.object(schema as z.ZodRawShape);
    // A negative timeout must be rejected at the schema boundary, matching
    // upload/download/transfer which already use z.number().positive().
    assert.strictEqual(
      shape.safeParse({ cmdString: "pwd", timeout: -1 }).success,
      false,
      "negative timeout must be rejected by the execute-command schema",
    );
    assert.strictEqual(
      shape.safeParse({ cmdString: "pwd", timeout: 0 }).success,
      false,
      "zero timeout must be rejected by the execute-command schema",
    );
    // A valid positive timeout must still pass.
    assert.strictEqual(
      shape.safeParse({ cmdString: "pwd", timeout: 5000 }).success,
      true,
      "positive timeout must still be accepted",
    );
  });

  it("should forward SFTP reuseConnection, timeout, vvv, and fast options on upload", async () => {
    const originalResolveServer = manager.resolveServer;
    const originalUpload = manager.upload;
    const { server, handlers } = captureRegisteredTools();
    let captured: any;

    manager.resolveServer = (name?: string) => name ?? "dev";
    manager.upload = async (localPath: string, remotePath: string, connectionName: string, options: any) => {
      captured = { localPath, remotePath, connectionName, options };
      return "uploaded";
    };

    try {
      registerUploadTool(server as any);
      const handler = handlers.get("upload");
      assert.ok(handler, "upload handler should be registered");

      const result = await handler({
        localPath: "local.txt",
        remotePath: "/tmp/local.txt",
        connectionName: "dev",
        skipIfIdentical: false,
        reuseConnection: false,
        timeout: 123,
        vvv: true,
        fast: true,
        sftpConcurrency: 8,
        chunkSize: 65536,
      });

      assert.deepStrictEqual(result, { content: [{ type: "text", text: "uploaded" }] });
      assert.strictEqual(captured.localPath, "local.txt");
      assert.strictEqual(captured.remotePath, "/tmp/local.txt");
      assert.strictEqual(captured.connectionName, "dev");
      assert.deepStrictEqual(captured.options, {
        skipIfIdentical: false,
        reuseConnection: false,
        timeout: 123,
        vvv: true,
        fast: true,
        sftpConcurrency: 8,
        chunkSize: 65536,
      });
    } finally {
      manager.resolveServer = originalResolveServer;
      manager.upload = originalUpload;
    }
  });

  it("should forward SFTP reuseConnection, timeout, vvv, and fast options on download", async () => {
    const originalResolveServer = manager.resolveServer;
    const originalDownload = manager.download;
    const { server, handlers } = captureRegisteredTools();
    let captured: any;

    manager.resolveServer = (name?: string) => name ?? "dev";
    manager.download = async (remotePath: string, localPath: string, connectionName: string, options: any) => {
      captured = { remotePath, localPath, connectionName, options };
      return "downloaded";
    };

    try {
      registerDownloadTool(server as any);
      const handler = handlers.get("download");
      assert.ok(handler, "download handler should be registered");

      const result = await handler({
        remotePath: "/tmp/remote.txt",
        localPath: "remote.txt",
        connectionName: "dev",
        reuseConnection: false,
        timeout: 123,
        vvv: true,
        fast: true,
        sftpConcurrency: 4,
        chunkSize: 131072,
      });

      assert.deepStrictEqual(result, { content: [{ type: "text", text: "downloaded" }] });
      assert.strictEqual(captured.remotePath, "/tmp/remote.txt");
      assert.strictEqual(captured.localPath, "remote.txt");
      assert.strictEqual(captured.connectionName, "dev");
      assert.deepStrictEqual(captured.options, {
        reuseConnection: false,
        timeout: 123,
        vvv: true,
        fast: true,
        sftpConcurrency: 4,
        chunkSize: 131072,
      });
    } finally {
      manager.resolveServer = originalResolveServer;
      manager.download = originalDownload;
    }
  });

  it("should forward SFTP reuseConnection, timeout, vvv, and fast options on transfer upload/download modes", async () => {
    const originalResolveServer = manager.resolveServer;
    const originalUpload = manager.upload;
    const originalDownload = manager.download;
    const { server, handlers } = captureRegisteredTools();
    const captured: any[] = [];

    manager.resolveServer = (name?: string) => name ?? "dev";
    manager.upload = async (localPath: string, remotePath: string, connectionName: string, options: any) => {
      captured.push({ kind: "upload", localPath, remotePath, connectionName, options });
      return "uploaded";
    };
    manager.download = async (remotePath: string, localPath: string, connectionName: string, options: any) => {
      captured.push({ kind: "download", remotePath, localPath, connectionName, options });
      return "downloaded";
    };

    try {
      registerTransferTool(server as any);
      const handler = handlers.get("transfer");
      assert.ok(handler, "transfer handler should be registered");

      await handler({
        mode: "upload",
        localPath: "local.txt",
        remotePath: "/tmp/local.txt",
        connectionName: "dev",
        skipIfIdentical: false,
        reuseConnection: false,
        timeout: 123,
        vvv: true,
        fast: true,
        sftpConcurrency: 8,
        chunkSize: 65536,
      });
      await handler({
        mode: "download",
        localPath: "remote.txt",
        remotePath: "/tmp/remote.txt",
        connectionName: "dev",
        reuseConnection: false,
        timeout: 456,
        vvv: true,
        fast: true,
        sftpConcurrency: 4,
        chunkSize: 131072,
      });

      assert.deepStrictEqual(captured, [
        {
          kind: "upload",
          localPath: "local.txt",
          remotePath: "/tmp/local.txt",
          connectionName: "dev",
          options: {
            skipIfIdentical: false,
            reuseConnection: false,
            timeout: 123,
            vvv: true,
            fast: true,
            sftpConcurrency: 8,
            chunkSize: 65536,
          },
        },
        {
          kind: "download",
          remotePath: "/tmp/remote.txt",
          localPath: "remote.txt",
          connectionName: "dev",
          options: {
            reuseConnection: false,
            timeout: 456,
            vvv: true,
            fast: true,
            sftpConcurrency: 4,
            chunkSize: 131072,
          },
        },
      ]);
    } finally {
      manager.resolveServer = originalResolveServer;
      manager.upload = originalUpload;
      manager.download = originalDownload;
    }
  });

  it("should forward SFTP reuseConnection, timeout, vvv, and fast options on transfer relay mode", async () => {
    const originalTransferBetweenServers = manager.transferBetweenServers;
    const { server, handlers } = captureRegisteredTools();
    let captured: any;

    manager.transferBetweenServers = async (
      sourceServer: string,
      sourceRemotePath: string,
      destServer: string,
      destRemotePath: string,
      options: any,
    ) => {
      captured = { sourceServer, sourceRemotePath, destServer, destRemotePath, options };
      return "relayed";
    };

    try {
      registerTransferTool(server as any);
      const handler = handlers.get("transfer");
      assert.ok(handler, "transfer handler should be registered");

      const result = await handler({
        mode: "relay",
        sourceServer: "src",
        sourceRemotePath: "/tmp/source.txt",
        destServer: "dst",
        destRemotePath: "/tmp/dest.txt",
        skipIfIdentical: false,
        reuseConnection: false,
        timeout: 123,
        vvv: true,
        fast: true,
        sftpConcurrency: 2,
        chunkSize: 32768,
      });

      assert.deepStrictEqual(result, { content: [{ type: "text", text: "relayed" }] });
      assert.deepStrictEqual(captured, {
        sourceServer: "src",
        sourceRemotePath: "/tmp/source.txt",
        destServer: "dst",
        destRemotePath: "/tmp/dest.txt",
        options: {
          skipIfIdentical: false,
          reuseConnection: false,
          timeout: 123,
          vvv: true,
        },
      });
    } finally {
      manager.transferBetweenServers = originalTransferBetweenServers;
    }
  });

  it("should return a JSON success envelope from close-connection", async () => {
    const originalCloseConnection = manager.closeConnection;
    const { server, handlers } = captureRegisteredTools();

    manager.closeConnection = (connectionName?: string) => ({
      requested: connectionName ?? "dev",
      closed: [connectionName ?? "dev"],
    });

    try {
      registerCloseConnectionTool(server as any);
      const handler = handlers.get("close-connection");
      assert.ok(handler, "close-connection handler should be registered");

      const result = await handler({ connectionName: "dev" });
      assert.strictEqual(result.isError, undefined);
      assert.deepStrictEqual(
        JSON.parse(result.content[0].text),
        { requested: "dev", closed: ["dev"] },
      );
    } finally {
      manager.closeConnection = originalCloseConnection;
    }
  });

  it("should return a structured error envelope from close-connection failures", async () => {
    const originalCloseConnection = manager.closeConnection;
    const { server, handlers } = captureRegisteredTools();

    manager.closeConnection = () => {
      throw new ToolError("INVALID_CONFIGURATION", "missing server", false);
    };

    try {
      registerCloseConnectionTool(server as any);
      const handler = handlers.get("close-connection");
      assert.ok(handler, "close-connection handler should be registered");

      const result = await handler({ connectionName: "missing" });
      assert.strictEqual(result.isError, true);
      assert.match(result.content[0].text, /INVALID_CONFIGURATION/);
      assert.match(result.content[0].text, /missing server/);
    } finally {
      manager.closeConnection = originalCloseConnection;
    }
  });

  it("should return a background command status envelope", async () => {
    const originalGetBackgroundCommandStatus = manager.getBackgroundCommandStatus;
    const { server, handlers } = captureRegisteredTools();
    let captured: any;

    manager.getBackgroundCommandStatus = (
      runId?: string,
      maxOutputBytes?: number,
      offset?: number,
      incremental?: boolean,
    ) => {
      captured = { runId, maxOutputBytes, offset, incremental };
      return {
        runId,
        status: "running",
        serverName: "dev",
        command: "sleep 10",
        startedAt: "2026-07-12T00:00:00.000Z",
        logPath: "E:\\logs\\run-1.log",
        outputChunk: "partial output",
        incremental: true,
        outputStartOffset: 456,
        nextOffset: 470,
        fileSize: 470,
        hasMore: false,
      };
    };

    try {
      registerCommandStatusTool(server as any);
      const handler = handlers.get("command-status");
      assert.ok(handler, "command-status handler should be registered");

      const result = await handler(
        {
          runId: "run-1",
          maxOutputBytes: 123,
          offset: 456,
        },
        { _meta: {}, sendNotification: () => {} },
      );

      assert.strictEqual(result.isError, undefined);
      const body = JSON.parse(result.content[0].text);
      assert.strictEqual(body.runId, "run-1");
      assert.strictEqual(body.status, "running");
      assert.strictEqual(body.outputChunk, "partial output");
      assert.strictEqual(body.nextOffset, 470);
      assert.deepStrictEqual(captured, {
        runId: "run-1",
        maxOutputBytes: 123,
        offset: 456,
        incremental: undefined,
      });
    } finally {
      manager.getBackgroundCommandStatus = originalGetBackgroundCommandStatus;
    }
  });
});

// ============================================
// Timeout Behavior Tests (Logic Simulation)
// ============================================

/**
 * Helper to calculate effective timeout based on stream mode
 * Matches the logic in execute-command.ts
 */
function calculateTimeout(stream: boolean | undefined, timeout: number | undefined): number {
  const useStream = stream !== false;
  if (useStream) {
    return timeout || 300000; // 5 min default for streaming
  } else {
    return timeout || 30000; // 30s default for non-streaming
  }
}

describe("Timeout Behavior", () => {
  it("should use default 30s timeout for non-streaming mode", () => {
    const effectiveTimeout = calculateTimeout(false, undefined);
    assert.strictEqual(effectiveTimeout, 30000);
  });

  it("should use default 300s timeout for streaming mode", () => {
    const effectiveTimeout = calculateTimeout(true, undefined);
    assert.strictEqual(effectiveTimeout, 300000);
  });

  it("should use custom timeout when specified in streaming mode", () => {
    const effectiveTimeout = calculateTimeout(true, 60000);
    assert.strictEqual(effectiveTimeout, 60000);
  });

  it("should use custom timeout when specified in non-streaming mode", () => {
    const effectiveTimeout = calculateTimeout(false, 5000);
    assert.strictEqual(effectiveTimeout, 5000);
  });

  it("should default stream to true when not specified (undefined)", () => {
    const effectiveTimeout = calculateTimeout(undefined, undefined);
    // undefined !== false is true, so streaming mode is used
    assert.strictEqual(effectiveTimeout, 300000);
  });
});

// ============================================
// Pattern Helper Function Tests (show-whitelist)
// ============================================

describe("patternToReadable (show-whitelist helper)", () => {
  function patternToReadable(pattern: string): string {
    let readable = pattern;
    readable = readable.replace(/^\^/, "").replace(/\$$/, "");
    
    if (readable === "ls( .*)?") return "ls, ls -la, ls /path, etc.";
    if (readable === "cat .*") return "cat <file>";
    if (readable === "pwd") return "pwd (current directory)";
    if (readable === "whoami") return "whoami (current user)";
    if (readable === "hostname") return "hostname";
    if (readable === "date") return "date (current time)";
    if (readable === "docker ps.*") return "docker ps, docker ps -a, etc.";
    if (readable === "docker logs.*") return "docker logs <container>";
    if (readable === "git .*") return "git <any subcommand>";
    if (readable.includes(".*")) return readable.replace(/\.\*/g, "<any>");
    if (readable.includes(".+")) return readable.replace(/\.\+/g, "<required>");
    
    return readable;
  }

  it("should convert ls pattern to readable", () => {
    assert.strictEqual(patternToReadable("^ls( .*)?$"), "ls, ls -la, ls /path, etc.");
  });

  it("should convert cat pattern to readable", () => {
    assert.strictEqual(patternToReadable("^cat .*$"), "cat <file>");
  });

  it("should convert pwd pattern to readable", () => {
    assert.strictEqual(patternToReadable("^pwd$"), "pwd (current directory)");
  });

  it("should convert docker ps pattern to readable", () => {
    assert.strictEqual(patternToReadable("^docker ps.*$"), "docker ps, docker ps -a, etc.");
  });

  it("should convert git pattern to readable", () => {
    assert.strictEqual(patternToReadable("^git .*$"), "git <any subcommand>");
  });

  it("should replace .* with <any> for unknown patterns", () => {
    assert.strictEqual(patternToReadable("^custom .*$"), "custom <any>");
  });

  it("should replace .+ with <required> for unknown patterns", () => {
    assert.strictEqual(patternToReadable("^custom .+$"), "custom <required>");
  });
});

// ============================================
// Example Generation Tests (show-whitelist)
// ============================================

describe("generateExamples (show-whitelist helper)", () => {
  function generateExamples(whitelist: string[]): string[] {
    const examples: string[] = [];
    
    for (const pattern of whitelist) {
      if (pattern.includes("^ls")) examples.push("ls -la");
      if (pattern.includes("^cat")) examples.push("cat /etc/hostname");
      if (pattern.includes("^pwd")) examples.push("pwd");
      if (pattern.includes("^whoami")) examples.push("whoami");
      if (pattern.includes("^hostname")) examples.push("hostname");
      if (pattern.includes("^date")) examples.push("date");
      if (pattern.includes("^echo")) examples.push("echo 'hello world'");
      if (pattern.includes("^docker ps")) examples.push("docker ps -a");
      if (pattern.includes("^docker logs")) examples.push("docker logs --tail 50 <container>");
      if (pattern.includes("^git")) examples.push("git status");
    }
    
    return [...new Set(examples)];
  }

  it("should generate ls example", () => {
    const examples = generateExamples(["^ls( .*)?$"]);
    assert.ok(examples.includes("ls -la"));
  });

  it("should generate docker examples", () => {
    const examples = generateExamples(["^docker ps.*$", "^docker logs.*$"]);
    assert.ok(examples.includes("docker ps -a"));
    assert.ok(examples.includes("docker logs --tail 50 <container>"));
  });

  it("should generate multiple examples for mixed whitelist", () => {
    const examples = generateExamples([
      "^ls( .*)?$",
      "^cat .*$",
      "^pwd$",
      "^git .*$",
    ]);
    
    assert.ok(examples.includes("ls -la"));
    assert.ok(examples.includes("cat /etc/hostname"));
    assert.ok(examples.includes("pwd"));
    assert.ok(examples.includes("git status"));
  });

  it("should remove duplicates", () => {
    const examples = generateExamples(["^ls.*$", "^ls -la$"]); // Both match ls
    const lsCount = examples.filter(e => e === "ls -la").length;
    assert.strictEqual(lsCount, 1);
  });
});

// ============================================
// Server Selection Tests
// ============================================

describe("Server Selection Logic", () => {
  let mockManager: MockSSHConnectionManager;

  beforeEach(() => {
    mockManager = new MockSSHConnectionManager();
  });

  it("should use first enabled server as default", () => {
    mockManager.setConfig({
      alpha: { host: "10.0.0.1", username: "a", password: "a" },
      beta: { host: "10.0.0.2", username: "b", password: "b" },
    }, ["beta", "alpha"]); // beta is first

    const config = mockManager.getServerConfig();
    assert.ok(config);
    assert.strictEqual(config.host, "10.0.0.2"); // beta's host
  });

  it("should use explicit server name over default", () => {
    mockManager.setConfig({
      dev: { host: "10.0.0.1", username: "dev", password: "dev" },
      prod: { host: "10.0.0.2", username: "prod", password: "prod" },
    }, ["dev", "prod"]);

    const config = mockManager.getServerConfig("prod");
    assert.ok(config);
    assert.strictEqual(config.host, "10.0.0.2");
  });
});

console.log("\n🧪 Running tools unit tests...\n");
