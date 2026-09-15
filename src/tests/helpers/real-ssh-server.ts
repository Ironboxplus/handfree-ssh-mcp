import { createHash, generateKeyPairSync } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import ssh2 from "ssh2";
import { buildLocalTarArgv } from "../../services/ssh-connection-manager.js";

type FileHandleState = { kind: "file"; fd: number; localPath: string };
type DirectoryHandleState = {
  kind: "directory";
  entries: Array<{ filename: string; longname: string; attrs: Record<string, number> }>;
  sent: boolean;
};
type HandleState = FileHandleState | DirectoryHandleState;

export interface RealSshServerStats {
  activeWrites: number;
  maxActiveWrites: number;
  openedFiles: number;
  tarCommands: number;
  activeSftpChannels: number;
  maxActiveSftpChannels: number;
}

const { Server } = ssh2;
const { OPEN_MODE, STATUS_CODE, flagsToString } = (ssh2.utils as any).sftp;

function attrsFromStat(stat: fs.Stats): Record<string, number> {
  return {
    mode: stat.mode,
    uid: typeof stat.uid === "number" ? stat.uid : 0,
    gid: typeof stat.gid === "number" ? stat.gid : 0,
    size: stat.size,
    atime: Math.floor(stat.atimeMs / 1000),
    mtime: Math.floor(stat.mtimeMs / 1000),
  };
}

function parseShellWords(command: string): string[] {
  const words: string[] = [];
  let current = "";
  let inSingleQuote = false;
  let tokenStarted = false;

  for (let index = 0; index < command.length; index++) {
    const character = command[index];
    if (inSingleQuote) {
      if (character === "'") {
        inSingleQuote = false;
      } else {
        current += character;
      }
      tokenStarted = true;
      continue;
    }
    if (/\s/.test(character)) {
      if (tokenStarted) {
        words.push(current);
        current = "";
        tokenStarted = false;
      }
      continue;
    }
    if (character === "'") {
      inSingleQuote = true;
      tokenStarted = true;
      continue;
    }
    if (character === "\\" && index + 1 < command.length) {
      current += command[++index];
      tokenStarted = true;
      continue;
    }
    current += character;
    tokenStarted = true;
  }
  if (inSingleQuote) throw new Error(`Unterminated single quote in command: ${command}`);
  if (tokenStarted) words.push(current);
  return words;
}

export class RealSshTestServer {
  public readonly stats: RealSshServerStats = {
    activeWrites: 0,
    maxActiveWrites: 0,
    openedFiles: 0,
    tarCommands: 0,
    activeSftpChannels: 0,
    maxActiveSftpChannels: 0,
  };

  public port = 0;
  private readonly server: InstanceType<typeof Server>;
  private readonly clients = new Set<any>();

  public constructor(
    public readonly rootDirectory: string,
    private readonly writeResponseDelayMs = 8,
  ) {
    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { format: "pem", type: "pkcs1" },
      publicKeyEncoding: { format: "pem", type: "pkcs1" },
    });
    this.server = new Server({ hostKeys: [privateKey] }, (client) => {
      this.clients.add(client);
      client.once("close", () => this.clients.delete(client));
      client.on("authentication", (context) => {
        if (
          context.method === "password" &&
          context.username === "test" &&
          context.password === "test"
        ) {
          context.accept();
        } else {
          context.reject();
        }
      });
      client.on("ready", () => {
        client.on("session", (accept) => {
          const session = accept();
          session.on("sftp", (acceptSftp) => {
            // Each `session` here is one SSH channel; OpenSSH's `MaxSessions`
            // bounds exactly this — concurrently open channels on one
            // connection, not concurrent files or bytes. Count real channel
            // open/close so fileConcurrency-cap tests can observe the true
            // peak instead of trusting the client's own bookkeeping.
            this.stats.activeSftpChannels++;
            this.stats.maxActiveSftpChannels = Math.max(
              this.stats.maxActiveSftpChannels,
              this.stats.activeSftpChannels,
            );
            session.once("close", () => { this.stats.activeSftpChannels--; });
            this.attachSftp(acceptSftp());
          });
          session.on("exec", (acceptExec, _rejectExec, info) => {
            if (process.env.HANDFREE_REAL_SSH_TRACE === "1") {
              process.stderr.write(`[real-ssh ${this.port}] EXEC ${info.command}\n`);
            }
            this.executeCommand(acceptExec(), info.command);
          });
        });
      });
    });
  }

  public async start(): Promise<void> {
    fs.mkdirSync(this.rootDirectory, { recursive: true });
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", () => {
        this.server.off("error", reject);
        const address = this.server.address();
        if (!address || typeof address === "string") {
          reject(new Error("SSH test server did not expose a TCP port"));
          return;
        }
        this.port = address.port;
        resolve();
      });
    });
  }

  public async stop(): Promise<void> {
    for (const client of this.clients) client.end();
    await new Promise<void>((resolve, reject) => {
      this.server.close((error?: Error) => error ? reject(error) : resolve());
    });
  }

  /**
   * Reset the concurrent-SFTP-channel high-water mark to the current live
   * count. `maxActiveSftpChannels` otherwise accumulates across the whole
   * server lifetime (every earlier test that used this server), which makes
   * "did this transfer reach N concurrent channels" unanswerable from the
   * raw value alone — a later test could inherit an already-high peak from an
   * earlier one, or fail to prove its own concurrency if the earlier peak was
   * lower. Call this immediately before the transfer under test.
   */
  public resetChannelPeak(): void {
    this.stats.maxActiveSftpChannels = this.stats.activeSftpChannels;
  }

  public toLocalPath(remotePath: string): string {
    if (!remotePath.startsWith("/")) throw new Error(`Remote path is not absolute: ${remotePath}`);
    const components = remotePath.split("/").filter(Boolean);
    if (components.some((component) => component === "..")) {
      throw new Error(`Remote path escapes test root: ${remotePath}`);
    }
    return path.join(this.rootDirectory, ...components);
  }

  private attachSftp(sftp: any): void {
    const trace = (operation: string, detail = ""): void => {
      if (process.env.HANDFREE_REAL_SSH_TRACE === "1") {
        process.stderr.write(`[real-sftp ${this.port}] ${operation}${detail ? ` ${detail}` : ""}\n`);
      }
    };
    const handles = new Map<number, HandleState>();
    let nextHandle = 1;
    const makeHandle = (state: HandleState): Buffer => {
      const id = nextHandle++;
      handles.set(id, state);
      const handle = Buffer.alloc(4);
      handle.writeUInt32BE(id);
      return handle;
    };
    const lookupHandle = (handle: Buffer): HandleState | undefined =>
      handle.length === 4 ? handles.get(handle.readUInt32BE(0)) : undefined;
    const fail = (requestId: number, error: unknown): void => {
      const code = (error as NodeJS.ErrnoException)?.code === "ENOENT"
        ? STATUS_CODE.NO_SUCH_FILE
        : STATUS_CODE.FAILURE;
      sftp.status(requestId, code, (error as Error)?.message ?? "filesystem operation failed");
    };
    const statPath = (requestId: number, remotePath: string, lstat: boolean): void => {
      const operation = lstat ? fs.lstat : fs.stat;
      operation(this.toLocalPath(remotePath), (error, stat) => {
        if (error) return fail(requestId, error);
        sftp.attrs(requestId, attrsFromStat(stat));
      });
    };

    sftp.on("REALPATH", (requestId: number, remotePath: string) => {
      trace("REALPATH", remotePath);
      const normalized = path.posix.normalize(remotePath.startsWith("/") ? remotePath : `/${remotePath}`);
      sftp.name(requestId, [{ filename: normalized, longname: normalized, attrs: {} }]);
    });
    sftp.on("STAT", (requestId: number, remotePath: string) => { trace("STAT", remotePath); statPath(requestId, remotePath, false); });
    sftp.on("LSTAT", (requestId: number, remotePath: string) => { trace("LSTAT", remotePath); statPath(requestId, remotePath, true); });
    sftp.on("FSTAT", (requestId: number, handle: Buffer) => {
      trace("FSTAT");
      const state = lookupHandle(handle);
      if (!state || state.kind !== "file") return sftp.status(requestId, STATUS_CODE.FAILURE);
      fs.fstat(state.fd, (error, stat) => error ? fail(requestId, error) : sftp.attrs(requestId, attrsFromStat(stat)));
    });
    sftp.on("OPEN", (requestId: number, remotePath: string, flags: number, attrs: { mode?: number }) => {
      trace("OPEN", `${remotePath} flags=${flags}`);
      const localPath = this.toLocalPath(remotePath);
      const stringFlags = flagsToString(flags);
      if (!stringFlags) return sftp.status(requestId, STATUS_CODE.OP_UNSUPPORTED);
      fs.open(localPath, stringFlags, attrs.mode ?? 0o644, (error, fd) => {
        if (error) return fail(requestId, error);
        this.stats.openedFiles++;
        sftp.handle(requestId, makeHandle({ kind: "file", fd, localPath }));
      });
    });
    sftp.on("READ", (requestId: number, handle: Buffer, offset: number, length: number) => {
      trace("READ", `offset=${offset} length=${length}`);
      const state = lookupHandle(handle);
      if (!state || state.kind !== "file") return sftp.status(requestId, STATUS_CODE.FAILURE);
      const buffer = Buffer.alloc(length);
      fs.read(state.fd, buffer, 0, length, offset, (error, bytesRead) => {
        if (error) return fail(requestId, error);
        if (bytesRead === 0) return sftp.status(requestId, STATUS_CODE.EOF);
        sftp.data(requestId, buffer.subarray(0, bytesRead));
      });
    });
    sftp.on("WRITE", (requestId: number, handle: Buffer, offset: number, data: Buffer) => {
      trace("WRITE", `offset=${offset} length=${data.length}`);
      const state = lookupHandle(handle);
      if (!state || state.kind !== "file") return sftp.status(requestId, STATUS_CODE.FAILURE);
      this.stats.activeWrites++;
      this.stats.maxActiveWrites = Math.max(this.stats.maxActiveWrites, this.stats.activeWrites);
      fs.write(state.fd, data, 0, data.length, offset, (error) => {
        setTimeout(() => {
          this.stats.activeWrites--;
          if (error) fail(requestId, error);
          else sftp.status(requestId, STATUS_CODE.OK);
        }, this.writeResponseDelayMs);
      });
    });
    sftp.on("CLOSE", (requestId: number, handle: Buffer) => {
      trace("CLOSE");
      if (handle.length !== 4) return sftp.status(requestId, STATUS_CODE.FAILURE);
      const id = handle.readUInt32BE(0);
      const state = handles.get(id);
      if (!state) return sftp.status(requestId, STATUS_CODE.FAILURE);
      handles.delete(id);
      if (state.kind === "directory") return sftp.status(requestId, STATUS_CODE.OK);
      fs.close(state.fd, (error) => error ? fail(requestId, error) : sftp.status(requestId, STATUS_CODE.OK));
    });
    sftp.on("SETSTAT", (requestId: number, remotePath: string, attrs: { mode?: number; size?: number }) => {
      trace("SETSTAT", remotePath);
      this.applyAttrs(this.toLocalPath(remotePath), attrs, (error) =>
        error ? fail(requestId, error) : sftp.status(requestId, STATUS_CODE.OK));
    });
    sftp.on("FSETSTAT", (requestId: number, handle: Buffer, attrs: { mode?: number; size?: number }) => {
      trace("FSETSTAT");
      const state = lookupHandle(handle);
      if (!state || state.kind !== "file") return sftp.status(requestId, STATUS_CODE.FAILURE);
      this.applyAttrs(state.localPath, attrs, (error) =>
        error ? fail(requestId, error) : sftp.status(requestId, STATUS_CODE.OK));
    });
    sftp.on("MKDIR", (requestId: number, remotePath: string, attrs: { mode?: number }) => {
      trace("MKDIR", remotePath);
      fs.mkdir(this.toLocalPath(remotePath), { mode: attrs.mode ?? 0o755 }, (error) =>
        error ? fail(requestId, error) : sftp.status(requestId, STATUS_CODE.OK));
    });
    sftp.on("REMOVE", (requestId: number, remotePath: string) => {
      trace("REMOVE", remotePath);
      fs.unlink(this.toLocalPath(remotePath), (error) =>
        error ? fail(requestId, error) : sftp.status(requestId, STATUS_CODE.OK));
    });
    sftp.on("OPENDIR", (requestId: number, remotePath: string) => {
      trace("OPENDIR", remotePath);
      const localPath = this.toLocalPath(remotePath);
      fs.readdir(localPath, { withFileTypes: true }, (error, entries) => {
        if (error) return fail(requestId, error);
        try {
          const names = entries.map((entry) => {
            const stat = fs.lstatSync(path.join(localPath, entry.name));
            return { filename: entry.name, longname: entry.name, attrs: attrsFromStat(stat) };
          });
          sftp.handle(requestId, makeHandle({ kind: "directory", entries: names, sent: false }));
        } catch (statError) {
          fail(requestId, statError);
        }
      });
    });
    sftp.on("READDIR", (requestId: number, handle: Buffer) => {
      trace("READDIR");
      const state = lookupHandle(handle);
      if (!state || state.kind !== "directory") return sftp.status(requestId, STATUS_CODE.FAILURE);
      if (state.sent) return sftp.status(requestId, STATUS_CODE.EOF);
      state.sent = true;
      if (state.entries.length === 0) return sftp.status(requestId, STATUS_CODE.EOF);
      sftp.name(requestId, state.entries);
    });
  }

  private applyAttrs(
    localPath: string,
    attrs: { mode?: number; size?: number },
    callback: (error?: NodeJS.ErrnoException | null) => void,
  ): void {
    const operations: Array<(done: (error?: NodeJS.ErrnoException | null) => void) => void> = [];
    if (attrs.mode !== undefined) operations.push((done) => fs.chmod(localPath, attrs.mode!, done));
    if (attrs.size !== undefined) operations.push((done) => fs.truncate(localPath, attrs.size!, done));
    const next = (error?: NodeJS.ErrnoException | null): void => {
      if (error || operations.length === 0) return callback(error);
      operations.shift()!(next);
    };
    next();
  }

  private executeCommand(channel: any, command: string): void {
    if (process.env.HANDFREE_REAL_SSH_TRACE === "1") {
      channel.on("close", () => process.stderr.write(`[real-ssh ${this.port}] CHANNEL CLOSE\n`));
      channel.on("end", () => process.stderr.write(`[real-ssh ${this.port}] CHANNEL END\n`));
    }
    const finish = (code: number): void => {
      channel.exit(code);
      channel.end();
      channel.close();
    };
    let words: string[];
    try {
      words = parseShellWords(command);
    } catch (error) {
      channel.stderr.write(`${(error as Error).message}\n`);
      finish(2);
      return;
    }

    if (words[0] === "md5sum" && words.length === 2) {
      try {
        const remotePath = words[1];
        const digest = createHash("md5").update(fs.readFileSync(this.toLocalPath(remotePath))).digest("hex");
        channel.write(`${digest}  ${remotePath}\n`);
        finish(0);
      } catch (error) {
        channel.stderr.write(`${(error as Error).message}\n`);
        finish(1);
      }
      return;
    }

    if (words[0] !== "tar" || words.length < 5) {
      channel.stderr.write(`Unsupported real test command: ${command}\n`);
      finish(127);
      return;
    }

    this.stats.tarCommands++;
    const args = words.slice(1);
    args[1] = this.toLocalPath(args[1]);
    const changeDirectoryIndex = args.indexOf("-C");
    if (changeDirectoryIndex !== -1) {
      args[changeDirectoryIndex + 1] = this.toLocalPath(args[changeDirectoryIndex + 1]);
    }
    // This harness simulates a remote host but genuinely executes `tar` on
    // the Windows host. Absolute `X:\...` paths are substituted in above, so
    // the same drive-letter-as-remote-host misparse applies here, plus this
    // MSYS tar build separately corrupts a backslash-separated `-C <dir>`
    // argument during extraction. Shares buildLocalTarArgv with
    // ssh-connection-manager.ts's runLocalTar so the two stay in lockstep
    // instead of drifting apart as two hand-maintained copies.
    const localArgs = buildLocalTarArgv(args, process.platform);
    const child = spawn("tar", localArgs, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    child.stdout.pipe(channel, { end: false });
    child.stderr.pipe(channel.stderr, { end: false });
    child.once("error", (error) => {
      channel.stderr.write(`${error.message}\n`);
      finish(127);
    });
    child.once("close", (code) => {
      if (process.env.HANDFREE_REAL_SSH_TRACE === "1") {
        process.stderr.write(`[real-ssh ${this.port}] TAR CLOSE code=${code}\n`);
      }
      finish(code ?? 1);
    });
  }
}
