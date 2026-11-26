import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { PluginCatalog, expand } from "./catalog.js";
import { executePluginSsh } from "./ssh-executor.js";
import { SSHConnectionManager } from "../services/ssh-connection-manager.js";
import { ToolError } from "../utils/tool-error.js";
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {getConfigPath} from '../config/config-loader.js';

const execFileAsync = promisify(execFile);
type Target = {plugin: string; component?: string; connectionName?: string};
type ExecuteLocal = (argv: string[], env: Record<string, string>, timeout: number) => Promise<string>;
const localExec: ExecuteLocal = async (argv, env, timeout) => {
  const result = await execFileAsync(argv[0], argv.slice(1), {
    env: {...process.env, ...env}, timeout, maxBuffer: 1024 * 1024, windowsHide: true,
  });
  return result.stdout;
};

/** One host, no experiment-specific tool mappings or background process ownership. */
export class PluginHost {
  private mutations = new Map<string, Promise<unknown>>();
  private discoveries = new Map<string, {expires:number; task:Promise<Record<string,string>>}>();
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
    const pluginSettings=JSON.stringify({...resolved.component.defaults,...resolved.registration.settings,...(connectionName?resolved.registration.connections[connectionName]||{}:{})});
    const variables: Record<string,string> = {
      discoveryScript:resolved.component.discover?.script||'',discoveryScriptBase64:Buffer.from(resolved.component.discover?.script||'').toString('base64'),
      pluginSettingsBase64:Buffer.from(pluginSettings).toString('base64'),
      nodeExecutable:process.execPath,pluginInstallDir:installDir,
      pluginRoot:path.join(installDir,'node_modules',resolved.component.source?.package || resolved.manifest.id),
      sshMcpDir:fileURLToPath(new URL('../../',import.meta.url)),
      sshMcpConfig:path.resolve(getConfigPath(process.argv.slice(2)) || process.env.HANDFREE_MCP_CONFIG || path.join(configHome,'handfree-ssh-mcp','servers.yaml')),
      pluginRegistry:this.catalog.file,
      pluginSettings,
      ...resolved.component.defaults, ...resolved.registration.settings,
      ...(connectionName ? resolved.registration.connections[connectionName] || {} : {})};
    return {...resolved, connectionName, variables};
  }

  private required(templates:string[]) {
    return [...new Set(templates.flatMap(value => [...value.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map(m => m[1])))];
  }

  private async preparedContext(target:Target,select:(c:ReturnType<PluginHost["context"]>)=>string[]) {
    const c=this.context(target);
    const templates=[...select(c).filter(value=>value!=='${skill}'),...Object.values(c.component.env)];
    if(!c.component.discover||!this.required(templates).some(key=>!c.variables[key]))return c;
    const shell=c.variables.commandShell||'posix';
    const command=shell==='powershell'?c.component.discover.powershell:c.component.discover.posix;
    if(!command)throw new ToolError('INVALID_CONFIGURATION',`Plugin discovery (unconfigured): No read-only discovery command for ${shell}; provide the existing installation settings, do not reinstall.`);
    const server=c.connectionName&&typeof this.ssh.getServerConfig==='function'?this.ssh.getServerConfig(c.connectionName):null;
    const key=JSON.stringify([c.manifest.id,c.component.id,c.connectionName,server?.host,server?.port,server?.username,c.variables,command]);
    for(const [name,item] of this.discoveries)if(item.expires<Date.now())this.discoveries.delete(name);
    let cached=this.discoveries.get(key);
    if(!cached) {
      const task=(async()=>{
        this.validateSettings(c,command);
        const argv=command.map(value=>expand(value,c.variables));
        let text:string;
        try {text=c.connectionName?await executePluginSsh(this.ssh,c.connectionName,argv,{},shell,20000):await this.executeLocal(argv,{},20000);}
        catch(error){throw new ToolError('INVALID_CONFIGURATION',`Plugin discovery (unconfigured): Could not inspect the existing installation. Do not install automatically. ${(error as Error).message}`);}
        let result:{state?:string;settings?:Record<string,string>;message?:string};
        try {
          result=JSON.parse(text);
          if(!result||Array.isArray(result)||typeof result!=='object'||!result.settings||typeof result.settings!=='object'||Array.isArray(result.settings)||Object.values(result.settings).some(value=>typeof value!=='string'||!value||value.includes('\0')))throw Error('Invalid settings');
        }catch {throw new ToolError('INVALID_CONFIGURATION','Plugin discovery (unconfigured): Invalid discovery result; no installation was attempted.');}
        if(result.state!=='ready')throw new ToolError('INVALID_CONFIGURATION',`Plugin discovery (${['unconfigured','not_initialized','not_installed'].includes(result.state||'')?result.state:'unconfigured'}): ${result.message||'Existing installation needs configuration; do not reinstall automatically.'}`);
        return result.settings!;
      })();
      cached={expires:Date.now()+30000,task};this.discoveries.set(key,cached);
      void task.catch(()=>{if(this.discoveries.get(key)===cached)this.discoveries.delete(key);});
    }
    const discovered=await cached.task;
    // Discovery fills gaps only. User-selected paths and host-provided values win.
    return {...c,variables:{...discovered,...c.variables}};
  }

  private validateSettings(c: ReturnType<PluginHost["context"]>, templates: string[], variables = c.variables) {
    const required = this.required(templates);
    const missing = required.filter(key => !variables[key]);
    if (missing.length) throw new ToolError("INVALID_CONFIGURATION",
      `Missing plugin settings: ${missing.join(", ")}. Registry: ${this.catalog.file}. ` +
      `Set plugins.${c.manifest.id}.${c.connectionName ? `connections.${c.connectionName}` : "settings"}. ` +
      `Required keys: ${required.join(", ")}. Read plugin-list setup and ask for user-specific directories before installing.`);
  }

  private async execute(target: Target, select: (c: ReturnType<PluginHost["context"]>) => string[],
    timeout = 30000, extra: Record<string, string> = {}, runtimeArgs: string[] = [], onProgress?: (chunk: string) => void) {
    const c = await this.preparedContext(target,select);
    const variables = {...c.variables, ...extra};
    const command = select(c);
    this.validateSettings(c, [...command, ...Object.values(c.component.env)], variables);
    const argv = [...command.map(value => expand(value, variables)), ...runtimeArgs];
    if (argv.some(value => value.includes("\0"))) throw new ToolError("INVALID_CONFIGURATION", "NUL is not allowed");
    const env = Object.fromEntries(Object.entries(c.component.env).map(([key, value]) => [key, expand(value, variables)]));
    let output: string;
    try {
      if (c.connectionName) {
        // Use the existing manager, including its command policy, timeout and output limits.
        // Mutations are never automatically retried after an ambiguous SSH disconnect.
        output = await executePluginSsh(this.ssh, c.connectionName, argv, env,
          variables.commandShell ?? "posix", timeout, onProgress);
      } else {
        output = await this.executeLocal(argv, env, timeout);
      }
    } catch (error) {
      if (error instanceof ToolError) throw error;
      throw new ToolError("COMMAND_EXECUTION_ERROR", (error as Error).message);
    }
    return {plugin: target.plugin, component: c.component.id, target: c.component.target,
      connectionName: c.connectionName ?? null, output};
  }

  async run(target: Target, args: string[], timeout?: number) {
    return this.execute(target, c => c.component.entry, timeout, {}, args);
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
    if(!c.component.discover)this.validateSettings(c, [...(command || []), ...c.component.version,
      ...(c.component.skills?.list || []), ...Object.values(c.component.env)]);
    const key = `${target.plugin}/${c.component.id}/${c.connectionName ?? "local"}`;
    if (this.mutations.has(key)) throw new ToolError("COMMAND_EXECUTION_ERROR", "Plugin maintenance is already in progress", true);
    const task = (async () => {
      let installerOutput:string|undefined;
      let maintenance:Record<string,unknown>|undefined;
      if(mode==='install'&&c.component.discover) {
        let existing;
        try {existing=await this.execute(target,ctx=>ctx.component.version);}
        catch(error) {
          // Only a confirmed absent executable/module permits installation. Configuration,
          // permission, network and broken-runtime failures never mean "not installed".
          if(!/Command exited with code (?:127|9009)\b|not recognized as (?:the name|an internal)|ENOENT/iu.test((error as Error).message))throw error;
        }
        if(existing) {
          const skills=c.component.skills?await this.skill(target):null;
          return {...existing,mode,action:'reused',skills};
        }
      }
      if (mode !== "check") {
        const configured=await this.preparedContext(target,ctx=>[...(ctx.component[mode]||[]),...ctx.component.version,...(ctx.component.skills?.list||[])]);
        this.validateSettings(configured,[...(configured.component[mode]||[]),...configured.component.version,...(configured.component.skills?.list||[]),...Object.values(configured.component.env)]);
        onProgress?.(`Starting ${mode} on ${c.connectionName ?? "local"}`);
        const started = Date.now();
        const timer = setInterval(() => onProgress?.(`Installer running: ${Math.round((Date.now() - started) / 1000)} seconds elapsed`), 10000);
        try {
          installerOutput=(await this.execute(target, () => command!, timeout, {}, [], onProgress)).output;
          for(const line of installerOutput.trim().split('\n').reverse()) {
            try {const value=JSON.parse(line);if(value?.plugin_maintenance===1&&['reused','already_current','updated','installed'].includes(value.action)){maintenance=value;break;}}catch{}
          }
        } catch (error) {
          if (error instanceof ToolError && error.code === "COMMAND_TIMEOUT")
            throw new ToolError("COMMAND_TIMEOUT", `Plugin ${mode} timed out after ${timeout}ms. Inspect the target environment before explicitly retrying; partial downloads/installations may remain. Increase timeout for slow networks or configure the component's dependency index.`, true);
          throw error;
        } finally { clearInterval(timer); }
        onProgress?.("Installer completed; checking version and skills");
      }
      const version = await this.execute(target, ctx => ctx.component.version);
      const skills = c.component.skills ? await this.skill(target) : null;
      return {...version, mode, action:maintenance?.action??(mode==='check'?'checked':mode==='install'?'installed':'updated'), ...(installerOutput?{installerOutput,maintenance}:{}), skills};
    })();
    this.mutations.set(key, task);
    try { return await task; } finally { this.mutations.delete(key); }
  }
}
