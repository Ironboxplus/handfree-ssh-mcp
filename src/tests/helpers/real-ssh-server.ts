import { createHash, generateKeyPairSync, timingSafeEqual } from "node:crypto";
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
  // PLAN.MD P1-03 (walker slice): a directory listing's real server-side
  // lifetime, from the client's OPENDIR request to its CLOSE of that
  // handle. This is distinct from activeSftpChannels (one SFTP channel can
  // carry many sequential OPENDIR/OPEN lifetimes) and lets tests prove the
  // walker's concurrent `readdir` calls specifically, without conflating
  // that with file-transfer concurrency.
  activeReaddirs: number;
  maxActiveReaddirs: number;
  // Cumulative count of OPENDIR requests received (never decrements). Lets a
  // test deterministically wait for "N directory listings have really been
  // requested" as a real synchronization signal, instead of guessing at a
  // wall-clock sleep duration that would be flaky under system load.
  openDirRequests: number;
  // PLAN.MD P1-04a (striped download): every real READ request's (offset,
  // length), in receipt order, across every file the server has served
  // since the last resetReadLog(). Lets a grey-box test assert on the
  // ranges the client actually requested -- not on the client's own
  // bookkeeping -- to prove striped download's ranges are non-overlapping
  // and exactly cover the file.
  readRequests: Array<{ offset: number; length: number }>;
  // PLAN.MD P1-08a: cumulative count of real "exec" channel requests this
  // instance has received (covers md5sum/tar/the generic real-shell
  // fallback alike). Lets a test prove a rejected direct-transfer call made
  // ZERO exec attempts (path-policy failed before any network I/O), the same
  // "prove it with a real counter" discipline maxActiveSftpChannels already
  // applies to SFTP.
  execCommandCount: number;
  // Multi-connection download: cumulative count of real, distinct TCP+SSH
  // connections this instance has accepted (incremented once per accepted
  // socket, before the SSH handshake even starts) -- never decrements, and
  // critically NOT the same thing as activeSftpChannels/maxActiveSftpChannels
  // above. A design that opens N SFTP *channels* on ONE shared connection
  // would show N there too; only this counter distinguishes "N independent
  // connections" (the property multi-connection download depends on for any
  // possible speedup) from "N channels on one connection" (the previously
  // deleted striped design, which shared one connection's SSH channel
  // window and could not speed anything up). See resetConnectionCount().
  connectionCount: number;
  // Connections accepted but not yet authenticated ("ready"), and the peak
  // of that since the last resetConnectionCount(). Distinguishes N handshakes
  // done concurrently (peak N) from N done one after another (peak 1) --
  // connectionCount alone reports N either way. Only meaningful together with
  // setAuthDelayMs(), which gives each handshake a real duration to overlap in.
  activeHandshakes: number;
  maxActiveHandshakes: number;
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
    activeReaddirs: 0,
    maxActiveReaddirs: 0,
    openDirRequests: 0,
    readRequests: [],
    execCommandCount: 0,
    connectionCount: 0,
    activeHandshakes: 0,
    maxActiveHandshakes: 0,
  };

  public port = 0;
  private readonly server: InstanceType<typeof Server>;
  private readonly clients = new Set<any>();
  // PLAN.MD P1-04a (striped download failure/cleanup test): once set, every
  // real READ request received AFTER the configured count gets a genuine
  // SFTP protocol-level failure response instead of real data -- a real
  // server-side error over the real SFTP channel, not a stub of the ssh2
  // client. Deterministic on request count rather than wall-clock timing,
  // so a mid-transfer failure with some workers already making real
  // progress (and others then genuinely cancelled) is reproducible without
  // any sleep/poll race.
  private failReadsAfterCount: number | null = null;
  // Multi-connection download (out-of-order-completion proof): when set,
  // overrides readResponseDelayMs on a per-CONNECTION basis -- index K is
  // the delay (ms) applied to READ responses on the K-th connection this
  // instance has accepted since the last resetConnectionCount() (0-based).
  // Undefined/missing entries fall back to the constant readResponseDelayMs.
  // This lets a test force a specific connection to finish its range LAST
  // even though it was opened FIRST and assigned the file's first range --
  // a real, deterministic out-of-order completion, rather than hoping local
  // disk I/O happens to race unpredictably.
  private connectionReadDelaysMs: number[] | null = null;
  // Multi-connection download ("cancel the rest" proof): when set, every
  // READ on one of these connection indices fails immediately (regardless
  // of failReadsAfterCount's global request-count threshold above). Lets a
  // test fail exactly ONE connection while every other connection stays
  // genuinely healthy, so "the healthy ones got cancelled" can be told apart
  // from "the healthy ones failed anyway because the fault was global" --
  // failReadsAfterCount alone cannot make that distinction, since it fails
  // every connection's next read once the shared counter is past threshold.
  private failReadsForConnectionIndex: Set<number> | null = null;
  // A real delay before accepting authentication, i.e. a handshake that
  // genuinely takes this long -- the in-process stand-in for a
  // high-latency link, where each SSH handshake costs several round trips.
  // Same rationale as readResponseDelayMs: without it a local handshake is
  // too fast for concurrent ones to observably overlap. 0 = unchanged.
  private authDelayMs = 0;
  // Connection indices (see connectionReadDelaysMs) whose authentication is
  // genuinely rejected -- a real failed handshake for exactly one of several
  // concurrent connections, the others staying healthy.
  private rejectAuthForConnectionIndex: Set<number> | null = null;
  // PLAN.MD P1-08a: parsed once in the constructor from
  // directExecOptions.authorizedPublicKeyPem (see below), or undefined when
  // that option is omitted -- `any` because ssh2's ParsedKey type isn't
  // exported from its public typings.
  private readonly authorizedKey: any;
  // PLAN.MD P1-08a: this instance's own real host private key (PEM), set in
  // the constructor. Backs knownHostsLine() below, which lets a test PIN a
  // real, correct known_hosts entry for this exact server (via a temp
  // HOME's .ssh/known_hosts, see directExecOptions.execEnv) instead of
  // disabling host-key checking to make a happy-path test pass.
  private hostPrivateKeyPem = "";

  public constructor(
    public readonly rootDirectory: string,
    private readonly writeResponseDelayMs = 8,
    // PLAN.MD P1-03 (walker slice): a real, injected per-OPENDIR delay. Local
    // in-process fs.readdir calls otherwise resolve in well under a
    // millisecond, which can make genuinely concurrent `readdir` calls fail
    // to overlap in wall-clock terms even when the client legitimately
    // issued them concurrently -- a real delay in a real server (the same
    // pattern already used for writeResponseDelayMs above), not a mock,
    // makes the overlap observable and non-flaky. Zero by default so every
    // other test's behavior is unchanged.
    private readonly readdirResponseDelayMs = 0,
    // PLAN.MD P1-04a (striped download): a real, injected per-READ delay,
    // same rationale as readdirResponseDelayMs above -- local disk reads
    // otherwise resolve too fast for genuinely concurrent stripe channels
    // to reliably overlap in wall-clock terms. Zero by default so every
    // other test's behavior (including reads outside this suite) is
    // unchanged.
    private readonly readResponseDelayMs = 0,
    // PLAN.MD P1-08a (direct transfer): options for the generic real-shell
    // exec fallback below (see executeCommand), which is what a direct
    // transfer's rsync/tar|ssh backend commands run against when this
    // instance plays "source" or "destination" in a real-fixture test.
    //   - execEnv: environment passed to that spawned shell. Overriding HOME
    //     here lets a test point ssh's own default identity/known_hosts
    //     resolution at a throwaway temp directory instead of this test
    //     machine's real ~/.ssh -- exactly mirroring "the key/host-key trust
    //     already present on the source server", without ever touching a
    //     real developer's actual SSH state. Defaults to process.env
    //     (unchanged behavior) when omitted.
    //   - authorizedPublicKeyOpenSsh: a public key in OpenSSH single-line
    //     format ("ssh-rsa AAAA...", i.e. `<type> <base64>`, no comment
    //     needed) this instance additionally accepts for publickey auth, on
    //     top of the existing password ("test"/"test") auth. Undefined by
    //     default, which preserves password-only auth exactly as before --
    //     existing tests that never set this see no behavior change. NOTE:
    //     ssh2's own utils.parseKey cannot parse a PEM "RSA PUBLIC KEY"
    //     (PKCS1) or "PUBLIC KEY" (SPKI) block (verified for real -- both
    //     return an Error), only PEM PRIVATE keys or this OpenSSH line
    //     format; derive this from a real private key with
    //     `const k = ssh2.utils.parseKey(privateKeyPem); \`${k.type} ${k.getPublicSSH().toString("base64")}\``.
    private readonly directExecOptions: { execEnv?: NodeJS.ProcessEnv; authorizedPublicKeyOpenSsh?: string } = {},
  ) {
    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { format: "pem", type: "pkcs1" },
      publicKeyEncoding: { format: "pem", type: "pkcs1" },
    });
    const authorizedKey = directExecOptions.authorizedPublicKeyOpenSsh
      ? (ssh2.utils as any).parseKey(directExecOptions.authorizedPublicKeyOpenSsh)
      : undefined;
    this.authorizedKey = authorizedKey && !(authorizedKey instanceof Error) ? authorizedKey : undefined;
    this.hostPrivateKeyPem = privateKey;
    this.server = new Server({ hostKeys: [privateKey] }, (client) => {
      // Counted here, on raw socket accept, before the SSH handshake even
      // starts -- this is the real, wire-level "one distinct TCP+SSH
      // connection" event. connectionIndex is this connection's own 0-based
      // position among connections since the last resetConnectionCount().
      const connectionIndex = this.stats.connectionCount;
      this.stats.connectionCount++;
      this.stats.activeHandshakes++;
      this.stats.maxActiveHandshakes = Math.max(this.stats.maxActiveHandshakes, this.stats.activeHandshakes);
      let handshakeCounted = true;
      const endHandshake = () => {
        if (!handshakeCounted) return;
        handshakeCounted = false;
        this.stats.activeHandshakes--;
      };
      this.clients.add(client);
      client.once("close", () => {
        endHandshake();
        this.clients.delete(client);
      });
      // PLAN.MD P1-08a: this fixture now routinely runs several real ssh2
      // servers concurrently in one test file (one making real outbound ssh
      // connections to another), so a connection being reset mid-teardown
      // by a concurrent stop() elsewhere is an expected, benign occurrence,
      // not a bug -- without this listener the underlying socket's 'error'
      // event has no handler and crashes the whole test process (observed
      // for real; see this task's investigation notes).
      client.on("error", () => { /* connection reset during teardown; nothing to do */ });
      client.on("authentication", (context) => {
        if (this.rejectAuthForConnectionIndex?.has(connectionIndex)) {
          context.reject([]);
          return;
        }
        if (
          context.method === "password" &&
          context.username === "test" &&
          context.password === "test"
        ) {
          if (this.authDelayMs > 0) {
            setTimeout(() => context.accept(), this.authDelayMs);
          } else {
            context.accept();
          }
          return;
        }
        if (context.method === "publickey" && this.authorizedKey) {
          const offered = context.key;
          const allowedPublicSsh: Buffer = this.authorizedKey.getPublicSSH();
          // A real client offering an RSA key negotiates a SIGNATURE
          // algorithm (rsa-sha2-256/512, per RFC 8332) that is NOT the same
          // string as the KEY TYPE itself ("ssh-rsa") -- observed for real
          // against this fixture with OpenSSH_9.7p1, which defaults to
          // rsa-sha2-256 even for a plain ssh-rsa key. Accept either the
          // exact key type or one of its RSA-SHA2 signature variants.
          const sameAlgo = offered.algo === this.authorizedKey.type
            || (this.authorizedKey.type === "ssh-rsa" && (offered.algo === "rsa-sha2-256" || offered.algo === "rsa-sha2-512"));
          const sameData = Buffer.isBuffer(offered.data)
            && offered.data.length === allowedPublicSsh.length
            && timingSafeEqual(offered.data, allowedPublicSsh);
          // verify() needs the negotiated hash algorithm (context.hashAlgo)
          // to interpret an RSA-SHA2 signature correctly -- omitting it
          // silently falls back to a default that does not match what the
          // client actually signed with, and verification fails even for a
          // genuinely correct key/signature. Also observed for real.
          const signatureOk = !context.signature
            || this.authorizedKey.verify(context.blob, context.signature, context.hashAlgo) === true;
          if (sameAlgo && sameData && signatureOk) {
            context.accept();
            return;
          }
        }
        context.reject();
      });
      client.on("ready", () => {
        endHandshake();
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
            this.attachSftp(acceptSftp(), connectionIndex);
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

  /** Same reasoning as resetChannelPeak(), for the readdir-lifetime counter. */
  public resetReaddirPeak(): void {
    this.stats.maxActiveReaddirs = this.stats.activeReaddirs;
  }

  /**
   * Clear the accumulated READ request log. Call immediately before the
   * transfer under test so its range-coverage assertions cannot be
   * satisfied by an earlier test's READ requests against this shared
   * server. See resetChannelPeak() for the same reasoning.
   */
  public resetReadLog(): void {
    this.stats.readRequests.length = 0;
  }

  /**
   * From the (count+1)-th real READ request onward (counting from the
   * current resetReadLog() baseline), respond with a genuine SFTP
   * STATUS_CODE.FAILURE instead of real data. Lets a test let some stripe
   * workers make genuine progress before a real, protocol-level failure
   * hits -- deterministic on request count, not timing.
   */
  public injectReadFailureAfter(count: number): void {
    this.failReadsAfterCount = count;
  }

  public clearReadFailureInjection(): void {
    this.failReadsAfterCount = null;
  }

  /**
   * Reset the cumulative connection counter (and, since a new connection's
   * index is derived from this counter's current value, the per-connection
   * index the NEXT accepted connection will get) to 0. Call immediately
   * before the transfer under test, same reasoning as resetReadLog(): an
   * earlier test's connections must not be attributable to this one, and a
   * test that wants to control specific connection indices (see
   * setConnectionReadDelaysMs) needs those indices to start at 0.
   */
  public resetConnectionCount(): void {
    this.stats.connectionCount = 0;
    this.stats.maxActiveHandshakes = this.stats.activeHandshakes;
  }

  /** See authDelayMs above. */
  public setAuthDelayMs(delayMs: number): void {
    this.authDelayMs = delayMs;
  }

  /** See rejectAuthForConnectionIndex above; null clears it. */
  public setRejectAuthForConnectionIndices(indices: number[] | null): void {
    this.rejectAuthForConnectionIndex = indices ? new Set(indices) : null;
  }

  /** Connections currently open on the server side, whatever their state. */
  public get liveConnectionCount(): number {
    return this.clients.size;
  }

  /** See connectionReadDelaysMs above. */
  public setConnectionReadDelaysMs(delaysMs: number[]): void {
    this.connectionReadDelaysMs = delaysMs;
  }

  public clearConnectionReadDelaysMs(): void {
    this.connectionReadDelaysMs = null;
  }

  /** See failReadsForConnectionIndex above. */
  public injectReadFailureForConnectionIndex(indices: number[]): void {
    this.failReadsForConnectionIndex = new Set(indices);
  }

  public clearReadFailureForConnectionIndex(): void {
    this.failReadsForConnectionIndex = null;
  }

  public toLocalPath(remotePath: string): string {
    if (!remotePath.startsWith("/")) throw new Error(`Remote path is not absolute: ${remotePath}`);
    const components = remotePath.split("/").filter(Boolean);
    if (components.some((component) => component === "..")) {
      throw new Error(`Remote path escapes test root: ${remotePath}`);
    }
    return path.join(this.rootDirectory, ...components);
  }

  /**
   * PLAN.MD P1-08a: a real OpenSSH known_hosts line for THIS instance's own
   * real generated host key -- e.g. `[127.0.0.1]:52341 ssh-rsa AAAA...`.
   * Lets a test pin trust for this exact server (write this line into a temp
   * HOME's `.ssh/known_hosts`) the same way an operator would with
   * `ssh-keyscan`, rather than disabling host-key checking to reach a
   * happy-path direct-transfer test.
   */
  public knownHostsLine(hostPattern = `[127.0.0.1]:${this.port}`): string {
    const parsed = (ssh2.utils as any).parseKey(this.hostPrivateKeyPem);
    const publicSsh: Buffer = parsed.getPublicSSH();
    return `${hostPattern} ${parsed.type} ${publicSsh.toString("base64")}`;
  }

  private attachSftp(sftp: any, connectionIndex = -1): void {
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
      this.stats.readRequests.push({ offset, length });
      if (this.failReadsAfterCount !== null && this.stats.readRequests.length > this.failReadsAfterCount) {
        return sftp.status(requestId, STATUS_CODE.FAILURE, "injected read failure (test)");
      }
      if (this.failReadsForConnectionIndex?.has(connectionIndex)) {
        return sftp.status(requestId, STATUS_CODE.FAILURE, "injected per-connection read failure (test)");
      }
      const state = lookupHandle(handle);
      if (!state || state.kind !== "file") return sftp.status(requestId, STATUS_CODE.FAILURE);
      const buffer = Buffer.alloc(length);
      const respond = (error: NodeJS.ErrnoException | null, bytesRead: number): void => {
        if (error) return fail(requestId, error);
        if (bytesRead === 0) return sftp.status(requestId, STATUS_CODE.EOF);
        sftp.data(requestId, buffer.subarray(0, bytesRead));
      };
      fs.read(state.fd, buffer, 0, length, offset, (error, bytesRead) => {
        const delayMs = this.connectionReadDelaysMs?.[connectionIndex] ?? this.readResponseDelayMs;
        if (delayMs > 0) setTimeout(() => respond(error, bytesRead), delayMs);
        else respond(error, bytesRead);
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
      if (state.kind === "directory") {
        this.stats.activeReaddirs--;
        return sftp.status(requestId, STATUS_CODE.OK);
      }
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
      // Counts from the OPENDIR request itself (not after the local
      // fs.readdir resolves) so the peak reflects real concurrent in-flight
      // listings, matching how activeSftpChannels counts from channel open.
      this.stats.activeReaddirs++;
      this.stats.openDirRequests++;
      this.stats.maxActiveReaddirs = Math.max(this.stats.maxActiveReaddirs, this.stats.activeReaddirs);
      const localPath = this.toLocalPath(remotePath);
      const respond = (): void => {
        fs.readdir(localPath, { withFileTypes: true }, (error, entries) => {
          if (error) {
            this.stats.activeReaddirs--;
            return fail(requestId, error);
          }
          try {
            const names = entries.map((entry) => {
              const stat = fs.lstatSync(path.join(localPath, entry.name));
              return { filename: entry.name, longname: entry.name, attrs: attrsFromStat(stat) };
            });
            sftp.handle(requestId, makeHandle({ kind: "directory", entries: names, sent: false }));
          } catch (statError) {
            this.stats.activeReaddirs--;
            fail(requestId, statError);
          }
        });
      };
      if (this.readdirResponseDelayMs > 0) setTimeout(respond, this.readdirResponseDelayMs);
      else respond();
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
    this.stats.execCommandCount++;
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

    // The `!command.includes("|")` guard matters for PLAN.MD P1-08a: a
    // direct-transfer tar|ssh command also starts with "tar" and easily has
    // >=5 words, but it is a pipeline this simple argv-indexed handler was
    // never written to understand (it would try to feed "|", "ssh", "-o",
    // ... to real tar as if they were tar's own arguments). Route pipelines
    // to the real-shell fallback below instead.
    if (words[0] !== "tar" || words.length < 5 || command.includes("|")) {
      this.executeGenericShellCommand(channel, command);
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

  /**
   * PLAN.MD P1-08a: real-shell fallback for any exec command that is not one
   * of the simple tar/md5sum forms above -- specifically the probe commands
   * (`rsync --version`, `ssh -V`, `tar --version`, the non-interactive
   * `ssh ... true` reachability probe) and the actual rsync/tar|ssh direct-
   * copy commands TransferService builds. Spawns a REAL `sh -c command`
   * subprocess: a genuine ssh/rsync/tar binary on THIS test machine does the
   * real work, including making a real outbound TCP/SSH connection when the
   * command targets another RealSshTestServer instance -- nothing here is
   * stubbed.
   *
   * Path translation: this fixture simulates "a real remote host" by mapping
   * remote absolute paths onto rootDirectory (see toLocalPath), but a
   * compound shell command is opaque text, not structured argv, so it can't
   * be translated the way the tar branch above translates argv[1]/-C by
   * index. Rather than generic (and fragile) path-shaped regexing, this only
   * recognizes the exact fixed shapes buildDirectTarSshCommand in
   * direct-transfer.ts always produces, and the two shapes are mutually
   * exclusive on any single command this method ever receives:
   *   - SOURCE side (this instance is where MCP's own exec landed): the
   *     command starts with `tar -cf - -C '<dir>' -- `. Only <dir> is
   *     translated; everything after the pipe (the embedded, still-quoted
   *     command meant for the destination) is left completely alone here --
   *     it is opaque to the source and is not this fixture's job to
   *     understand, only to forward via a real ssh subprocess.
   *   - DESTINATION side (this instance received the command over a REAL
   *     ssh hop that the source's own spawned `ssh` process made -- a
   *     separate, independent exec request executeCommand sees no
   *     differently than a real remote's sshd would): the command ends with
   *     ` _ '<destPath>' '<basename>'`. Only <destPath> is translated.
   * Any command matching neither shape (rsync's own commands, the version
   * probes, the reachability probe) runs completely unmodified. This fixture
   * never claims to speak rsync's server protocol, so an end-to-end rsync
   * backend run is only ever proven by the Linux-gated acceptance test
   * against a real rsync binary -- the non-gated suite instead proves the
   * real, honest "rsync not installed here" probe result.
   */
  private executeGenericShellCommand(channel: any, rawCommand: string): void {
    const sourceTarMatch = rawCommand.match(/^tar -cf - -C '([^']*)' -- /);
    const destInnerMatch = rawCommand.match(/ _ '([^']*)' '([^']*)'$/);
    let translated = rawCommand;
    if (sourceTarMatch) {
      const originalDir = sourceTarMatch[1];
      translated = translated.replace(
        `tar -cf - -C '${originalDir}' -- `,
        `tar -cf - -C '${this.toLocalPath(originalDir)}' -- `,
      );
    } else if (destInnerMatch) {
      const originalDestPath = destInnerMatch[1];
      translated = translated.replace(
        ` _ '${originalDestPath}' '`,
        ` _ '${this.toLocalPath(originalDestPath)}' '`,
      );
    }
    if (process.env.HANDFREE_REAL_SSH_TRACE === "1") {
      process.stderr.write(`[real-ssh ${this.port}] SHELL EXEC ${translated}\n`);
    }
    const finish = (code: number): void => {
      channel.exit(code);
      channel.end();
      channel.close();
    };
    const child = spawn("sh", ["-c", translated], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: this.directExecOptions.execEnv ?? process.env,
    });
    // Defensive 'error' listeners on every stream in this pipe chain: unlike
    // stdout/stderr, stdin is written FROM the (server-side) ssh2 exec
    // channel, whose underlying connection can be torn down abruptly by a
    // concurrent RealSshTestServer.stop() elsewhere in a test's `after()`
    // (this fixture routinely runs two independent real ssh2 servers, one
    // making real outbound connections to the other). stream.pipe() does
    // NOT forward 'error' events between the streams it connects, so an
    // unhandled EPIPE/ECONNRESET on either side would otherwise crash the
    // whole test process instead of just ending this one exec -- observed
    // for real while building this fixture (see this task's investigation
    // notes).
    channel.on("error", () => { /* connection torn down; nothing left to do */ });
    child.stdin.on("error", () => { /* peer already closed; nothing left to do */ });
    channel.pipe(child.stdin);
    child.stdout.pipe(channel, { end: false });
    child.stderr.pipe(channel.stderr, { end: false });
    child.once("error", (error) => {
      channel.stderr.write(`${error.message}\n`);
      finish(127);
    });
    child.once("close", (code) => {
      if (process.env.HANDFREE_REAL_SSH_TRACE === "1") {
        process.stderr.write(`[real-ssh ${this.port}] SHELL CLOSE code=${code}\n`);
      }
      finish(code ?? 1);
    });
  }
}
