import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
const {installWeb}=createRequire(import.meta.url)('../../examples/plugins/rexp-web-install.cjs');

function fixture(t:TestContext,{previous='0.1.5',running=true}={}) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'rexp-web-update-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const installDir=path.join(dir,'prefix'),root=path.join(installDir,'node_modules','rexp-web');
  const write=(version:string)=>{fs.mkdirSync(root,{recursive:true});fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({name:'rexp-web',version}));};
  if(previous)write(previous);
  const archive=Buffer.from('verified release archive');
  const metadata={name:'rexp-web',version:'0.1.6',dist:{tarball:'https://registry.npmjs.org/rexp-web/-/rexp-web-0.1.6.tgz',integrity:'sha512-'+createHash('sha512').update(archive).digest('base64')}};
  const calls:string[][]=[],requests:string[]=[];
  const state={running,failInstall:false,failFirstStart:false,installed:'0.1.6'};
  let starts=0;
  const execute=(args:string[],env?:NodeJS.ProcessEnv)=>{
    calls.push(args);
    if(args[0]==='npm-cli.js'){
      assert.equal(state.running,false,'Windows package files must be unlocked before npm');
      assert.equal(args.at(-1)?.endsWith('.tgz'),true,'install exact verified archive, never cached @latest');
      if(state.failInstall){write('broken');throw Error('EPERM npm cache');}
      write(state.installed);return 'installed';
    }
    if(args[1]==='status')return JSON.stringify({running:state.running,url:'http://127.0.0.1:5191/'});
    if(args[1]==='stop'){state.running=false;return '';}
    if(args[1]==='version')return fs.readFileSync(path.join(root,'package.json'),'utf8');
    if(args[1]==='start'){
      assert.equal(env?.REXP_WEB_PORT,'5191');starts++;
      if(state.failFirstStart&&starts===1)throw Error('new service failed to start');
      state.running=true;return '';
    }
    assert.fail('Unexpected operation '+args.join(' '));
  };
  const get=async(url:string)=>{requests.push(url);return url.endsWith('/latest')?Buffer.from(JSON.stringify(metadata)):archive;};
  return {state,metadata,calls,requests,root,write,archive,execute,options:{installDir,cli:'npm-cli.js',get,execute,cache:path.join(dir,'writable-cache')}};
}

test('Web update verifies uncached official release, stops before npm and restores the same port',async t=>{
  const f=fixture(t);const result=await installWeb(f.options);
  assert.equal(result.action,'updated');assert.equal(result.version,'0.1.6');assert.equal(result.from_version,'0.1.5');
  assert.deepEqual(f.requests,['https://registry.npmjs.org/rexp-web/latest',f.metadata.dist.tarball]);
  assert.deepEqual(f.calls.map(a=>a[0]==='npm-cli.js'?'npm':a[1]),['status','stop','npm','version','start']);
  assert.equal(f.state.running,true);
});

test('already current is explicit; install reuses existing Web without requesting an upgrade',async t=>{
  const f=fixture(t,{previous:'0.1.6'});
  assert.equal((await installWeb(f.options)).action,'already_current');assert.deepEqual(f.calls,[]);
  f.requests.length=0;
  assert.equal((await installWeb({...f.options,mode:'install'})).action,'reused');assert.deepEqual(f.requests,[]);
});

test('registry failure cannot claim update success or stop an existing service',async t=>{
  const f=fixture(t);
  await assert.rejects(installWeb({...f.options,get:async()=>{throw Error('ETIMEDOUT official registry');}}),/Latest|No service was stopped/);
  assert.deepEqual(f.calls,[]);assert.equal(f.state.running,true);
});

test('archive integrity is checked before stopping Web',async t=>{
  const f=fixture(t);f.metadata.dist.integrity='sha512-invalid';
  await assert.rejects(installWeb(f.options),/SHA-512/);assert.deepEqual(f.calls,[]);
});

test('failed install and wrong installed versions restore the prior package and running state',async t=>{
  for(const wrongVersion of [false,true]){
    const f=fixture(t);f.state.failInstall=!wrongVersion;f.state.installed='0.1.5';
    await assert.rejects(installWeb(f.options),error=>{
      assert.match(String(error),wrongVersion?/Expected 0.1.6/:/EPERM/);
      assert.match(String(error),/Registry: https:\/\/registry.npmjs.org/);assert.match(String(error),/Cache:/);return true;
    });
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.root,'package.json'),'utf8')).version,'0.1.5');
    assert.equal(f.state.running,true);
  }
});

test('restart failure rolls back; updating a stopped Web never starts it',async t=>{
  const f=fixture(t);f.state.failFirstStart=true;
  await assert.rejects(installWeb(f.options),/new service failed to start/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root,'package.json'),'utf8')).version,'0.1.5');assert.equal(f.state.running,true);
  const stopped=fixture(t,{running:false});await installWeb(stopped.options);
  assert.equal(stopped.state.running,false);assert.ok(!stopped.calls.some(a=>a[1]==='start'||a[1]==='stop'));
});
