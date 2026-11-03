import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { PluginCatalog, expand, shellQuote } from "./catalog.js";
import { SSHConnectionManager } from "../services/ssh-connection-manager.js";
import { ToolError } from "../utils/tool-error.js";
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {getConfigPath} from '../config/config-loader.js';

const execFileAsync = promisify(execFile);
type Target = {plugin: string; component?: string; connectionName?: string};
type ExecuteLocal = (argv: string[], env: Record<string, string>, timeout: number, maxOutputBytes?: number) => Promise<string>;
function powershellQuote(value: string): string {
  return "'" + value.replace(/'/g, "''") + "'";
}

function sshCommand(argv: string[], env: Record<string, string>, shell: string): string {
  if (shell === "powershell") {
    const assignments = Object.entries(env).map(([key, value]) => `$env:${key} = ${powershellQuote(value)};`).join(" ");
    const invoke = `& ${argv.map(powershellQuote).join(" ")}`;
    const script = `$ErrorActionPreference = 'Stop'; try { ${assignments} ${invoke}; if ($LASTEXITCODE -is [int]) { exit $LASTEXITCODE } exit 0 } catch { [Console]::Error.WriteLine($_.ToString()); exit 1 }`;
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    return `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${encoded}`;
  }
  if (shell !== "posix") throw new ToolError("INVALID_CONFIGURATION", `Unknown plugin commandShell: ${shell}`);
  return [...(Object.keys(env).length ? ["env", ...Object.entries(env).map(([k,v]) => `${k}=${v}`)] : []), ...argv].map(shellQuote).join(" ");
}

const localExec: ExecuteLocal = async (argv, env, timeout, maxOutputBytes = 1024 * 1024) => {
  const result = await execFileAsync(argv[0], argv.slice(1), {
    env: {...process.env, ...env}, timeout, maxBuffer: maxOutputBytes, windowsHide: true,
  });
  return result.stdout;
};

/** One host, no experiment-specific tool mappings or background process ownership. */
export class PluginHost {
  private mutations = new Map<string, Promise<unknown>>();
  constructor(readonly catalog = new PluginCatalog(),
    private readonly ssh = SSHConnectionManager.getInstance(),
    private readonly executeLocal = localExec) {}

  private context(target: Target) {
    const resolved = this.catalog.resolve(target.plugin, target.component);
    const connectionName = resolved.component.target === "ssh" ? this.ssh.resolveServer(target.connectionName) : undefined;
    if (resolved.component.target === "local" && target.connectionName)
      throw new ToolError("INVALID_CONFIGURATION", "A local component does not accept connectionName");
    const configHome=process.env.XDG_CONFIG_HOME || path.join(os.homedir(),'.config');
    const installDir=path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(),'.local','share'),
      'handfree-ssh-mcp','plugins',resolved.manifest.id);
    const variables: Record<string,string> = {
      nodeExecutable:process.execPath,pluginInstallDir:installDir,
      pluginRoot:path.join(installDir,'node_modules',resolved.component.source?.package || resolved.manifest.id),
      sshMcpDir:fileURLToPath(new URL('../../',import.meta.url)),
      sshMcpConfig:path.resolve(getConfigPath(process.argv.slice(2)) || process.env.HANDFREE_MCP_CONFIG || path.join(configHome,'handfree-ssh-mcp','servers.yaml')),
      pluginRegistry:this.catalog.file,
      ...resolved.component.defaults, ...resolved.registration.settings,
      ...(connectionName ? resolved.registration.connections[connectionName] || {} : {})};
    return {...resolved, connectionName, variables};
  }

  private validateSettings(c: ReturnType<PluginHost["context"]>, templates: string[], variables = c.variables) {
    const required = [...new Set(templates.flatMap(value => [...value.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map(m => m[1])))];
    const missing = required.filter(key => !variables[key]);
    if (missing.length) throw new ToolError("INVALID_CONFIGURATION",
      `Missing plugin settings: ${missing.join(", ")}. Registry: ${this.catalog.file}. ` +
      `Set plugins.${c.manifest.id}.${c.connectionName ? `connections.${c.connectionName}` : "settings"}. ` +
      `Required keys: ${required.join(", ")}. Read plugin-list setup and ask for user-specific directories before installing.`);
  }

  private async execute(target: Target, select: (c: ReturnType<PluginHost["context"]>) => string[],
    timeout = 30000, extra: Record<string, string> = {}, runtimeArgs: string[] = [], onProgress?: (chunk: string) => void, maxOutputBytes = 1024 * 1024) {
    const c = this.context(target);
    const variables = {...c.variables, ...extra};
    const command = select(c);
    this.validateSettings(c, [...command, ...Object.values(c.component.env)], variables);
    const argv = [...command.map(value => expand(value, variables)), ...runtimeArgs];
    if (argv.some(value => value.includes("\0"))) throw new ToolError("INVALID_CONFIGURATION", "NUL is not allowed");
    const env = Object.fromEntries(Object.entries(c.component.env).map(([key, value]) => [key, expand(value, variables)]));
    let output: string;
    try {
      if (c.connectionName) {
        const command = sshCommand(argv, env, variables.commandShell ?? "posix");
        // Use the existing manager, including its command policy, timeout and output limits.
        // Mutations are never automatically retried after an ambiguous SSH disconnect.
        output = await this.ssh.executeCommand(command, c.connectionName, {timeout, maxRetries: 0,
          maxOutputBytes, onProgress, requireSuccess: true});
      } else {
        output = await this.executeLocal(argv, env, timeout, maxOutputBytes);
      }
    } catch (error) {
      if (error instanceof ToolError) throw error;
      throw new ToolError("COMMAND_EXECUTION_ERROR", (error as Error).message);
    }
    return {plugin: target.plugin, component: c.component.id, target: c.component.target,
      connectionName: c.connectionName ?? null, output};
  }

  async run(target: Target, args: string[], timeout?: number, maxOutputBytes = 1024 * 1024) {
    if (!Number.isInteger(maxOutputBytes) || maxOutputBytes < 1024 || maxOutputBytes > 32 * 1024 * 1024)
      throw new ToolError("INVALID_CONFIGURATION", "maxOutputBytes must be an integer between 1024 and 33554432");
    return this.execute(target, c => c.component.entry, timeout, {}, args, undefined, maxOutputBytes);
  }

  async skill(target: Target, name?: string) {
    return this.execute(target, c => {
      if (!c.component.skills) throw new ToolError("INVALID_CONFIGURATION", "This component does not publish skills");
      return name ? c.component.skills.show : c.component.skills.list;
    }, 30000, name ? {skill: name} : {});
  }

  async activate(target: Target, mode: "check" | "install" | "update" = "check", timeout = 300000, onProgress?: (message: string) => void) {
    const c = this.context(target);
    const command = mode === "check" ? undefined : c.component[mode];
    if (mode !== "check" && !command)
      throw new ToolError("INVALID_CONFIGURATION", `No ${mode} command configured for this component`);
    this.validateSettings(c, [...(command || []), ...c.component.version,
      ...(c.component.skills?.list || []), ...Object.values(c.component.env)]);
    const key = `${target.plugin}/${c.component.id}/${c.connectionName ?? "local"}`;
    if (this.mutations.has(key)) throw new ToolError("COMMAND_EXECUTION_ERROR", "Plugin maintenance is already in progress", true);
    const task = (async () => {
      if (mode !== "check") {
        onProgress?.(`Starting ${mode} on ${c.connectionName ?? "local"}`);
        const started = Date.now();
        const timer = setInterval(() => onProgress?.(`Installer running: ${Math.round((Date.now() - started) / 1000)} seconds elapsed`), 10000);
        try {
          await this.execute(target, () => command!, timeout, {}, [], onProgress);
        } catch (error) {
          if (error instanceof ToolError && error.code === "COMMAND_TIMEOUT")
            throw new ToolError("COMMAND_TIMEOUT", `Plugin ${mode} timed out after ${timeout}ms. Inspect the target environment before explicitly retrying; partial downloads/installations may remain. Increase timeout for slow networks or configure the component's dependency index.`, true);
          throw error;
        } finally { clearInterval(timer); }
        onProgress?.("Installer completed; checking version and skills");
      }
      const version = await this.execute(target, ctx => ctx.component.version);
      const skills = c.component.skills ? await this.skill(target) : null;
      return {...version, mode, skills};
    })();
    this.mutations.set(key, task);
    try { return await task; } finally { this.mutations.delete(key); }
  }
}
