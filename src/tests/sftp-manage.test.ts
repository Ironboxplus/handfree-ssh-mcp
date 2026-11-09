import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {z} from 'zod';
import {fileMutationQuery,manageRemoteEntry} from '../tools/sftp-manage.js';
import {SSHConnectionManager} from '../services/ssh-connection-manager.js';
import {RealSshTestServer} from './helpers/real-ssh-server.js';

test('real SFTP mutations require confirmation, preserve collisions, enforce roots and unlink symlinks without following',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'sftp-manage-'));
  fs.mkdirSync(path.join(root,'allowed/tree/nested'),{recursive:true});fs.mkdirSync(path.join(root,'outside'));
  fs.writeFileSync(path.join(root,'allowed/old.txt'),'original');fs.writeFileSync(path.join(root,'allowed/existing.txt'),'keep');
  fs.writeFileSync(path.join(root,'outside/keep.txt'),'outside');fs.writeFileSync(path.join(root,'allowed/tree/nested/data.bin'),Buffer.from([0,255,17]));
  fs.symlinkSync(path.join(root,'outside'),path.join(root,'allowed/tree/link'));
  const server=new RealSshTestServer(root),manager=SSHConnectionManager.getInstance();
  const query=(extra:Record<string,unknown>)=>z.object(fileMutationQuery).parse({connectionName:'fixture',...extra});
  try{
    await server.start();manager.setConfig({fixture:{host:'127.0.0.1',port:server.port,username:'test',password:'test',keepaliveInterval:0,allowedRemoteDirectories:['/allowed']}},['fixture']);
    await assert.rejects(manageRemoteEntry(query({action:'delete',remotePath:'/allowed/old.txt'}),manager),/confirmation/);
    assert.equal(fs.readFileSync(path.join(root,'allowed/old.txt'),'utf8'),'original');
    await assert.rejects(manageRemoteEntry(query({action:'rename',remotePath:'/allowed/old.txt',newName:'existing.txt'}),manager),/TARGET_EXISTS/);
    assert.equal(fs.readFileSync(path.join(root,'allowed/existing.txt'),'utf8'),'keep');
    await manageRemoteEntry(query({action:'rename',remotePath:'/allowed/old.txt',newName:'中文 名称.txt'}),manager);
    assert.equal(fs.readFileSync(path.join(root,'allowed/中文 名称.txt'),'utf8'),'original');
    await assert.rejects(manageRemoteEntry(query({action:'rename',remotePath:'/allowed/中文 名称.txt',newName:'../escape'}),manager),/single filename/);
    await assert.rejects(manageRemoteEntry(query({action:'delete',remotePath:'/outside/keep.txt',confirm:true}),manager),/allowedRemoteDirectories/);
    await assert.rejects(manageRemoteEntry(query({action:'delete',remotePath:'/allowed/tree',confirm:true}),manager),/recursive/);
    const result=await manageRemoteEntry(query({action:'delete',remotePath:'/allowed/tree',recursive:true,confirm:true}),manager);
    assert.equal(result.removed,4);assert.equal(fs.existsSync(path.join(root,'allowed/tree')),false);
    assert.equal(fs.readFileSync(path.join(root,'outside/keep.txt'),'utf8'),'outside');
    assert.equal(server.stats.execCommandCount,0);
  }finally{manager.disconnect();await server.stop();fs.rmSync(root,{recursive:true,force:true});}
});

test('resolved parent policy is checked before a mutation can reach a symlink destination',async()=>{
  let mutated=false,closed=false;
  const fake={resolveServer:()=> 'fixture',getTransferService:()=>({validateRemotePath:(value:string)=>{if(!value.startsWith('/allowed/'))throw Error('REMOTE_PATH_NOT_ALLOWED');return value;}}),
    withOperationTimeout:async(p:Promise<unknown>)=>p,acquireSshClient:async()=>({close:()=>{closed=true;},client:{sftp:(cb:Function)=>cb(null,{
      realpath:(_p:string,done:Function)=>done(null,'/outside'),end:()=>{},lstat:()=>{mutated=true;},rename:()=>{mutated=true;},unlink:()=>{mutated=true;},
    })}})};
  const input=z.object(fileMutationQuery).parse({action:'delete',remotePath:'/allowed/link/file',confirm:true});
  await assert.rejects(manageRemoteEntry(input,fake as unknown as SSHConnectionManager),/REMOTE_PATH_NOT_ALLOWED/);
  assert.equal(mutated,false);assert.equal(closed,true);
});
