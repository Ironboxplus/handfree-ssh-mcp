import type { RunProfileEntry, RunProfilesConfig } from "../config/run-profiles-loader.js";

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

  public static getInstance(): RunProfileRegistry {
    if (!RunProfileRegistry.instance) {
      RunProfileRegistry.instance = new RunProfileRegistry();
    }
    return RunProfileRegistry.instance;
  }

  public setProfiles(profiles: RunProfilesConfig): void {
    this.profiles = profiles;
  }

  public get(name: string): RunProfileEntry | undefined {
    return this.profiles[name];
  }

  public list(): string[] {
    return Object.keys(this.profiles);
  }
}
