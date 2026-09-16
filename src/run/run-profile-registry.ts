import type { RunProfileEntry, RunProfilesConfig } from "../config/run-profiles-loader.js";
import { canonicalJsonStringify, sha256Hex } from "../contracts/primitives.js";

/**
 * PLAN.MD P2-01: "解析 runProfiles，引用不存在的 server profile 时启动即失败".
 *
 * Deliberately NOT a job framework or a daemon -- just the same "singleton
 * holds the currently-loaded config map" shape SSHConnectionManager already
 * uses for `servers`, so hot-reload (src/core/mcp-server.ts) can replace the
 * whole map atomically the same way it already does for SSH server configs.
 */
export class RunProfileRegistry {
  private static instance: RunProfileRegistry;
  private profiles: RunProfilesConfig = {};
  // PLAN.MD P2-02: "记录不可变 config revision...后续 launch/status/retry 不混读
  // 热更新配置". A content hash over the whole map, recomputed only when
  // setProfiles() replaces it (hot reload), so a run's stored configRevision
  // can be compared against "the config that is live right now" without
  // needing any of the sqlite/daemon machinery Rev.4 cancelled -- it is just
  // a string captured once at launch time and never read back from here
  // again for that run.
  private revision = RunProfileRegistry.computeRevision({});

  public static getInstance(): RunProfileRegistry {
    if (!RunProfileRegistry.instance) {
      RunProfileRegistry.instance = new RunProfileRegistry();
    }
    return RunProfileRegistry.instance;
  }

  private static computeRevision(profiles: RunProfilesConfig): string {
    // canonicalJsonStringify (§4.2/primitives.ts) sorts object keys
    // recursively, so this is deterministic regardless of insertion order at
    // any nesting depth, not just the top-level profile name.
    return sha256Hex(canonicalJsonStringify(profiles));
  }

  public setProfiles(profiles: RunProfilesConfig): void {
    this.profiles = profiles;
    this.revision = RunProfileRegistry.computeRevision(profiles);
  }

  public get(name: string): RunProfileEntry | undefined {
    return this.profiles[name];
  }

  public list(): string[] {
    return Object.keys(this.profiles);
  }

  /** The current runProfiles config's content revision (see field doc above). */
  public getRevision(): string {
    return this.revision;
  }
}
