// Local plugin maintenance only. Never touches SSH servers or personal Web settings.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),cp=require('node:child_process'),crypto=require('node:crypto');
const registry='https://registry.npmjs.org';
function npmCli() {
  const candidates=[process.env.npm_execpath];
  for(const root of [path.dirname(process.execPath),...(process.env.PATH||'').split(path.delimiter)]) {
    candidates.push(path.join(root,'node_modules/npm/bin/npm-cli.js'),path.resolve(root,'../lib/node_modules/npm/bin/npm-cli.js'));
    try{candidates.push(fs.realpathSync(path.join(root,'npm')));}catch{}
  }
  const result=candidates.find(file=>file&&file.endsWith('npm-cli.js')&&fs.existsSync(file));
  if(!result)throw Error('npm CLI not found. Install Node.js with npm first.');return result;
}
function run(args,env=process.env) {
  const result=cp.spawnSync(process.execPath,args,{env,encoding:'utf8',windowsHide:true,timeout:240000,maxBuffer:2*1024*1024});
  if(result.status!==0)throw Error((result.stderr||result.error?.message||result.stdout||'Command failed').slice(-8000));
  return result.stdout||'';
}
async function download(url) {
  try {
    const response=await fetch(url,{cache:'no-store',headers:{'cache-control':'no-cache'},signal:AbortSignal.timeout(12000)});
    if(!response.ok)throw Error(`HTTP ${response.status}`);return Buffer.from(await response.arrayBuffer());
  }catch(error) {
    if(process.platform!=='win32')throw Error(`Unable to fetch ${url}: ${error.cause?.code||error.code||''} ${error.message}. Latest version was not verified.`);
    // Use Windows' system HTTP/proxy path when Node's registry connection fails.
    const file=path.join(os.tmpdir(),`rexp-fetch-${crypto.randomUUID()}`);
    const payload=Buffer.from(JSON.stringify({url,file})).toString('base64');
    const script=`$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';$d=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}'))|ConvertFrom-Json;Invoke-WebRequest -UseBasicParsing -TimeoutSec 12 -Uri $d.url -OutFile $d.file`;
    try {
      const result=cp.spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,timeout:15000,encoding:'utf8'});
      if(result.status!==0)throw Error(`Unable to fetch ${url} using Node or Windows HTTP. Latest version was not verified.\n${String(result.stderr||result.error?.message||'').slice(-1500)}`);
      return fs.readFileSync(file);
    }finally{fs.rmSync(file,{force:true});}
  }
}
function writableCache(cli) {
  let configured=process.env.npm_config_cache||process.env.NPM_CONFIG_CACHE;
  if(!configured){try{configured=run([cli,'config','get','cache']).trim();}catch{}}
  const fallback=path.join(os.homedir(),'.cache','handfree-ssh-mcp','npm');
  for(const candidate of [configured,fallback].filter(Boolean)) {
    try {fs.mkdirSync(candidate,{recursive:true});const probe=path.join(candidate,`.write-${crypto.randomUUID()}`);fs.writeFileSync(probe,'',{flag:'wx'});fs.unlinkSync(probe);if(candidate!==configured)console.log('Using writable per-user npm cache: '+candidate);return candidate;}catch{}
  }
  throw Error(`npm cache is not writable: ${configured||'(unset)'}, fallback: ${fallback}`);
}
function installedVersion(root) {try{return JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')).version;}catch{return null;}}
function verifyArchive(metadata,archive) {
  const [algorithm,expected]=(metadata.dist?.integrity||'').split('-');
  if(algorithm!=='sha512'||!expected||crypto.createHash('sha512').update(archive).digest('base64')!==expected)throw Error('Official rexp-web archive failed SHA-512 verification.');
}
async function installWeb({installDir,mode='update',cli=npmCli(),get=download,execute=run,cache}={}) {
  installDir=path.resolve(installDir);
  const root=path.join(installDir,'node_modules','rexp-web'),script=path.join(root,'scripts','web.mjs');
  const previous=installedVersion(root);
  if(mode==='install'&&previous)return {plugin_maintenance:1,action:'reused',version:previous};
  cache ||= writableCache(cli);
  console.log('Checking latest release without npm cache: '+registry+'/rexp-web/latest');
  let metadata,archive;
  try {
    metadata=JSON.parse((await get(registry+'/rexp-web/latest')).toString('utf8'));
    if(!/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(metadata.version||'')||metadata.name!=='rexp-web')throw Error('Official latest release metadata is invalid.');
    if(previous===metadata.version)return {plugin_maintenance:1,action:'already_current',version:previous};
    const source=new URL(metadata.dist?.tarball);
    if(source.origin!==registry)throw Error('REXP Web archive must come from the official npm registry.');
    archive=await get(source.href);verifyArchive(metadata,archive);
  }
  catch(error){throw Error(`${error.message}\nRegistry: ${registry}\nCache: ${cache}\nNo service was stopped; no update was claimed.`);}
  fs.mkdirSync(path.dirname(installDir),{recursive:true});
  const temporary=fs.mkdtempSync(path.join(path.dirname(installDir),'.rexp-web-update-'));
  const tarball=path.join(temporary,`rexp-web-${metadata.version}.tgz`),backup=path.join(temporary,'previous');
  fs.writeFileSync(tarball,archive);
  let stopped=false,backedUp=false,installing=false,restartAttempted=false,keepBackup=false,port='5173';
  try {
    if(previous) {
      const state=JSON.parse(execute([script,'status','--json']));
      if(state.url)port=new URL(state.url).port||'5173';
      if(state.running===true){console.log('Stopping Web for package maintenance; preferences are preserved.');execute([script,'stop']);stopped=true;}
    }
    if(fs.existsSync(installDir)){fs.cpSync(installDir,backup,{recursive:true});backedUp=true;}
    console.log(`Installing verified rexp-web@${metadata.version}; registry=${registry}; cache=${cache}`);
    installing=true;
    // The application archive is official and verified; dependencies retain the
    // user's npm registry configuration (including an explicitly chosen mirror).
    // Do not persist a file: dependency pointing at a temporary tarball that is
    // removed after maintenance; installed package.json remains the version source.
    const output=execute([cli,'install','--prefix',installDir,'--cache',cache,'--no-save','--package-lock=false','--omit=dev','--no-audit','--no-fund','--fetch-retries=1','--fetch-timeout=20000',tarball]);
    if(output.trim())console.log(output.trim());
    if(installedVersion(root)!==metadata.version)throw Error(`Expected ${metadata.version}; installed ${installedVersion(root)||'unknown'}. Update not verified.`);
    const version=JSON.parse(execute([script,'version','--json']));
    if(version.version!==metadata.version)throw Error('Installed CLI version did not match the official release.');
    if(stopped){restartAttempted=true;execute([script,'start'],{...process.env,REXP_WEB_PORT:port});console.log('Restarted the updated Web service.');}
  }catch(error) {
    const recovery=[];
    let restored=!installing;
    try {
      if(restartAttempted)execute([script,'stop']);
      if(installing){
        fs.rmSync(installDir,{recursive:true,force:true});
        if(backedUp)fs.cpSync(backup,installDir,{recursive:true});
        restored=true;recovery.push('Restored the previous package installation.');
      }
    }catch(rollback){keepBackup=true;recovery.push(`Could not restore the installation: ${rollback.message}. Backup retained at ${backup}`);}
    if(stopped&&restored) {
      try{execute([script,'start'],{...process.env,REXP_WEB_PORT:port});recovery.push('Restarted the previous Web service.');}
      catch(restart){recovery.push(`Previous service could not restart: ${restart.message}. Run Web start explicitly after checking its logs.`);}
    }
    throw Error(`${error.message}\n${recovery.join('\n')}\nRegistry: ${registry}\nCache: ${cache}`);
  }finally {
    if(!keepBackup)fs.rmSync(temporary,{recursive:true,force:true});
  }
  return {plugin_maintenance:1,action:previous?'updated':'installed',from_version:previous,version:metadata.version};
}
module.exports={installWeb,verifyArchive,installedVersion};
if(require.main===module)installWeb({installDir:process.argv[2],mode:process.argv[3]||'update'}).then(value=>console.log(JSON.stringify(value))).catch(error=>{console.error(error.message);process.exitCode=1;});
