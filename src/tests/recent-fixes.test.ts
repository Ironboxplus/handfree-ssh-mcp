/**
 * Whitebox tests for the recent code-review fixes:
 *
 *   f1: connect() in-flight dedup (no duplicate SSH clients on parallel calls)
 *   f2: --pre-connect CLI flag parsing
 *   f5: isPathInSafeDirectory boundary check
 *   default-name behavior: empty in multi-server mode, set in single-server mode
 *
 * These reach into SSHConnectionManager via `as any` to exercise private
 * surfaces directly, matching the style of command-validation.test.ts.
 */

import { afterEach, describe, it } from "node:test";
import assert from "node:assert";
import { SSHConnectionManager } from "../services/ssh-connection-manager.js";
import { getPreConnectFlag } from "../config/config-loader.js";

const baseConfig = (overrides: Record<string, unknown> = {}) => ({
  name: "dev",
  host: "127.0.0.1",
  port: 22,
  username: "root",
  password: "test-password",
  safeDirectory: "/root",
  ...overrides,
});

describe("getPreConnectFlag", () => {
  it("returns true when --pre-connect is present", () => {
    assert.strictEqual(
      getPreConnectFlag(["--config", "x.yaml", "--pre-connect", "--enable-servers", "a"]),
      true,
    );
  });

  it("returns false when --pre-connect is absent", () => {
    assert.strictEqual(
      getPreConnectFlag(["--config", "x.yaml", "--enable-servers", "a"]),
      false,
    );
  });

  it("returns false for empty args", () => {
    assert.strictEqual(getPreConnectFlag([]), false);
  });
});

/**
 * Reset only the state we care about, without invoking disconnect() (which
 * assumes real ssh2 clients with an .end() method). Tests in this file stub
 * doConnect and store sentinel objects in the clients map.
 */
function resetManagerState(manager: any): void {
  manager.connecting?.clear?.();
  manager.connected?.clear?.();
  manager.clients?.clear?.();
  manager.setConfig({}, undefined);
}

describe("SSHConnectionManager.connect() in-flight dedup", () => {
  const manager = SSHConnectionManager.getInstance() as any;

  afterEach(() => {
    resetManagerState(manager);
  });

  it("collapses concurrent connect() calls for the same server into one doConnect", async () => {
    manager.setConfig({ dev: baseConfig() }, ["dev"]);

    let doConnectCalls = 0;
    const originalDoConnect = manager.doConnect;
    manager.doConnect = async (key: string) => {
      doConnectCalls += 1;
      // Tiny tick so all callers are queued on the same promise.
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      manager.connected.set(key, true);
      manager.clients.set(key, { fake: true });
    };

    try {
      await Promise.all([
        manager.connect("dev"),
        manager.connect("dev"),
        manager.connect("dev"),
        manager.connect("dev"),
      ]);
      assert.strictEqual(doConnectCalls, 1, "doConnect must run exactly once for concurrent calls");
      assert.strictEqual(manager.clients.size, 1, "exactly one SSH client must be stored");
    } finally {
      manager.doConnect = originalDoConnect;
    }
  });

  it("clears the in-flight entry after success so the next connect can reconnect", async () => {
    manager.setConfig({ dev: baseConfig() }, ["dev"]);

    let doConnectCalls = 0;
    const originalDoConnect = manager.doConnect;
    manager.doConnect = async (key: string) => {
      doConnectCalls += 1;
      manager.connected.set(key, true);
      manager.clients.set(key, { fake: true, n: doConnectCalls });
    };

    try {
      await manager.connect("dev");
      // Mark disconnected to force a second real connect.
      manager.connected.set("dev", false);
      manager.clients.delete("dev");
      await manager.connect("dev");
      assert.strictEqual(doConnectCalls, 2);
      assert.strictEqual(manager.connecting.size, 0, "in-flight map must be empty after settle");
    } finally {
      manager.doConnect = originalDoConnect;
    }
  });

  it("clears the in-flight entry on failure so the next connect can retry", async () => {
    manager.setConfig({ dev: baseConfig() }, ["dev"]);

    let doConnectCalls = 0;
    const originalDoConnect = manager.doConnect;
    manager.doConnect = async (_key: string) => {
      doConnectCalls += 1;
      throw new Error("simulated connect failure");
    };

    try {
      await assert.rejects(manager.connect("dev"));
      assert.strictEqual(manager.connecting.size, 0, "in-flight map must be cleared after rejection");
      // Second call must attempt doConnect again, not return the stale rejected promise.
      await assert.rejects(manager.connect("dev"));
      assert.strictEqual(doConnectCalls, 2);
    } finally {
      manager.doConnect = originalDoConnect;
    }
  });

  it("does not let a closed stale connect promise delete a newer in-flight connect", async () => {
    manager.setConfig({ dev: baseConfig() }, ["dev"]);

    const originalDoConnect = manager.doConnect;
    let doConnectCalls = 0;
    let resolveFirst!: () => void;
    let resolveSecond!: () => void;

    manager.doConnect = async () => {
      doConnectCalls += 1;
      if (doConnectCalls === 1) {
        return new Promise<void>((resolve) => {
          resolveFirst = resolve;
        });
      }
      return new Promise<void>((resolve) => {
        resolveSecond = resolve;
      });
    };

    try {
      const firstConnect = manager.connect("dev");
      const firstTracked = manager.connecting.get("dev");
      assert.ok(firstTracked, "first connect should install an in-flight promise");

      manager.closeConnection("dev");
      assert.strictEqual(manager.connecting.has("dev"), false);

      const secondConnect = manager.connect("dev");
      const secondTracked = manager.connecting.get("dev");
      assert.ok(secondTracked, "second connect should install a fresh in-flight promise");
      assert.notStrictEqual(secondTracked, firstTracked);

      resolveFirst();
      await firstConnect;
      assert.strictEqual(
        manager.connecting.get("dev"),
        secondTracked,
        "stale first connect must not delete the newer in-flight entry",
      );

      resolveSecond();
      await secondConnect;
      assert.strictEqual(manager.connecting.has("dev"), false);
      assert.strictEqual(doConnectCalls, 2);
    } finally {
      manager.doConnect = originalDoConnect;
    }
  });

  it("returns immediately for an already-connected server without invoking doConnect", async () => {
    manager.setConfig({ dev: baseConfig() }, ["dev"]);
    manager.connected.set("dev", true);
    manager.clients.set("dev", { fake: true });

    let doConnectCalls = 0;
    const originalDoConnect = manager.doConnect;
    manager.doConnect = async () => {
      doConnectCalls += 1;
    };

    try {
      await manager.connect("dev");
      await manager.connect("dev");
      assert.strictEqual(doConnectCalls, 0);
    } finally {
      manager.doConnect = originalDoConnect;
    }
  });

  it("invalidates pending clients when hot-reload changes connection fields", () => {
    manager.setConfig({ dev: baseConfig() }, ["dev"]);
    const pendingClient = {
      ended: false,
      end() {
        this.ended = true;
      },
    };
    manager.pendingClients.set("dev", pendingClient);
    manager.connecting.set("dev", Promise.resolve());
    const generationBefore = manager.connectionGenerations.get("dev") ?? 0;

    manager.replaceConfig(
      { dev: baseConfig({ host: "127.0.0.2" }) },
      ["dev"],
    );

    assert.strictEqual(pendingClient.ended, true);
    assert.strictEqual(manager.pendingClients.has("dev"), false);
    assert.strictEqual(manager.connecting.has("dev"), false);
    assert.strictEqual(
      manager.connectionGenerations.get("dev"),
      generationBefore + 1,
    );
  });

  it("resets a target when an upstream jump host's connection fields change", () => {
    manager.setConfig(
      {
        bastion: baseConfig({ name: "bastion" }),
        target: baseConfig({ name: "target", jumpHost: "bastion" }),
      },
      ["bastion", "target"],
    );
    // Pretend the target is live through the chain.
    manager.connected.set("target", true);
    manager.clients.set("target", { end() {} });
    const genBefore = manager.connectionGenerations.get("target") ?? 0;

    manager.replaceConfig(
      {
        // Upstream hop changed; the target's own fields are untouched.
        bastion: baseConfig({ name: "bastion", host: "10.9.9.9" }),
        target: baseConfig({ name: "target", jumpHost: "bastion" }),
      },
      ["bastion", "target"],
    );

    assert.strictEqual(manager.connected.get("target"), false);
    assert.strictEqual(
      manager.connectionGenerations.get("target"),
      genBefore + 1,
    );
  });

  it("leaves a target connected when nothing in its jump chain changed", () => {
    manager.setConfig(
      {
        bastion: baseConfig({ name: "bastion" }),
        target: baseConfig({ name: "target", jumpHost: "bastion" }),
      },
      ["bastion", "target"],
    );
    manager.connected.set("target", true);
    manager.clients.set("target", { end() {} });
    const genBefore = manager.connectionGenerations.get("target") ?? 0;

    // A policy-only change on the target (not a connection field).
    manager.replaceConfig(
      {
        bastion: baseConfig({ name: "bastion" }),
        target: baseConfig({
          name: "target",
          jumpHost: "bastion",
          safeDirectory: "/tmp",
        }),
      },
      ["bastion", "target"],
    );

    assert.strictEqual(manager.connected.get("target"), true);
    assert.strictEqual(
      manager.connectionGenerations.get("target"),
      genBefore,
    );
  });
});

describe("SSHConnectionManager default-server semantics", () => {
  const manager = SSHConnectionManager.getInstance() as any;

  afterEach(() => {
    resetManagerState(manager);
  });

  it("sets defaultName when exactly one server is enabled", () => {
    manager.setConfig({ dev: baseConfig() }, ["dev"]);
    assert.strictEqual(manager.defaultName, "dev");
  });

  it("clears defaultName when multiple servers are enabled", () => {
    manager.setConfig(
      {
        dev: baseConfig({ name: "dev" }),
        prod: baseConfig({ name: "prod", host: "127.0.0.2" }),
      },
      ["dev", "prod"],
    );
    assert.strictEqual(manager.defaultName, "");
  });

  it("isMultiServer() reflects the enabled count", () => {
    manager.setConfig({ dev: baseConfig() }, ["dev"]);
    assert.strictEqual(manager.isMultiServer(), false);

    manager.setConfig(
      {
        dev: baseConfig({ name: "dev" }),
        prod: baseConfig({ name: "prod", host: "127.0.0.2" }),
      },
      ["dev", "prod"],
    );
    assert.strictEqual(manager.isMultiServer(), true);
  });

  it("resolveServer() returns the only server in single-server mode without connectionName", () => {
    manager.setConfig({ dev: baseConfig() }, ["dev"]);
    assert.strictEqual(manager.resolveServer(), "dev");
    assert.strictEqual(manager.resolveServer("dev"), "dev");
  });

  it("resolveServer() throws in multi-server mode when connectionName is missing", () => {
    manager.setConfig(
      {
        dev: baseConfig({ name: "dev" }),
        prod: baseConfig({ name: "prod", host: "127.0.0.2" }),
      },
      ["dev", "prod"],
    );
    assert.throws(
      () => manager.resolveServer(),
      (err: any) => err?.code === "INVALID_CONFIGURATION" && /must specify connectionName/.test(err.message),
    );
  });

  it("resolveServer() accepts an explicit name in multi-server mode", () => {
    manager.setConfig(
      {
        dev: baseConfig({ name: "dev" }),
        prod: baseConfig({ name: "prod", host: "127.0.0.2" }),
      },
      ["dev", "prod"],
    );
    assert.strictEqual(manager.resolveServer("prod"), "prod");
  });
});

describe("isPathInSafeDirectory boundary check", () => {
  const manager = SSHConnectionManager.getInstance() as any;
  // The method is private; bind it so we don't depend on a config.
  const check = (filePath: string, safeDir: string): boolean =>
    manager.isPathInSafeDirectory.call(manager, filePath, safeDir);

  it("accepts the safe directory itself", () => {
    assert.strictEqual(check("/home/alice", "/home/alice"), true);
  });

  it("accepts paths directly inside the safe directory", () => {
    assert.strictEqual(check("/home/alice/work/file.txt", "/home/alice"), true);
  });

  it("rejects sibling directories that share a prefix", () => {
    // The headline bug: /home/alice-evil must NOT match safeDir /home/alice.
    assert.strictEqual(check("/home/alice-evil/secret", "/home/alice"), false);
  });

  it("rejects a path with the safe dir as a substring but not a parent", () => {
    assert.strictEqual(check("/var/home/alice/file", "/home/alice"), false);
  });

  it("rejects '..' escape attempts that normalize outside the safe dir", () => {
    assert.strictEqual(check("/home/alice/../bob/file", "/home/alice"), false);
  });

  it("collapses '..' inside the safe dir and still accepts the result", () => {
    assert.strictEqual(check("/home/alice/work/../code/file", "/home/alice"), true);
  });

  it("treats safeDir = / as a special case that accepts everything absolute", () => {
    assert.strictEqual(check("/etc/passwd", "/"), true);
    assert.strictEqual(check("/", "/"), true);
  });

  it("handles redundant slashes inside the path", () => {
    assert.strictEqual(check("/home//alice///work/file", "/home/alice"), true);
  });
});
