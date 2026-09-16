import assert from "node:assert/strict";
import { describe, test, afterEach } from "node:test";
import { RunProfileRegistry } from "../run/run-profile-registry.js";

// PLAN.MD P2-02: "记录不可变 config revision...后续 launch/status/retry 不混读
// 热更新配置". getRevision() is the content-hash source of truth run-service
// stamps onto every new run's meta.json -- these are plain in-process value
// tests (no SSH needed) over the registry itself.

describe("P2-02 white/grey-box: RunProfileRegistry.getRevision()", () => {
  const registry = RunProfileRegistry.getInstance();

  afterEach(() => {
    registry.setProfiles({});
  });

  test("same content -> same revision, regardless of key insertion order", () => {
    registry.setProfiles({
      a: { server: "s", remoteRoot: "/r", environment: { type: "executable" } } as any,
      b: { server: "s2", remoteRoot: "/r2", environment: { type: "executable" } } as any,
    });
    const rev1 = registry.getRevision();

    registry.setProfiles({
      b: { server: "s2", remoteRoot: "/r2", environment: { type: "executable" } } as any,
      a: { server: "s", remoteRoot: "/r", environment: { type: "executable" } } as any,
    });
    const rev2 = registry.getRevision();

    assert.equal(rev1, rev2);
  });

  test("different content -> different revision", () => {
    registry.setProfiles({ a: { server: "s", remoteRoot: "/r", environment: { type: "executable" } } as any });
    const rev1 = registry.getRevision();

    registry.setProfiles({ a: { server: "s", remoteRoot: "/r-changed", environment: { type: "executable" } } as any });
    const rev2 = registry.getRevision();

    assert.notEqual(rev1, rev2);
  });

  test("setProfiles({}) after non-empty content changes the revision back", () => {
    registry.setProfiles({ a: { server: "s", remoteRoot: "/r", environment: { type: "executable" } } as any });
    const withProfile = registry.getRevision();
    registry.setProfiles({});
    const empty = registry.getRevision();
    assert.notEqual(withProfile, empty);
  });

  test("revision is a 64-char lowercase hex sha256 digest", () => {
    registry.setProfiles({ a: { server: "s", remoteRoot: "/r", environment: { type: "executable" } } as any });
    assert.match(registry.getRevision(), /^[0-9a-f]{64}$/);
  });
});
