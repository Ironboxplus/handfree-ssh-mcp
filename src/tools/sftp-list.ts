import path from 'node:path';
import type {SFTPWrapper, FileEntry} from 'ssh2';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {z} from 'zod';
import {SSHConnectionManager} from '../services/ssh-connection-manager.js';
import {rejectUnknownArguments} from './strict-arguments.js';
import {formatToolErrorResponse, toToolError} from '../utils/tool-error.js';

export const directoryQuery = {
  connectionName:z.string().optional().describe('SSH server alias, required when multiple servers are enabled.'),
  remotePath:z.string().optional().describe('Absolute SFTP path. Omit to open an allowed root or the SSH home directory.'),
  page:z.number().int().min(1).default(1).describe('One-based result page.'),
  pageSize:z.number().int().min(1).max(200).default(50).describe('Entries per page, maximum 200.'),
  showHidden:z.boolean().default(false).describe('Include dotfiles.'),
  query:z.string().max(200).default('').describe('Case-insensitive filename filter.'),
  names:z.array(z.string()).max(500).optional().describe('Optional exact filenames to inspect, including hidden entries.'),
  sort:z.enum(['name','modified','size']).default('name').describe('Sort field; directories always appear first.'),
  direction:z.enum(['asc','desc']).default('asc').describe('Sort direction.'),
};
const schema=z.object(directoryQuery);
type Query=z.infer<typeof schema>;
const windowsAbsolute=(value:string)=>/^[A-Za-z]:\//.test(value)?`/${value}`:value;

export async function readDirectory(input:Query, manager=SSHConnectionManager.getInstance()) {
  const name=manager.resolveServer(input.connectionName);
  const service=manager.getTransferService();
  const config=manager.getConfig(name);
  const requested=input.remotePath || (!config.disableSftpPathPolicy && config.allowedRemoteDirectories?.[0]) || undefined;
  if(requested) service.validateRemotePath(requested,name);
  const acquired=await manager.acquireSshClient(name);
  let sftp:SFTPWrapper|undefined;
  const bounded=<T>(work:Promise<T>,label:string)=>manager.withOperationTimeout(work,30_000,`sftp-list ${label}`);
  try {
    sftp=await manager.withOperationTimeout(new Promise<SFTPWrapper>((resolve,reject)=>{
      acquired.client.sftp((e,value)=>e?reject(e):resolve(value));
    }),30_000,'sftp-list channel',late=>late.end());
    const directory=service.validateRemotePath(windowsAbsolute(await bounded(new Promise<string>((resolve,reject)=>{
      sftp!.realpath(requested || '.',(e,value)=>e?reject(e):resolve(value));
    }),'realpath')),name);
    let entries=await bounded(new Promise<FileEntry[]>((resolve,reject)=>{
      sftp!.readdir(directory,(e,value)=>e?reject(e):resolve(value));
    }),'readdir');
    const names=input.names && new Set(input.names);
    entries=entries.filter(e=>e.filename!=='.'&&e.filename!=='..'&&(names?names.has(e.filename):(input.showHidden||!e.filename.startsWith('.'))&&e.filename.toLowerCase().includes(input.query.toLowerCase())));
    const type=(e:FileEntry)=>(e.attrs.mode&0o170000)===0o040000?'directory':(e.attrs.mode&0o170000)===0o100000?'file':(e.attrs.mode&0o170000)===0o120000?'link':'other';
    entries.sort((a,b)=>{
      const group=Number(type(b)==='directory')-Number(type(a)==='directory');
      const order=input.sort==='modified'?a.attrs.mtime-b.attrs.mtime:input.sort==='size'?a.attrs.size-b.attrs.size:a.filename.localeCompare(b.filename,'zh-CN',{numeric:true});
      return group || (input.direction==='asc'?1:-1)*(order || a.filename.localeCompare(b.filename));
    });
    const page=Math.min(input.page,Math.max(1,Math.ceil(entries.length/input.pageSize)));
    let parent:string|null=path.posix.dirname(directory);
    if(parent===directory || /^\/[A-Za-z]:\/?$/.test(directory))parent=null;
    if(parent)try{service.validateRemotePath(parent,name);}catch{parent=null;}
    return {path:directory,parent,page,pageSize:input.pageSize,total:entries.length,
      entries:entries.slice((page-1)*input.pageSize,page*input.pageSize).map(e=>({
        name:e.filename,type:type(e),size:e.attrs.size,modifiedAt:new Date(e.attrs.mtime*1000).toISOString(),
      }))};
  }finally{sftp?.end();acquired.close();}
}

export function registerSftpListTool(server:McpServer) {
  rejectUnknownArguments(server.tool('sftp-list','Browse a remote directory over the existing SFTP connection. Returns a sorted, filtered page with file types, sizes and modification times. Respects remote path policy; no shell or remote Python required.',directoryQuery,
    async input=>{
      try{return {content:[{type:'text' as const,text:JSON.stringify(await readDirectory(input))}]};}
      catch(e){return {content:[{type:'text' as const,text:formatToolErrorResponse(toToolError(e,'SFTP_ERROR'))}],isError:true};}
    }));
}
