import {test} from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {execFileSync} from "node:child_process";
import {PluginCatalog, defaultCatalogPath, expand, manifestSchema, shellQuote} from "../plugins/catalog.js";
import {PluginHost} from "../plugins/host.js";
import {SSHConnectionManager} from "../services/ssh-connection-manager.js";
import {ToolError} from "../utils/tool-error.js";
import yaml from "js-yaml";

test("REXP manifest uses the rexp entry point on Linux and Windows without changing per-node roots", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "handfree-rexp-command-"));
  const calls: any[] = [];
  const manifest = fs.readFileSync(path.resolve("examples/plugins/rexp.yaml"), "utf8");
  try {
    const parsed = manifestSchema.parse(yaml.load(manifest));
    const worker = parsed.components[0];
    assert.equal(worker.source?.package, "rexprun");
    assert.equal(worker.source?.location, "https://pypi.org/simple/");
    for (const command of [worker.install, worker.update]) {
      assert.ok(command?.some(arg => arg.includes("https://pypi.org/pypi/rexprun/json")));
      assert.ok(command?.some(arg => arg.includes("sha256")));
      assert.ok(!command?.some(arg => arg.includes("test.pypi.org")));
    }
    assert.match(worker.setup ?? "", /--install-manager/);
    assert.match(worker.setup ?? "", /env\/default/);
    assert.match(worker.setup ?? "", /安装 uv（推荐）/);
    assert.match(worker.setup ?? "", /安装 Conda/);
    assert.match(worker.setup ?? "", /Python venv、不安装管理器/);
    assert.match(worker.setup ?? "", /UV_OFFLINE=true/);
    for (const command of [worker.install, worker.update]) {
      assert.ok(command?.some(arg => arg.includes("PIP_DEFAULT_TIMEOUT") && arg.includes("PIP_RETRIES")));
    }
    assert.deepEqual(worker.entry, ["${rexpPath}"]);
    assert.ok(!manifest.includes("labPath"));
    fs.writeFileSync(path.join(dir, "rexp.yaml"), manifest);
    const registry = {schemaVersion:1,plugins:{rexp:{manifest:"rexp.yaml",connections:{
      linux:{rexpPath:"/opt/conda/bin/rexp",platformRoot:"/data/experiments",platformPython:"/opt/conda/bin/python"},
      windows:{rexpPath:"D:\\conda\\envs\\platform\\Scripts\\rexp.exe",platformRoot:"D:\\Experiments",platformPython:"D:\\conda\\envs\\platform\\python.exe",commandShell:"powershell"},
    }}}};
    const file = path.join(dir,"plugins.json");
    fs.writeFileSync(file,JSON.stringify(registry));
    const ssh = {resolveServer:(name?:string)=>name,executeCommand:async (...args:any[])=>{calls.push(args);return "ok";}} as unknown as SSHConnectionManager;
    const host = new PluginHost(new PluginCatalog(file),ssh);
    await host.run({plugin:"rexp",connectionName:"linux"},["status","--json"]);
    await host.skill({plugin:"rexp",connectionName:"linux"},"platform-operations");
    assert.match(calls[0][0], /'PLATFORM_ROOT=\/data\/experiments' '\/opt\/conda\/bin\/rexp' 'status' '--json'$/);
    assert.match(calls[1][0], /'rexp'|'\/opt\/conda\/bin\/rexp'/);
    assert.ok(calls[1][0].endsWith("'skills' 'show' 'platform-operations' '--json'"));
    await host.run({plugin:"rexp",connectionName:"windows"},["runs","--json"]);
    const script = Buffer.from(calls[2][0].split(" ").at(-1),"base64").toString("utf16le");
    assert.ok(script.includes("& 'D:\\conda\\envs\\platform\\Scripts\\rexp.exe' 'runs' '--json'"));
    assert.ok(script.includes("$env:PLATFORM_ROOT = 'D:\\Experiments'"));
    assert.deepEqual(calls.map(call=>call[1]),["linux","linux","windows"]);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

function fixture(target = "local") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "handfree-plugin-"));
  const manifest = {schemaVersion: 1, id: "demo", description: "test plugin", components: [{
    id: "worker", target, description: "worker", entry: [process.execPath, "${script}"],
    version: [process.execPath, "${script}", "version"],
    install: [process.execPath, "${script}", "install"],
    update: [process.execPath, "${script}", "update"],
    env: {PLATFORM_ROOT: "${platformRoot}"},
    skills: {list: [process.execPath, "${script}", "skills"], show: [process.execPath, "${script}", "skill", "${skill}"]},
  }]};
  fs.writeFileSync(path.join(dir,"manifest.json"), JSON.stringify(manifest));
  fs.writeFileSync(path.join(dir,"worker.cjs"), `const fs = require('fs');
    const state = __filename + '.version';
    if (['install','update'].includes(process.argv[2])) fs.writeFileSync(state, process.argv[2]);
    console.log(JSON.stringify({args: process.argv.slice(2), root: process.env.PLATFORM_ROOT,
      version: fs.existsSync(state) ? fs.readFileSync(state,'utf8') : 'original'}));`);
  const registry = {schemaVersion: 1, plugins: {demo: {manifest: "manifest.json", settings: {
    platformRoot: path.join(dir,"data"), script: path.join(dir,"worker.cjs")},
    connections: {alpha: {platformRoot: "/alpha"}, beta: {platformRoot: "/beta"}}}}};
  const file = path.join(dir,"plugins.json");
  fs.writeFileSync(file,JSON.stringify(registry));
  return {dir, file, manifest, registry, catalog: new PluginCatalog(file,false), clean: () => fs.rmSync(dir,{recursive:true, force:true})};
}

test('bundled plugins are discoverable before registration and explicit disabling is respected',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'handfree-bundled-'));
  try{
    const file=path.join(dir,'plugins.yaml');
    const catalog=new PluginCatalog(file);
    assert.deepEqual(catalog.read().map(p=>p.manifest.id).sort(),['rexp','rexp-web']);
    const web=catalog.resolve('rexp-web');
    assert.equal(web.component.source?.package,'rexp-web');
    assert.ok(web.component.skills);assert.deepEqual(web.component.install,web.component.update);
    fs.writeFileSync(file,JSON.stringify({schemaVersion:1,plugins:{'rexp-web':{enabled:false,manifest:'unused.yaml'}}}));
    assert.deepEqual(catalog.read().map(p=>p.manifest.id),['rexp']);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('local npm plugins receive the host runtime and private config paths without extra setup',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'handfree-web-host-'));
  try{
    const file=path.join(dir,'plugins.yaml');const calls:any[]=[];
    const host=new PluginHost(new PluginCatalog(file),undefined,async(argv,env)=>{calls.push({argv,env});return 'ready';});
    await host.run({plugin:'rexp-web'},['status','--json']);
    assert.equal(calls[0].argv[0],process.execPath);
    assert.ok(calls[0].argv[1].endsWith(path.join('node_modules','rexp-web')+'/scripts/web.mjs'));
    assert.equal(calls[0].env.HANDFREE_PLUGINS_CONFIG,file);
    assert.ok(path.isAbsolute(calls[0].env.HANDFREE_MCP_DIR));
    assert.ok(!fs.existsSync(file),'discovery does not create a user registry or startup service');
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test("optional user registry, missing argument, strict manifest and required settings", () => {
  const f=fixture();
  try {
    assert.deepEqual(new PluginCatalog(path.join(f.dir,"absent"),false).read(), []);
    assert.throws(() => defaultCatalogPath(["--plugins"]), /requires/);
    assert.throws(() => expand("${absent}", {}), /Missing plugin setting/);
    assert.equal(expand("${root}", {root:"/a/${literal}"}), "/a/${literal}");
    assert.throws(() => manifestSchema.parse({...f.manifest, components:[...f.manifest.components,...f.manifest.components]}), /Duplicate/);
    assert.throws(() => manifestSchema.parse({...f.manifest, unexpected: true}));
    assert.throws(() => f.catalog.resolve("missing"), /Unknown/);
    f.manifest.components[0] = {...f.manifest.components[0], setup:"Ask for the data directory before initialization."} as any;
    fs.writeFileSync(path.join(f.dir,"manifest.json"),JSON.stringify(f.manifest));
    assert.match(f.catalog.read()[0].manifest.components[0].setup!, /Ask for the data directory/);
    f.registry.plugins.demo = {...f.registry.plugins.demo, enabled:false} as any;
    fs.writeFileSync(f.file,JSON.stringify(f.registry));
    assert.deepEqual(f.catalog.read(),[]);
  } finally {f.clean();}
});

test("local execution passes literal argv and environment, rereads the installed skill after update", async () => {
  const f=fixture();
  try {
    const host=new PluginHost(f.catalog);
    const literal="中文 ' ; $(touch SHOULD_NOT_EXIST) ${literal}";
    const run=await host.run({plugin:"demo"},[literal]);
    assert.deepEqual(JSON.parse(run.output).args,[literal]);
    assert.equal(JSON.parse(run.output).root,path.join(f.dir,"data"));
    assert.equal(JSON.parse((await host.activate({plugin:"demo"})).output).version,"original");
    const updated=await host.activate({plugin:"demo"},"update");
    assert.equal(JSON.parse(updated.output).version,"update");
    assert.equal(JSON.parse(updated.skills!.output).version,"update");
    assert.deepEqual(JSON.parse((await host.skill({plugin:"demo"}, literal)).output).args,["skill",literal]);
    await assert.rejects(host.run({plugin:"demo",connectionName:"alpha"},[]), /does not accept/);
  } finally {f.clean();}
});

test("SSH targets follow manager aliases, quote every argument and keep per-host roots", async () => {
  const f=fixture("ssh");
  const calls: any[]=[];
  const ssh={resolveServer: (name?:string) => {if (!name) throw new Error("Select connection"); return name;},
    executeCommand: async (...args:any[]) => {calls.push(args); return "ok";}} as unknown as SSHConnectionManager;
  try {
    const host=new PluginHost(f.catalog,ssh);
    await assert.rejects(host.run({plugin:"demo"},[]), /Select connection/);
    await host.run({plugin:"demo",connectionName:"alpha"},["a' ; $(no)"]);
    await host.run({plugin:"demo",connectionName:"beta"},["status"]);
    assert.equal(calls[0][1],"alpha"); assert.equal(calls[1][1],"beta");
    assert.match(calls[0][0], /PLATFORM_ROOT=\/alpha/); assert.match(calls[1][0], /PLATFORM_ROOT=\/beta/);
    assert.equal(calls[0][2].maxRetries,0);
    assert.ok(calls[0][0].endsWith(shellQuote("a' ; $(no)")));
    await host.activate({plugin:"demo",connectionName:"alpha"},"install",900000);
    assert.equal(calls[2][2].timeout,900000);
    const value="中文 '; $(printf broken)\nsecond";
    assert.equal(execFileSync("/bin/sh",["-c",`printf %s ${shellQuote(value)}`],{encoding:"utf8"}),value);
  } finally {f.clean();}
});

test("PowerShell SSH targets encode arguments and per-host environment for Windows", async () => {
  const f=fixture("ssh");
  const calls: any[]=[];
  f.registry.plugins.demo.connections.alpha={platformRoot:"D:\\research's", commandShell:"powershell"} as any;
  fs.writeFileSync(f.file,JSON.stringify(f.registry));
  const ssh={resolveServer:(name?:string)=>name,
    executeCommand:async (...args:any[])=>{calls.push(args); return "ok";}} as unknown as SSHConnectionManager;
  try {
    const host=new PluginHost(f.catalog,ssh);
    await host.run({plugin:"demo",connectionName:"alpha"},["中文 '; $(no)"]);
    const command=calls[0][0] as string;
    assert.match(command,/^powershell\.exe -NoProfile -NonInteractive -EncodedCommand [A-Za-z0-9+/=]+$/);
    const script=Buffer.from(command.split(" ").at(-1)!,"base64").toString("utf16le");
    assert.match(script,/\$env:PLATFORM_ROOT = 'D:\\research''s'/);
    assert.match(script,/'中文 ''; \$\(no\)'/);
    assert.match(script,/exit \$LASTEXITCODE/);
    assert.equal(calls[0][1],"alpha");
  } finally {f.clean();}
});

test("SSH plugins use actual exit/truncation metadata, never markers inside successful logs", async () => {
  const f=fixture("ssh");
  let stdout = "Previous failure: [EXIT CODE: 2]\nExample: [OUTPUT TRUNCATED]\nCurrent state: ready";
  let stderr = "";
  let exitCode: number | null = 0;
  let attempts = 0;
  // Exercise the real buffered executor and formatting, with only the SSH transport stubbed.
  const ssh = Object.assign(Object.create(SSHConnectionManager.prototype), {
    resolveServer: () => "alpha",
    validateCommand: () => ({isAllowed:true}),
    acquireSshClient: async () => { attempts++; return {client:{},close:()=>{}}; },
    getConfig: () => ({}),
    resolveChannelOpenTimeout: () => 1000,
    createLogWriter: () => null,
    isConnectionError: () => false,
    runCommandStream: async (_cmd: string, _client: unknown, _timeout: number, sinks: any) => {
      sinks.stdoutCollector.push(stdout);
      sinks.stderrCollector.push(stderr);
      return exitCode;
    },
  }) as SSHConnectionManager;
  try {
    const host=new PluginHost(f.catalog,ssh);
    assert.equal((await host.run({plugin:"demo"},["logs"])).output, stdout);
    assert.equal((await host.activate({plugin:"demo"})).output, stdout);
    exitCode = 2;
    stdout = "real failure without a marker";
    const before = attempts;
    await assert.rejects(host.activate({plugin:"demo"}), /Command exited with code 2/);
    assert.equal(attempts, before + 1, "failed commands must not be retried");
    exitCode = null;
    await assert.rejects(host.run({plugin:"demo"},[]), /without a confirmed exit code/);
    exitCode = 0;
    stdout = "x".repeat(1024 * 1024 + 1);
    await assert.rejects(host.skill({plugin:"demo"}), /output was truncated/);
    stdout = "ok";
    stderr = "x".repeat(1024 * 1024 + 1);
    await assert.rejects(host.run({plugin:"demo"},[]), /output was truncated/);
    stderr = "";
    exitCode = 2;
    assert.match(await ssh.executeCommand("example", "alpha"), /\[EXIT CODE: 2\]/,
      "ordinary SSH callers retain the existing text response");
    (ssh as any).validateCommand=()=>({isAllowed:false,reason:"blocked by SSH policy"});
    await assert.rejects(host.run({plugin:"demo"},[]),(err:any)=>err.code==="COMMAND_VALIDATION_FAILED");
  } finally {f.clean();}
});

test("run, skills and version checks do not require settings for unrelated installers", async () => {
  const f = fixture();
  try {
    f.manifest.components[0].install = ['${installPython}', '${script}', 'install'];
    f.manifest.components[0].update = ['${updatePython}', '${script}', 'update'];
    fs.writeFileSync(path.join(f.dir, 'manifest.json'), JSON.stringify(f.manifest));
    const host = new PluginHost(f.catalog);
    assert.deepEqual(JSON.parse((await host.run({plugin:'demo'},['status'])).output).args, ['status']);
    assert.deepEqual(JSON.parse((await host.skill({plugin:'demo'},'ops')).output).args, ['skill','ops']);
    assert.equal((await host.activate({plugin:'demo'})).mode, 'check');
    await assert.rejects(host.activate({plugin:'demo'},'install'), /Missing plugin settings: installPython\./);
    assert.ok(!fs.existsSync(path.join(f.dir,'worker.cjs.version')));
    f.registry.plugins.demo.settings = {...f.registry.plugins.demo.settings,installPython:process.execPath} as any;
    fs.writeFileSync(f.file, JSON.stringify(f.registry));
    assert.equal((await host.activate({plugin:'demo'},'install')).mode, 'install');
    await assert.rejects(host.activate({plugin:'demo'},'update'), /Missing plugin settings: updatePython\./);
  } finally { f.clean(); }
});

test("activation validates its post-install version and skill configuration before changing anything", async () => {
  const f = fixture();
  try {
    f.manifest.components[0].skills.list = ['${skillReader}'];
    fs.writeFileSync(path.join(f.dir, 'manifest.json'), JSON.stringify(f.manifest));
    const host = new PluginHost(f.catalog);
    assert.ok((await host.run({plugin:'demo'},['status'])).output);
    await assert.rejects(host.activate({plugin:'demo'},'install'), /Missing plugin settings: skillReader\./);
    assert.ok(!fs.existsSync(path.join(f.dir,'worker.cjs.version')));
  } finally { f.clean(); }
});

test("a failed build preserves the previously usable entry point", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'handfree-build-'));
  try {
    for (const name of ['scripts','src','build']) fs.mkdirSync(path.join(dir,name));
    const script = path.join(dir,'scripts/build.mjs');
    fs.copyFileSync(path.resolve('scripts/build.js'),script);
    const entry = path.join(dir,'build/index.js');
    fs.writeFileSync(entry,'// working build');
    fs.writeFileSync(path.join(dir,'src/index.ts'),'const broken: = ;');
    fs.writeFileSync(path.join(dir,'tsconfig.json'),JSON.stringify({
      compilerOptions:{outDir:'build'},include:['src/**/*'],
    }));
    assert.throws(() => execFileSync(process.execPath,[script],{
      env:{...process.env,PATH:path.resolve('node_modules/.bin')+path.delimiter+process.env.PATH},
      stdio:'pipe',timeout:15000,
    }), (error: any) => error.status !== 0 && String(error.stdout).includes('error TS'));
    assert.equal(fs.readFileSync(entry,'utf8'),'// working build');
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});

test("ambiguous component, maintenance concurrency, installer failure and local timeout", async () => {
  const f=fixture();
  try {
    f.manifest.components.push({...f.manifest.components[0], id:"web"});
    fs.writeFileSync(path.join(f.dir,"manifest.json"),JSON.stringify(f.manifest));
    assert.throws(()=>f.catalog.resolve("demo"), /Select a component/);
    let finish!: (v:string)=>void;
    const pending=new Promise<string>(r=>{finish=r;});
    const host=new PluginHost(f.catalog,undefined,async()=>pending);
    const first=host.activate({plugin:"demo",component:"worker"},"install");
    await assert.rejects(host.activate({plugin:"demo",component:"worker"},"update"), /already in progress/);
    finish("ok"); await first;
    const failed=new PluginHost(f.catalog,undefined,async()=>{throw new Error("installer failed");});
    await assert.rejects(failed.activate({plugin:"demo",component:"worker"},"install"), /installer failed/);
    const actual=new PluginHost(f.catalog);
    // Use an independent fixture command, without leaving a long-running child.
    f.manifest.components[0].entry=[process.execPath,"-e","setTimeout(()=>{}, 10000)"];
    fs.writeFileSync(path.join(f.dir,"manifest.json"),JSON.stringify(f.manifest));
    await assert.rejects(actual.run({plugin:"demo",component:"worker"},[],50), /Command failed/);
  } finally {f.clean();}
});

test("MCP tools expose discovery, activation, skill and run with structured failures", async () => {
  const {McpServer} = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const {Client} = await import("@modelcontextprotocol/sdk/client/index.js");
  const {InMemoryTransport} = await import("@modelcontextprotocol/sdk/inMemory.js");
  const {registerPluginTools} = await import("../tools/plugins.js");
  const f=fixture();
  const previous=process.env.HANDFREE_PLUGINS_CONFIG;
  const server=new McpServer({name:"plugin-test",version:"1"});
  const client=new Client({name:"plugin-client",version:"1"});
  try {
    process.env.HANDFREE_PLUGINS_CONFIG=f.file;
    registerPluginTools(server);
    const [ct,st]=InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st),client.connect(ct)]);
    const names=(await client.listTools()).tools.map(tool=>tool.name);
    assert.deepEqual(names.sort(),["plugin-activate","plugin-list","plugin-run","plugin-skill"]);
    const discovery=await client.callTool({name:"plugin-list",arguments:{}});
    assert.equal(JSON.parse((discovery.content as any)[0].text)[0].id,"demo");
    const active=await client.callTool({name:"plugin-activate",arguments:{plugin:"demo"}});
    assert.equal(active.isError,undefined);
    const skills=await client.callTool({name:"plugin-skill",arguments:{plugin:"demo",name:"ops"}});
    assert.deepEqual(JSON.parse(JSON.parse((skills.content as any)[0].text).output).args,["skill","ops"]);
    const run=await client.callTool({name:"plugin-run",arguments:{plugin:"demo",args:["runs","--json"]}});
    assert.deepEqual(JSON.parse(JSON.parse((run.content as any)[0].text).output).args,["runs","--json"]);
    const missing=await client.callTool({name:"plugin-run",arguments:{plugin:"missing",args:[]}});
    assert.equal(missing.isError,true);
    assert.equal(JSON.parse((missing.content as any)[0].text).code,"INVALID_CONFIGURATION");
  } finally {
    await client.close(); await server.close();
    if(previous===undefined)delete process.env.HANDFREE_PLUGINS_CONFIG;else process.env.HANDFREE_PLUGINS_CONFIG=previous;
    f.clean();
  }
});

test("missing configuration lists actionable registry location and all required keys", async () => {
  const f = fixture('ssh');
  try {
    f.manifest.components[0].entry = ['${missingEntry}', '${missingRoot}'];
    fs.writeFileSync(path.join(f.dir, 'manifest.json'), JSON.stringify(f.manifest));
    const ssh = {resolveServer: () => 'alpha'} as unknown as SSHConnectionManager;
    const host = new PluginHost(f.catalog, ssh);
    await assert.rejects(host.run({plugin:'demo',connectionName:'alpha'},[]), (error:Error) =>
      error.message.includes(f.file) && error.message.includes('missingEntry') && error.message.includes('missingRoot') && error.message.includes('connections.alpha'));
  } finally { f.clean(); }
});

test("installer progress and timeout guidance do not automatically retry mutations", async () => {
  const f = fixture('ssh');
  let calls=0;
  const ssh = {resolveServer:()=> 'alpha', executeCommand:async (_cmd:string,_alias:string,opts:any)=> {
    calls++; opts.onProgress?.('Downloaded 100 bytes');
    throw new ToolError('COMMAND_TIMEOUT','slow network');
  }} as unknown as SSHConnectionManager;
  const progress:string[]=[];
  try {
    await assert.rejects(new PluginHost(f.catalog,ssh).activate({plugin:'demo',connectionName:'alpha'},'install',1000,message=>progress.push(message)),
      (error:any)=>error.code==='COMMAND_TIMEOUT' && error.retriable===true && /Inspect the target/.test(error.message));
    assert.equal(calls,1);
    assert.ok(progress.includes('Downloaded 100 bytes'));
  } finally {f.clean();}
});
