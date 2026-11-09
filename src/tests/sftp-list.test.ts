import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {z} from 'zod';
import {directoryQuery,readDirectory} from '../tools/sftp-list.js';
import {SSHConnectionManager} from '../services/ssh-connection-manager.js';
import {RealSshTestServer} from './helpers/real-ssh-server.js';

test('real SFTP directory browsing preserves names, pages results and enforces roots without shell commands',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'sftp-browser-'));
  fs.mkdirSync(path.join(root,'allowed/folder'),{recursive:true});
  for(const [name,text]of [['中文 空格.txt','hello'],['b.txt','long text'],['.hidden','hidden']])fs.writeFileSync(path.join(root,'allowed',name),text);
  const server=new RealSshTestServer(root),manager=SSHConnectionManager.getInstance();
  const query=(extra:Record<string,unknown>={})=>z.object(directoryQuery).parse({connectionName:'fixture',...extra});
  try{
    await server.start();manager.setConfig({fixture:{host:'127.0.0.1',port:server.port,username:'test',password:'test',keepaliveInterval:0,allowedRemoteDirectories:['/allowed']}},['fixture']);
    const first=await readDirectory(query({pageSize:2}),manager);assert.equal(first.path,'/allowed');assert.equal(first.parent,null);assert.equal(first.total,3);assert.equal(first.entries[0].type,'directory');assert.equal(first.entries.length,2);
    const second=await readDirectory(query({remotePath:'/allowed',page:2,pageSize:2}),manager);assert.equal(second.entries.length,1);assert.ok([...first.entries,...second.entries].some(e=>e.name==='中文 空格.txt'));
    const exact=await readDirectory(query({names:['.hidden'],showHidden:false}),manager);assert.equal(exact.entries[0].name,'.hidden');
    const child=await readDirectory(query({remotePath:'/allowed/folder'}),manager);assert.equal(child.parent,'/allowed');
    await assert.rejects(readDirectory(query({remotePath:'/outside'}),manager),/allowedRemoteDirectories/);
    await assert.rejects(readDirectory(query({remotePath:'/allowed/../outside'}),manager),/\.\./);
    assert.equal(server.stats.execCommandCount,0);
  }finally{manager.disconnect();await server.stop();fs.rmSync(root,{recursive:true,force:true});}
});
