import path from 'node:path';
import type {SFTPWrapper,Stats} from 'ssh2';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {z} from 'zod';
import {SSHConnectionManager} from '../services/ssh-connection-manager.js';
import {rejectUnknownArguments} from './strict-arguments.js';
import {ToolError,formatToolErrorResponse,toToolError} from '../utils/tool-error.js';

export const fileMutationQuery={
  connectionName:z.string().optional().describe('SSH server alias; required with multiple enabled servers.'),
  action:z.enum(['rename','delete']).describe('Rename one entry in its current directory, or delete it.'),
  remotePath:z.string().describe('Absolute SFTP path of the existing entry, within allowedRemoteDirectories.'),
  newName:z.string().optional().describe('Rename only: a single filename, not a path. Existing targets are never overwritten.'),
  recursive:z.boolean().default(false).describe('Delete only: allow removing a directory and its contents. Symlinks are unlinked, never traversed.'),
  confirm:z.boolean().default(false).describe('Delete only: must be true after the user confirms the exact server and path. Permanent deletion, no trash.'),
};
const schema=z.object(fileMutationQuery);
type Mutation=z.infer<typeof schema>;
const windowsAbsolute=(value:string)=>/^[A-Za-z]:\//.test(value)?`/${value}`:value;

export async function manageRemoteEntry(input:Mutation,manager=SSHConnectionManager.getInstance()) {
  const name=manager.resolveServer(input.connectionName),service=manager.getTransferService();
  const requested=service.validateRemotePath(input.remotePath,name);
  if(requested==='/'||/^\/[A-Za-z]:\/?$/.test(requested))throw new ToolError('REMOTE_PATH_NOT_ALLOWED','Cannot modify a filesystem root');
  if(input.action==='delete'&&!input.confirm)throw new ToolError('INVALID_CONFIGURATION','Deletion requires explicit confirmation of the server and path');
  if(input.action==='rename'&&(!input.newName||['.','..'].includes(input.newName)||/[\\/\0\r\n]/.test(input.newName)||Buffer.byteLength(input.newName)>255))throw new ToolError('INVALID_CONFIGURATION','newName must be a single filename');
  const acquired=await manager.acquireSshClient(name);
  let sftp:SFTPWrapper|undefined;
  const bounded=<T>(promise:Promise<T>)=>manager.withOperationTimeout(promise,30_000,'sftp-manage');
  const stat=(file:string)=>bounded(new Promise<Stats>((resolve,reject)=>sftp!.lstat(file,(error,value)=>error?reject(error):resolve(value))));
  const real=(file:string)=>bounded(new Promise<string>((resolve,reject)=>sftp!.realpath(file,(error,value)=>error?reject(error):resolve(windowsAbsolute(value)))));
  const operation=(call:(callback:(error?:Error|null)=>void)=>void)=>bounded(new Promise<void>((resolve,reject)=>call(error=>error?reject(error):resolve())));
  const check=(file:string)=>service.validateRemotePath(file,name);
  try{
    sftp=await manager.withOperationTimeout(new Promise<SFTPWrapper>((resolve,reject)=>acquired.client.sftp((error,value)=>error?reject(error):resolve(value))),30_000,'sftp-manage channel',late=>late.end());
    // Resolve the parent, not the entry: a symlink can be renamed or unlinked
    // without granting access to, or deleting, the target it points at.
    const parent=check(await real(path.posix.dirname(requested)));
    const target=check(path.posix.join(parent,path.posix.basename(requested)));
    const attrs=await stat(target);
    if(input.action==='rename'){
      const destination=check(path.posix.join(parent,input.newName!));
      if(destination===target)return {action:'rename',path:target,newPath:destination};
      let exists=false;
      try{await stat(destination);exists=true;}catch(error){if((error as {code?:number}).code!==2)throw error;}
      if(exists)throw new ToolError('SFTP_ERROR','TARGET_EXISTS: target already exists; overwrite is not allowed');
      // Standard SFTP v3 RENAME rejects existing destinations. Do not use the
      // POSIX rename extension, whose semantics would replace the target.
      await operation(callback=>sftp!.rename(target,destination,callback));
      return {action:'rename',path:target,newPath:destination};
    }
    let removed=0;
    const remove=async(file:string,entry:Stats):Promise<void>=>{
      check(file);
      if(entry.isDirectory()){
        if(!input.recursive)throw new ToolError('INVALID_CONFIGURATION','Directory deletion requires recursive=true');
        check(await real(file));
        const entries=await bounded(new Promise<import('ssh2').FileEntry[]>((resolve,reject)=>sftp!.readdir(file,(error,value)=>error?reject(error):resolve(value))));
        for(const child of entries){
          if(child.filename==='.'||child.filename==='..')continue;
          if(/[\\/\0]/.test(child.filename))throw new ToolError('REMOTE_PATH_NOT_ALLOWED','Invalid filename in directory listing');
          const childPath=check(path.posix.join(file,child.filename));
          await remove(childPath,await stat(childPath));
        }
        await operation(callback=>sftp!.rmdir(file,callback));
      }else{
        if(!entry.isFile()&&!entry.isSymbolicLink())throw new ToolError('INVALID_CONFIGURATION','Only regular files, directories and symlinks can be deleted');
        await operation(callback=>sftp!.unlink(file,callback));
      }
      removed++;
    };
    await remove(target,attrs);
    return {action:'delete',path:target,removed};
  }finally{sftp?.end();acquired.close();}
}

export function registerSftpManageTool(server:McpServer) {
  rejectUnknownArguments(server.tool('sftp-manage','Rename or permanently delete remote entries over SFTP. Uses existing remote directory policy; no shell. Delete requires explicit confirmation; rename never overwrites. No automatic retry after an uncertain result.',fileMutationQuery,async input=>{
    try{return {content:[{type:'text' as const,text:JSON.stringify(await manageRemoteEntry(input))}]};}
    catch(error){return {content:[{type:'text' as const,text:formatToolErrorResponse(toToolError(error,'SFTP_ERROR'))}],isError:true};}
  }));
}
