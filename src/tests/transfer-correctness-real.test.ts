import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, test } from "node:test";
import * as v8 from "node:v8";
import * as vm from "node:vm";
import { SSHConnectionManager } from "../services/ssh-connection-manager.js";
import { RunService } from "../run/run-service.js";
import { findRemoteCollectFiles } from "../run/collect-glob.js";
import { ToolError } from "../utils/tool-error.js";
import { RealSshTestServer } from "./helpers/real-ssh-server.js";

/**
 * PLAN.MD P1-06c transfer correctness and performance, T1-T11. Every test runs
 * against a real in-process ssh2/SFTP/exec server with real files: no mocked
 * SFTP, no stubbed client, no patched internals. The assertions are on wire
 * truth the server itself observed (READ/WRITE requests, in-flight peaks,
 * SFTP channel opens, exec command lines).
 *
 * T12 (server-side copy-data) cannot run here: the fixture's ssh2 SFTP server
 * cannot advertise extensions, so it lives in transfer-copy-data-linux-pending.
 */

const EMPTY_MD5 = "d41d8cd98f00b204e9800998ecf8427e";

// A real GC for the memory measurement below, without a node flag on the
// whole test command.
v8.setFlagsFromString("--expose_gc");
const gc = vm.runInNewContext("gc") as () => void;

function md5(data: Buffer): string {
  return createHash("md5").update(data).digest("hex");
}

describe("P1-06c transfer correctness against a real ssh2 server", { concurrency: false }, () => {
  const manager = SSHConnectionManager.getInstance();
  const service = manager.getTransferService();
  const suiteRoot = fs.mkdtempSync(path.join(os.tmpdir(), "handfree-p106c-"));
  const localRoot = path.join(suiteRoot, "local");

  // One server per concern, so peaks, counters and the per-server hash command
  // cache of one test can never leak into another.
  const servers = {
    slowRead: new RealSshTestServer(path.join(suiteRoot, "slow-read"), 8, 0, 20), // T1
    skip: new RealSshTestServer(path.join(suiteRoot, "skip")), // T2, T3, T6, T10
    cache: new RealSshTestServer(path.join(suiteRoot, "cache")), // T5
    noHash: new RealSshTestServer(path.join(suiteRoot, "no-hash")), // T4
    tree: new RealSshTestServer(path.join(suiteRoot, "tree")), // T7, T8
    collect: new RealSshTestServer(path.join(suiteRoot, "collect")), // T9
    relay: new RealSshTestServer(path.join(suiteRoot, "relay")), // T11
    conn: new RealSshTestServer(path.join(suiteRoot, "conn")), // connection handling, stalls, skip basics
    slowWrite: new RealSshTestServer(path.join(suiteRoot, "slow-write"), 100), // progress keeps the watchdog alive
    instant: new RealSshTestServer(path.join(suiteRoot, "instant"), 0), // no artificial WRITE delay
    sessions: new RealSshTestServer(path.join(suiteRoot, "sessions")), // section 6 R1: in-flight files vs SFTP channels
  };

  const write = (server: RealSshTestServer, remotePath: string, data: Buffer | string): void => {
    const target = server.toLocalPath(remotePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
  };
  const writeLocal = (name: string, data: Buffer | string): string => {
    const target = path.join(localRoot, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
    return target;
  };
  const hashCommandLines = (server: RealSshTestServer): string[] =>
    server.stats.execCommands.filter((line) => /^md5sum '/.test(line));
  const emptyInputProbes = (server: RealSshTestServer): string[] =>
    server.stats.execCommands.filter((line) => line.trim() === "md5sum");

  /** Wait until the server's open SFTP channel count settles at `target`. */
  const waitForIdle = async (server: RealSshTestServer, target = server.stats.activeSftpChannels): Promise<void> => {
    const deadline = Date.now() + 3_000;
    while (server.stats.activeSftpChannels > target && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };

  before(async () => {
    fs.mkdirSync(localRoot, { recursive: true });
    await Promise.all(Object.values(servers).map((server) => server.start()));
    // Aliases are extra config names for the `skip` server: a different name
    // is a different server identity, so its hash-command cache starts empty.
    const targets: Record<string, RealSshTestServer> = {
      ...servers,
      concurrentFirst: servers.skip,
      probeFresh: servers.skip,
      copyProbe: servers.relay, // section 6 R3: fresh copy-data capability caches
      copyProbe2: servers.relay,
      copyProbe3: servers.relay,
    };
    manager.setConfig(
      Object.fromEntries(
        Object.entries(targets).map(([name, server]) => [
          name,
          {
            host: "127.0.0.1",
            port: server.port,
            username: "test",
            password: "test",
            disableSftpPathPolicy: true,
            keepaliveInterval: 0,
          },
        ]),
      ),
      Object.keys(targets),
    );
    servers.noHash.setHashCommandsAvailable(false);
    servers.sessions.setOpenResponseDelayMs(20);
  });

  after(async () => {
    manager.disconnect();
    await Promise.all(Object.values(servers).map((server) => server.stop()));
    fs.rmSync(suiteRoot, { recursive: true, force: true });
    manager.setConfig({}, undefined);
  });

  describe("T1 pipelined by default at the service layer", () => {
    test("download without `fast` keeps more than one READ in flight", async () => {
      const data = randomBytes(2 * 1024 * 1024);
      write(servers.slowRead, "/t1-down.bin", data);
      const localPath = path.join(localRoot, "t1-down.bin");
      servers.slowRead.resetIoPeaks();
      servers.slowRead.resetReadLog();

      const message = await service.download("/t1-down.bin", localPath, "slowRead", {});

      assert.equal(md5(fs.readFileSync(localPath)), md5(data));
      assert.ok(servers.slowRead.stats.maxActiveReads > 1, `READ peak was ${servers.slowRead.stats.maxActiveReads}`);
      assert.match(message, /fast SFTP/);
    });

    test("upload without `fast` keeps more than one WRITE in flight", async () => {
      const data = randomBytes(2 * 1024 * 1024);
      const localPath = writeLocal("t1-up.bin", data);
      servers.slowRead.resetIoPeaks();

      const message = await service.upload(localPath, "/t1-up.bin", "slowRead", { skipIfIdentical: false });

      assert.equal(md5(fs.readFileSync(servers.slowRead.toLocalPath("/t1-up.bin"))), md5(data));
      assert.ok(servers.slowRead.stats.maxActiveWrites > 1, `WRITE peak was ${servers.slowRead.stats.maxActiveWrites}`);
      assert.match(message, /fast SFTP/);
    });

    test("fast:false stays a serial compatibility mode (one WRITE at a time)", async () => {
      const data = randomBytes(512 * 1024);
      const localPath = writeLocal("t1-serial.bin", data);
      servers.slowRead.resetIoPeaks();

      const message = await service.upload(localPath, "/t1-serial.bin", "slowRead", { fast: false, skipIfIdentical: false });

      assert.equal(md5(fs.readFileSync(servers.slowRead.toLocalPath("/t1-serial.bin"))), md5(data));
      assert.doesNotMatch(message, /fast SFTP/);
      assert.equal(servers.slowRead.stats.maxActiveWrites, 1);
    });
  });

  describe("T2/T3 skip-if-identical never reads the remote file over SFTP", () => {
    test("T2: same size, different content: zero READ, one remote hash, content replaced", async () => {
      const remote = randomBytes(300_000);
      const local = Buffer.from(remote);
      local[1234] ^= 0xff;
      write(servers.skip, "/t2.bin", remote);
      const localPath = writeLocal("t2.bin", local);
      servers.skip.resetReadLog();
      servers.skip.resetExecLog();

      const message = await service.upload(localPath, "/t2.bin", "skip", {});

      assert.match(message, /File uploaded successfully/);
      assert.equal(servers.skip.stats.readRequests.length, 0, "the remote file must not be read over SFTP");
      assert.equal(hashCommandLines(servers.skip).length, 1, servers.skip.stats.execCommands.join(" | "));
      assert.equal(md5(fs.readFileSync(servers.skip.toLocalPath("/t2.bin"))), md5(local));
    });

    test("T2b: a small buffered (fast:false) upload takes the same remote-hash path", async () => {
      const remote = Buffer.from("remote-content-AAAA");
      const local = Buffer.from("remote-content-BBBB");
      write(servers.skip, "/t2b.txt", remote);
      const localPath = writeLocal("t2b.txt", local);
      servers.skip.resetReadLog();

      await service.upload(localPath, "/t2b.txt", "skip", { fast: false });

      assert.equal(servers.skip.stats.readRequests.length, 0);
      assert.equal(fs.readFileSync(servers.skip.toLocalPath("/t2b.txt"), "utf8"), "remote-content-BBBB");
    });

    test("T3: remote already identical: zero READ, zero WRITE, reported as skipped", async () => {
      const data = randomBytes(300_000);
      write(servers.skip, "/t3.bin", data);
      const localPath = writeLocal("t3.bin", data);
      servers.skip.resetReadLog();
      servers.skip.resetWriteLog();

      const message = await service.upload(localPath, "/t3.bin", "skip", {});

      assert.match(message, /^Upload skipped:/);
      assert.equal(servers.skip.stats.readRequests.length, 0);
      assert.equal(servers.skip.stats.writeRequests.length, 0);
    });

    test("T3b: the multi-connection upload shares the same decision (identical: zero READ and WRITE)", async () => {
      const data = randomBytes(300_000);
      write(servers.skip, "/t3b.bin", data);
      const localPath = writeLocal("t3b.bin", data);
      servers.skip.resetReadLog();
      servers.skip.resetWriteLog();

      const message = await service.upload(localPath, "/t3b.bin", "skip", { connections: 2 });

      assert.match(message, /^Upload skipped:/);
      assert.equal(servers.skip.stats.readRequests.length, 0);
      assert.equal(servers.skip.stats.writeRequests.length, 0);
    });

    test("T3c: skipIfIdentical:false does not compare at all", async () => {
      const data = randomBytes(10_000);
      write(servers.skip, "/t3c.bin", data);
      const localPath = writeLocal("t3c.bin", data);
      servers.skip.resetExecLog();
      servers.skip.resetWriteLog();

      const message = await service.upload(localPath, "/t3c.bin", "skip", { skipIfIdentical: false });

      assert.match(message, /File uploaded successfully/);
      assert.equal(servers.skip.stats.execCommands.length, 0);
      assert.ok(servers.skip.stats.writeRequests.length > 0);
    });
  });

  describe("T4 no usable remote hash command", () => {
    test("uploads without reading the remote file; the reason is remote-hash-unavailable", async () => {
      const remote = randomBytes(200_000);
      const local = Buffer.from(remote); // same size AND same content: only the missing hash command forces a re-upload
      write(servers.noHash, "/t4.bin", remote);
      const localPath = writeLocal("t4.bin", local);
      servers.noHash.resetReadLog();
      servers.noHash.resetWriteLog();

      const message = await service.upload(localPath, "/t4.bin", "noHash", { vvv: true });

      assert.match(message, /File uploaded successfully/);
      assert.match(message, /remote-hash-unavailable/);
      assert.equal(servers.noHash.stats.readRequests.length, 0, "never fall back to reading the remote file");
      assert.ok(servers.noHash.stats.writeRequests.length > 0);
    });

    test("the negative detection result is cached too (candidates probed once)", async () => {
      const localPath = writeLocal("t4-again.bin", randomBytes(5_000));
      write(servers.noHash, "/t4-again.bin", randomBytes(5_000));
      servers.noHash.resetExecLog();

      await service.upload(localPath, "/t4-again.bin", "noHash", {});
      const afterFirst = servers.noHash.stats.execCommands.length;
      await service.upload(localPath, "/t4-again.bin", "noHash", {});

      assert.ok(afterFirst <= 3, `at most the three candidates are probed once: ${servers.noHash.stats.execCommands.join(" | ")}`);
      assert.equal(servers.noHash.stats.execCommands.length, afterFirst, "the second comparison must not probe again");
    });
  });

  describe("T5/T6 remote hash command detection", () => {
    test("T5: the empty-input probe runs once per server, not once per comparison", async () => {
      write(servers.cache, "/t5.bin", Buffer.from("remote-aaaaaaaa"));
      const first = writeLocal("t5-a.bin", "local-bbbbbbbbbb".slice(0, 15));
      servers.cache.resetExecLog();

      await service.upload(first, "/t5.bin", "cache", {});
      write(servers.cache, "/t5.bin", Buffer.from("remote-cccccccc"));
      await service.upload(first, "/t5.bin", "cache", {});

      assert.equal(emptyInputProbes(servers.cache).length, 1, servers.cache.stats.execCommands.join(" | "));
      assert.equal(hashCommandLines(servers.cache).length, 2);
    });

    test("T5b: concurrent first detections share one probe", async () => {
      const server = servers.skip;
      const paths = [0, 1, 2, 3].map((index) => {
        write(server, `/t5b-${index}.bin`, Buffer.from(`remote-${index}-xxxx`));
        return writeLocal(`t5b-${index}.bin`, `local-${index}--xxxx`.slice(0, `remote-${index}-xxxx`.length));
      });
      server.resetExecLog();

      await Promise.all(paths.map((localPath, index) => service.upload(localPath, `/t5b-${index}.bin`, "concurrentFirst", {})));

      assert.equal(emptyInputProbes(server).length, 1, server.stats.execCommands.join(" | "));
    });

    test("T6: the empty-input probe completes (stdin is closed) and the real hash ran afterwards", async () => {
      write(servers.skip, "/t6.bin", Buffer.from("remote-t6-AAAA"));
      const localPath = writeLocal("t6.bin", "remote-t6-BBBB");
      servers.skip.resetExecLog();
      const startedAt = Date.now();

      await service.upload(localPath, "/t6.bin", "probeFresh", { vvv: true });

      assert.ok(Date.now() - startedAt < 5_000, "probe must not wait for its timeout");
      assert.equal(emptyInputProbes(servers.skip).length, 1);
      assert.equal(hashCommandLines(servers.skip).length, 1, "detection succeeded, so the file hash must have run");
    });

    test("T6b: execOnClient delivers stdin EOF right after the channel opens", async () => {
      const acquired = await (service as any).pool.acquireSshClient("skip", { reuseConnection: true, purpose: "command" });
      const startedAt = Date.now();
      const result = await (service as any).execOnClient(acquired.client, "md5sum", 3_000);
      acquired.close();

      assert.equal(result.code, 0);
      assert.equal(result.stdout.trim().split(/\s+/)[0], EMPTY_MD5);
      assert.ok(Date.now() - startedAt < 2_500);
    });
  });

  describe("T10 CRLF: skip means the remote already equals the bytes we would write", () => {
    test("local CRLF, remote already LF: skipped", async () => {
      write(servers.skip, "/t10-a.sh", "echo one\necho two\n");
      const localPath = writeLocal("t10-a.sh", "echo one\r\necho two\r\n");
      servers.skip.resetWriteLog();

      const message = await service.upload(localPath, "/t10-a.sh", "skip", {});

      assert.match(message, /^Upload skipped:/);
      assert.equal(servers.skip.stats.writeRequests.length, 0);
    });

    test("remote CRLF, local LF: re-uploaded, the remote becomes LF", async () => {
      write(servers.skip, "/t10-b.sh", "echo one\r\necho two\r\n");
      const localPath = writeLocal("t10-b.sh", "echo one\necho two\n");

      const message = await service.upload(localPath, "/t10-b.sh", "skip", {});

      assert.match(message, /File uploaded successfully/);
      assert.equal(fs.readFileSync(servers.skip.toLocalPath("/t10-b.sh"), "utf8"), "echo one\necho two\n");
    });

    test("remote CRLF, local CRLF: re-uploaded as LF and reported as CRLF-fixed", async () => {
      write(servers.skip, "/t10-c.sh", "echo one\r\necho two\r\n");
      const localPath = writeLocal("t10-c.sh", "echo one\r\necho two\r\n");

      const message = await service.upload(localPath, "/t10-c.sh", "skip", {});

      assert.match(message, /CRLF→LF auto-fix/);
      assert.equal(fs.readFileSync(servers.skip.toLocalPath("/t10-c.sh"), "utf8"), "echo one\necho two\n");
    });
  });

  describe("T7/T8 recursive transfers reuse SFTP sessions", () => {
    const FILE_COUNT = 24;
    const fileRel = (index: number): string => `d${index % 4}/sub/f${String(index).padStart(2, "0")}.txt`;
    const contentOf = (index: number): string => `content of file ${index}\n`.repeat(20 + index);

    test("T7: uploadDirectory of 24 small files at fileConcurrency=4 opens at most 4 + a constant of SFTP channels", async () => {
      const localDir = path.join(localRoot, "t7-tree");
      for (let index = 0; index < FILE_COUNT; index += 1) writeLocal(path.join("t7-tree", fileRel(index)), contentOf(index));
      servers.tree.resetSftpChannelOpenCount();
      servers.tree.resetChannelPeak();

      const uploaded = await service.uploadDirectory(localDir, "/t7-out", "tree", { fileConcurrency: 4 });

      assert.equal(uploaded.length, FILE_COUNT);
      for (let index = 0; index < FILE_COUNT; index += 1) {
        assert.equal(fs.readFileSync(servers.tree.toLocalPath(`/t7-out/${fileRel(index)}`), "utf8"), contentOf(index));
      }
      const opened = servers.tree.stats.sftpChannelOpenCount;
      assert.ok(opened <= 4 + 2, `opened ${opened} SFTP channels for ${FILE_COUNT} files`);
      assert.ok(servers.tree.stats.maxActiveSftpChannels <= 4 + 1, `peak ${servers.tree.stats.maxActiveSftpChannels}`);
    });

    test("T7b: re-uploading the same tree skips every file with no WRITE", async () => {
      const localDir = path.join(localRoot, "t7-tree");
      servers.tree.resetWriteLog();

      await service.uploadDirectory(localDir, "/t7-out", "tree", { fileConcurrency: 4 });

      assert.equal(servers.tree.stats.writeRequests.length, 0);
    });

    test("T7c: reuseConnection:false uses ONE one-shot connection for the whole call", async () => {
      const localDir = path.join(localRoot, "t7-tree");
      servers.tree.resetConnectionCount();

      await service.uploadDirectory(localDir, "/t7-fresh", "tree", { fileConcurrency: 4, reuseConnection: false });

      assert.equal(servers.tree.stats.connectionCount, 1);
      assert.equal(fs.readFileSync(servers.tree.toLocalPath(`/t7-fresh/${fileRel(5)}`), "utf8"), contentOf(5));
    });

    test("T8: downloadDirectory lists through one session and downloads with at most 4 workers", async () => {
      for (let index = 0; index < FILE_COUNT; index += 1) write(servers.tree, `/t8-src/${fileRel(index)}`, contentOf(index));
      const localDir = path.join(localRoot, "t8-dest");
      servers.tree.resetSftpChannelOpenCount();

      const downloaded = await service.downloadDirectory("/t8-src", localDir, "tree", { fileConcurrency: 4 });

      assert.equal(downloaded.length, FILE_COUNT);
      for (let index = 0; index < FILE_COUNT; index += 1) {
        assert.equal(fs.readFileSync(path.join(localDir, ...fileRel(index).split("/")), "utf8"), contentOf(index));
      }
      const opened = servers.tree.stats.sftpChannelOpenCount;
      assert.ok(opened <= 4 + 2, `opened ${opened} SFTP channels for ${FILE_COUNT} files`);
    });
  });

  describe("T9 collect pulls artifacts through a bounded set of sessions", () => {
    const runService = RunService.getInstance() as any;
    const artifactCount = 12;
    const artifactRel = (index: number): string => `out/a${String(index).padStart(2, "0")}.json`;

    test("many artifacts: correct bytes and a bounded SFTP channel count", async () => {
      for (let index = 0; index < artifactCount; index += 1) write(servers.collect, `/proj/${artifactRel(index)}`, `{"n":${index}}`.repeat(10 + index));
      const localDir = path.join(localRoot, "t9-ok");
      // The glob enumeration (readdir + one stat session per match, in
      // collect-glob.ts) is a separate phase this change does not touch:
      // measure it alone, so the download phase is the difference.
      servers.collect.resetSftpChannelOpenCount();
      await findRemoteCollectFiles("collect", "/proj", ["out/*.json"]);
      const enumerationChannels = servers.collect.stats.sftpChannelOpenCount;
      servers.collect.resetSftpChannelOpenCount();

      const result = await runService.runCollect("collect", "/proj", localDir, ["out/*.json"], 1_000_000, 100);

      assert.equal(result.status, "completed", JSON.stringify(result));
      assert.equal(result.files.length, artifactCount);
      for (let index = 0; index < artifactCount; index += 1) {
        assert.equal(fs.readFileSync(path.join(localDir, ...artifactRel(index).split("/")), "utf8"), `{"n":${index}}`.repeat(10 + index));
      }
      const downloadChannels = servers.collect.stats.sftpChannelOpenCount - enumerationChannels;
      assert.ok(downloadChannels <= 4, `the download phase opened ${downloadChannels} SFTP channels for ${artifactCount} artifacts`);
    });

    test("a failing artifact: status failed, and the 'already pulled' list is exactly what is on disk", async () => {
      const localDir = path.join(localRoot, "t9-fail");
      // A directory squatting on one artifact's local path makes exactly that download fail.
      fs.mkdirSync(path.join(localDir, "out", "a05.json"), { recursive: true });

      const result = await runService.runCollect("collect", "/proj", localDir, ["out/*.json"], 1_000_000, 100);

      assert.equal(result.status, "failed");
      assert.match(result.reason, /download failed for 'out\/a05\.json'/);
      const reportedNames: string[] = result.files.map((file: { localPath: string }) => path.basename(file.localPath));
      assert.ok(!reportedNames.includes("a05.json"));
      const onDisk = fs
        .readdirSync(path.join(localDir, "out"), { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name)
        .sort();
      assert.deepEqual([...reportedNames].sort(), onDisk);
      assert.match(result.reason, new RegExp(`Already pulled ${result.files.length} file\\(s\\)`));
      for (const file of result.files as Array<{ localPath: string; remotePath: string }>) {
        assert.equal(fs.readFileSync(file.localPath, "utf8"), fs.readFileSync(servers.collect.toLocalPath(file.remotePath), "utf8"));
      }
    });

    test("downloadFiles reports per-file outcomes without throwing for a failing file", async () => {
      const dest = path.join(localRoot, "t9-pairs");
      fs.mkdirSync(path.join(dest, "blocked.json"), { recursive: true });
      const pairs = [
        { remotePath: "/proj/out/a00.json", localPath: path.join(dest, "a00.json") },
        { remotePath: "/proj/out/a01.json", localPath: path.join(dest, "blocked.json") },
      ];

      const result = await (service as any).downloadFiles(pairs, "collect", { fileConcurrency: 1 });

      assert.deepEqual(result.results.map((entry: { status: string }) => entry.status), ["downloaded", "failed"]);
      assert.ok(result.results[1].reason);
    });
  });

  describe("T11 same-server relay without copy-data falls back to the client-side relay", () => {
    test("result is correct and the debug output says why", async () => {
      const data = randomBytes(700_001);
      write(servers.relay, "/t11-src.bin", data);

      const message = await service.transferBetweenServers("relay", "/t11-src.bin", "relay", "/t11-dst.bin", { vvv: true });

      assert.equal(md5(fs.readFileSync(servers.relay.toLocalPath("/t11-dst.bin"))), md5(data));
      assert.match(message, /windowed via SFTP/);
      assert.match(message, /copy-data/);
      assert.match(message, /not advertised/);
    });

    test("strategy=relay with connections>1 on the same server also falls back and stays correct", async () => {
      const data = randomBytes(300_000);
      write(servers.relay, "/t11b-src.bin", data);

      const message = await service.transferBetweenServers("relay", "/t11b-src.bin", "relay", "/t11b-dst.bin", { connections: 2 });

      assert.equal(md5(fs.readFileSync(servers.relay.toLocalPath("/t11b-dst.bin"))), md5(data));
      assert.match(message, /independent connection pair/);
    });
  });
  // The behaviors below used to be covered by mock-based tests that replaced
  // TransferService internals (openSftp, sftpReadBuffer, sftpWriteBuffer, ...)
  // in command-validation.test.ts. They run against the real server instead.

  describe("connection handling", () => {
    const waitForLiveConnections = async (server: RealSshTestServer, expected: number): Promise<void> => {
      const deadline = Date.now() + 3_000;
      while (server.liveConnectionCount !== expected && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    };

    test("the default reuses one cached SSH connection across transfers", async () => {
      manager.disconnect();
      const localPath = writeLocal("conn-reuse.txt", "payload");
      servers.conn.resetConnectionCount();

      await service.upload(localPath, "/conn-reuse-1.txt", "conn", {});
      await service.upload(localPath, "/conn-reuse-2.txt", "conn", { fast: false });
      await service.download("/conn-reuse-1.txt", path.join(localRoot, "conn-reuse-down.txt"), "conn", {});

      assert.equal(servers.conn.stats.connectionCount, 1);
    });

    test("reuseConnection:false uses one one-shot connection and closes it afterwards", async () => {
      await waitForLiveConnections(servers.conn, 1);
      const cachedConnections = servers.conn.liveConnectionCount;
      const localPath = writeLocal("conn-fresh.txt", "payload");
      servers.conn.resetConnectionCount();

      const message = await service.upload(localPath, "/conn-fresh.txt", "conn", { reuseConnection: false, vvv: true });

      assert.match(message, /File uploaded successfully/);
      assert.match(message, /\[SSH DEBUG\]/);
      assert.equal(servers.conn.stats.connectionCount, 1);
      await waitForLiveConnections(servers.conn, cachedConnections);
      assert.equal(servers.conn.liveConnectionCount, cachedConnections, "the one-shot connection must be closed");
    });

    test("same-server relay over the cached connection opens no extra connection, and skips an identical copy", async () => {
      write(servers.conn, "/self-src.bin", randomBytes(100_000));
      servers.conn.resetConnectionCount();
      servers.conn.resetWriteLog();

      const first = await service.transferBetweenServers("conn", "/self-src.bin", "conn", "/self-dst.bin", {});
      const writesAfterFirst = servers.conn.stats.writeRequests.length;
      const second = await service.transferBetweenServers("conn", "/self-src.bin", "conn", "/self-dst.bin", {});

      assert.match(first, /Transfer complete/);
      assert.match(second, /Transfer skipped/);
      assert.ok(writesAfterFirst > 0);
      assert.equal(servers.conn.stats.writeRequests.length, writesAfterFirst, "the identical copy must not write");
      assert.equal(servers.conn.stats.connectionCount, 0, "the cached connection is reused");
    });

    test("a failed normal download leaves the connection usable for the next transfer", async () => {
      const data = randomBytes(200_000);
      write(servers.conn, "/dl-fail.bin", data);
      const localPath = path.join(localRoot, "dl-fail.bin");
      servers.conn.resetReadLog();
      servers.conn.injectReadFailureAfter(0);

      await assert.rejects(
        () => service.download("/dl-fail.bin", localPath, "conn", { fast: false }),
        (error: unknown) => error instanceof ToolError && error.code === "SFTP_ERROR",
      );
      servers.conn.clearReadFailureInjection();

      await service.download("/dl-fail.bin", localPath, "conn", { fast: false });
      assert.equal(md5(fs.readFileSync(localPath)), md5(data));
    });

    // Bounded: a request on a session of the closed client never gets a reply,
    // so without the reopen this would hang rather than fail.
    test("a worker whose session sits on a replaced client reopens on the new client instead of hanging", { timeout: 10_000 }, async () => {
      // What one worker's connection error does to every other worker: the
      // scope closes the cached client, and the pool hands out a new one. A
      // worker still holding a session on the old client must notice and
      // reopen.
      write(servers.conn, "/scope-a.txt", "a");
      const scope = (service as any).openTransferScope("conn", {}, undefined);
      const stat = (sftp: unknown, remotePath: string) => (service as any).sftpStat(sftp, remotePath, "dest");
      try {
        const before = await scope.run(1, async (client: unknown, sftp: unknown) => ({ client, size: (await stat(sftp, "/scope-a.txt")).size }));
        (service as any).pool.closeClient("conn", true);

        const after = await scope.run(1, async (client: unknown, sftp: unknown) => ({ client, size: (await stat(sftp, "/scope-a.txt")).size }));

        assert.equal(after.size, 1);
        assert.notEqual(after.client, before.client, "the task ran on the new client");
      } finally {
        await scope.close();
      }
    });

    test("a refused SFTP session open is not cached: the next file on that session opens a new one", async () => {
      // The server refusing the subsystem (as at its MaxSessions limit): the
      // session slot caches the open, so a failed open has to be dropped, or
      // every later file mapped to that session would fail with it. openSftp
      // reports it as a connection error, which is what discards the slot.
      // With reuseConnection:false the one-shot client is never replaced, so
      // only that discard clears the slot; the cached-client case is also
      // covered by the replaced-client check above.
      write(servers.conn, "/scope-b.txt", "bb");
      const stat = (sftp: unknown, remotePath: string) => (service as any).sftpStat(sftp, remotePath, "dest");
      for (const reuseConnection of [true, false]) {
        const scope = (service as any).openTransferScope("conn", { reuseConnection }, undefined, 1);
        try {
          servers.conn.rejectNextSftpRequests = 1;
          await assert.rejects(() => scope.run(0, async (_client: unknown, sftp: unknown) => stat(sftp, "/scope-b.txt")));

          const size = (await scope.run(0, async (_client: unknown, sftp: unknown) => stat(sftp, "/scope-b.txt"))).size;

          assert.equal(size, 2, `reuseConnection=${reuseConnection}`);
        } finally {
          servers.conn.rejectNextSftpRequests = 0;
          await scope.close();
        }
      }
    });
  });

  describe("inactivity watchdog on the pipelined path", () => {
    test("a peer that stops acknowledging WRITEs fails with a retriable stall error, then recovers", async () => {
      const localPath = writeLocal("stall.bin", randomBytes(300_000));
      servers.conn.setStallWrites(true);
      const startedAt = Date.now();
      try {
        await assert.rejects(
          () => service.upload(localPath, "/stall.bin", "conn", { timeout: 400, skipIfIdentical: false }),
          (error: unknown) =>
            error instanceof ToolError &&
            error.code === "SSH_CONNECTION_FAILED" &&
            error.retriable === true &&
            /stall|no progress/i.test(error.message),
        );
        assert.ok(Date.now() - startedAt < 5_000, "must abort quickly, not hang");
      } finally {
        servers.conn.setStallWrites(false);
      }

      const message = await service.upload(localPath, "/stall.bin", "conn", { timeout: 4_000, skipIfIdentical: false });
      assert.match(message, /File uploaded successfully/);
    });

    test("the stall fires only after the full window of silence, measured from the last progress", async () => {
      // Progress 900 ms in, then 3500 ms of silence, against a 4000 ms window:
      // never 4000 ms without progress, so it must complete (500 ms of slack
      // for timer overshoot under load). A watchdog that measures from its
      // last re-arm and skips re-arming within a quarter window (the earlier
      // implementation) ignores the 900 ms progress and fires at 4000 ms,
      // 400 ms before the second progress.
      const watchdog = (service as any).runWithInactivityTimeout.bind(service);
      const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

      const result = await watchdog(async (onProgress: () => void) => {
        await sleep(900);
        onProgress();
        await sleep(3_500);
        onProgress();
        return "done";
      }, 4_000, "precision probe");

      assert.equal(result, "done");
      await assert.rejects(
        () => watchdog(() => new Promise(() => {}), 300, "silent probe"),
        /silent probe stalled: no progress for 300ms/,
      );
    });

    test("a slow but steadily acknowledging peer is never killed by a short inactivity window", async () => {
      // Acks every 100 ms against a 3 s window: 30x headroom, so only a
      // watchdog that ignores progress can kill it -- not a busy event loop.
      // 4 x 32 KiB per 100 ms makes 5 MiB take ~4 s, longer than the window.
      const data = randomBytes(5 * 1024 * 1024);
      const localPath = writeLocal("slow-steady.bin", data);
      const startedAt = Date.now();

      const message = await service.upload(localPath, "/slow-steady.bin", "slowWrite", {
        timeout: 3_000,
        sftpConcurrency: 4,
        skipIfIdentical: false,
      });

      assert.match(message, /File uploaded successfully/);
      assert.ok(Date.now() - startedAt > 3_000, "the transfer must outlast the inactivity window for this test to mean anything");
      assert.equal(md5(fs.readFileSync(servers.slowWrite.toLocalPath("/slow-steady.bin"))), md5(data));
    });
  });

  describe("fast transfer options reach ssh2 fastPut", () => {
    test("chunkSize and sftpConcurrency bound the WRITE sizes and the in-flight WRITEs the server sees", async () => {
      const localPath = writeLocal("opts.bin", randomBytes(1024 * 1024));
      servers.conn.resetWriteLog();
      servers.conn.resetIoPeaks();

      await service.upload(localPath, "/opts.bin", "conn", { chunkSize: 8_192, sftpConcurrency: 2, skipIfIdentical: false });

      const lengths = servers.conn.stats.writeRequests.map((request) => request.length);
      assert.ok(lengths.length >= 128);
      assert.equal(Math.max(...lengths), 8_192);
      assert.ok(servers.conn.stats.maxActiveWrites <= 2, `peak ${servers.conn.stats.maxActiveWrites}`);
    });

    test("invalid options are rejected without leaving an SFTP channel open", async () => {
      const localPath = writeLocal("bad-opts.bin", "x");
      await waitForIdle(servers.conn);
      const before = servers.conn.stats.activeSftpChannels;

      await assert.rejects(
        () => service.upload(localPath, "/bad-opts.bin", "conn", { sftpConcurrency: -1, skipIfIdentical: false }),
        (error: unknown) => error instanceof ToolError && error.code === "INVALID_CONFIGURATION",
      );

      await waitForIdle(servers.conn, before);
      assert.equal(servers.conn.stats.activeSftpChannels, before);
    });
  });

  describe("a default fast upload does not preload the local file", () => {
    test("live buffer memory stays flat for a large non-script file; a shell script (read for the CRLF fix) holds it", async () => {
      const size = 32 * 1024 * 1024;
      const peakGrowth = async (localName: string, remote: string): Promise<number> => {
        const localPath = writeLocal(localName, Buffer.alloc(size, 7));
        // Leave the allocation's stack frame before collecting the fixture
        // buffer; otherwise it can remain a conservative stack root here.
        await new Promise<void>((resolve) => setImmediate(resolve));
        // Collect first: garbage left by earlier tests (and the buffer just
        // written) would otherwise sit in the baseline and could be freed
        // mid-measurement, hiding real growth.
        gc();
        const baseline = process.memoryUsage().arrayBuffers;
        let peak = 0;
        const sample = (): void => {
          // Measure retained buffers, not dead SSH/network packets waiting
          // for a GC cycle. Their collection timing varies with runner load.
          // Sample the synchronous source preparation below as well, so even
          // a buffer released before the first timer tick is detected.
          gc();
          peak = Math.max(peak, process.memoryUsage().arrayBuffers - baseline);
        };
        const sampler = setInterval(sample, 10);
        try {
          const upload = service.upload(localPath, remote, "instant", { skipIfIdentical: false });
          sample();
          await upload;
        } finally {
          clearInterval(sampler);
        }
        sample();
        return peak;
      };

      // Both go through fastPut; only the shell script is also read into memory.
      const script = await peakGrowth("preload.sh", "/preload.sh");
      const data = await peakGrowth("preload.bin", "/preload.bin");

      assert.ok(script >= size * 0.9, `the control (a shell script is read for the CRLF fix) must hold the payload, saw ${script}`);
      assert.ok(data < size / 2, `default fast upload of a non-script file grew array buffers by ${data} bytes`);
    });
  });

  describe("skip decision basics", () => {
    test("a missing remote file is uploaded without any hash command", async () => {
      const localPath = writeLocal("basic-missing.txt", "payload");
      servers.conn.resetExecLog();

      const message = await service.upload(localPath, "/basic-missing.txt", "conn", {});

      assert.match(message, /File uploaded successfully/);
      assert.deepEqual(hashCommandLines(servers.conn), []);
      assert.equal(fs.readFileSync(servers.conn.toLocalPath("/basic-missing.txt"), "utf8"), "payload");
    });

    test("a different size is uploaded without any hash command", async () => {
      write(servers.conn, "/basic-size.txt", "much longer remote content");
      const localPath = writeLocal("basic-size.txt", "short");
      servers.conn.resetExecLog();

      const message = await service.upload(localPath, "/basic-size.txt", "conn", {});

      assert.match(message, /File uploaded successfully/);
      assert.deepEqual(hashCommandLines(servers.conn), []);
      assert.equal(fs.readFileSync(servers.conn.toLocalPath("/basic-size.txt"), "utf8"), "short");
    });

    test("a non-script file that differs only by CRLF is re-uploaded byte for byte (no CRLF fix)", async () => {
      write(servers.conn, "/basic-crlf.txt", "a\r\nb\r\n");
      const localPath = writeLocal("basic-crlf.txt", "a\nb\nc");

      const message = await service.upload(localPath, "/basic-crlf.txt", "conn", {});

      assert.match(message, /File uploaded successfully/);
      assert.doesNotMatch(message, /CRLF/);
      assert.equal(fs.readFileSync(servers.conn.toLocalPath("/basic-crlf.txt"), "utf8"), "a\nb\nc");
    });

    test("a CRLF shell script is reported as fixed and lands as LF", async () => {
      const localPath = writeLocal("basic-fix.sh", "#!/bin/sh\r\necho hi\r\n");

      const message = await service.upload(localPath, "/basic-fix.sh", "conn", {});

      assert.match(message, /CRLF.{0,3}LF auto-fix/);
      assert.match(message, /converted 2 line endings/);
      assert.equal(fs.readFileSync(servers.conn.toLocalPath("/basic-fix.sh"), "utf8"), "#!/bin/sh\necho hi\n");
    });

    test("uploading a directory path as a file is rejected before any connection opens", async () => {
      manager.disconnect();
      servers.conn.resetConnectionCount();

      await assert.rejects(
        () => service.upload(localRoot, "/whatever", "conn", {}),
        (error: unknown) => error instanceof ToolError && error.code === "LOCAL_FILE_READ_FAILED" && /not a regular file/i.test(error.message),
      );

      assert.equal(servers.conn.stats.connectionCount, 0);
    });
  });

  describe("recursive upload creates the directory tree", () => {
    test("existing directories are tolerated and the full path is created", async () => {
      fs.mkdirSync(servers.tree.toLocalPath("/mk/a"), { recursive: true });
      const localDir = path.join(localRoot, "mk-src");
      writeLocal(path.join("mk-src", "x.txt"), "x");
      writeLocal(path.join("mk-src", "deep", "er", "y.txt"), "y");

      const uploaded = await service.uploadDirectory(localDir, "/mk/a/b/c", "tree", {});

      assert.deepEqual([...uploaded].sort(), ["/mk/a/b/c/deep/er/y.txt", "/mk/a/b/c/x.txt"]);
      assert.equal(fs.readFileSync(servers.tree.toLocalPath("/mk/a/b/c/deep/er/y.txt"), "utf8"), "y");
    });
  });
  describe("vvv debug output for multi-file calls", () => {
    test("batch upload with onError=continue: a failing file's reason carries its [SSH DEBUG] block", async () => {
      const good = writeLocal(path.join("dbg-batch", "good.txt"), "good");
      const bad = writeLocal(path.join("dbg-batch", "bad.txt"), "bad");
      // A directory squatting on the target path makes exactly that upload fail.
      fs.mkdirSync(servers.tree.toLocalPath("/dbg-batch-out/bad.txt"), { recursive: true });

      const result = await service.uploadBatch([good, bad], "/dbg-batch-out", "tree", { vvv: true, onError: "continue", fileConcurrency: 1 });

      assert.equal(result.results.find((r) => r.localPath === good)!.status, "uploaded");
      const failed = result.results.find((r) => r.localPath === bad)!;
      assert.equal(failed.status, "failed");
      assert.match(failed.reason ?? "", /\[SSH DEBUG\]/);
    });

    test("uploadDirectory and downloadFiles errors carry the debug block too", async () => {
      const dir = path.join(localRoot, "dbg-dir");
      writeLocal(path.join("dbg-dir", "x.txt"), "x");
      fs.mkdirSync(servers.tree.toLocalPath("/dbg-dir-out/x.txt"), { recursive: true });
      await assert.rejects(
        () => service.uploadDirectory(dir, "/dbg-dir-out", "tree", { vvv: true }),
        (error: unknown) => error instanceof Error && /\[SSH DEBUG\]/.test(error.message),
      );

      write(servers.tree, "/dbg-dl/a.txt", "a");
      const blocked = path.join(localRoot, "dbg-dl-blocked");
      fs.mkdirSync(blocked, { recursive: true });
      const { results } = await (service as any).downloadFiles(
        [{ remotePath: "/dbg-dl/a.txt", localPath: blocked }], "tree", { vvv: true });
      assert.equal(results[0].status, "failed");
      assert.match(results[0].reason, /\[SSH DEBUG\]/);
    });
  });
  describe("section 6 R1: files in flight are decoupled from SFTP channels", () => {
    const FILES = 48;
    const rel = (index: number): string => `d${index % 6}/f${String(index).padStart(2, "0")}.txt`;
    const content = (index: number): string => `r1 file ${index}\n`.repeat(10 + index);

    test("uploadDirectory at fileConcurrency=16 uses at most 4 SFTP channels but more than 4 OPENs in flight", async () => {
      const localDir = path.join(localRoot, "r1-up");
      for (let index = 0; index < FILES; index += 1) writeLocal(path.join("r1-up", rel(index)), content(index));
      servers.sessions.resetSftpChannelOpenCount();
      servers.sessions.resetIoPeaks();

      const uploaded = await service.uploadDirectory(localDir, "/r1-up-out", "sessions", { fileConcurrency: 16 });

      assert.equal(uploaded.length, FILES);
      for (let index = 0; index < FILES; index += 1) {
        assert.equal(fs.readFileSync(servers.sessions.toLocalPath(`/r1-up-out/${rel(index)}`), "utf8"), content(index));
      }
      assert.ok(servers.sessions.stats.sftpChannelOpenCount <= 4, `opened ${servers.sessions.stats.sftpChannelOpenCount} SFTP channels`);
      assert.ok(servers.sessions.stats.maxActiveOpens > 4, `OPEN peak was ${servers.sessions.stats.maxActiveOpens}`);
    });

    test("downloadDirectory at fileConcurrency=16 uses at most 4 SFTP channels but more than 4 OPENs in flight", async () => {
      for (let index = 0; index < FILES; index += 1) write(servers.sessions, `/r1-down/${rel(index)}`, content(index));
      const localDir = path.join(localRoot, "r1-down");
      servers.sessions.resetSftpChannelOpenCount();
      servers.sessions.resetIoPeaks();

      const downloaded = await service.downloadDirectory("/r1-down", localDir, "sessions", { fileConcurrency: 16 });

      assert.equal(downloaded.length, FILES);
      for (let index = 0; index < FILES; index += 1) {
        assert.equal(fs.readFileSync(path.join(localDir, ...rel(index).split("/")), "utf8"), content(index));
      }
      assert.ok(servers.sessions.stats.sftpChannelOpenCount <= 4, `opened ${servers.sessions.stats.sftpChannelOpenCount} SFTP channels`);
      assert.ok(servers.sessions.stats.maxActiveOpens > 4, `OPEN peak was ${servers.sessions.stats.maxActiveOpens}`);
    });

    test("fileConcurrency above 64 is rejected before any remote work", async () => {
      await assert.rejects(
        () => service.uploadDirectory(localRoot, "/r1-too-many", "sessions", { fileConcurrency: 65 }),
        (error: unknown) => error instanceof ToolError && error.code === "INVALID_CONFIGURATION" && /64/.test(error.message),
      );
      assert.equal(fs.existsSync(servers.sessions.toLocalPath("/r1-too-many")), false);
    });

    test("one file's SFTP status error neither discards the shared session nor affects the other files", async () => {
      const items = Array.from({ length: 24 }, (_, index) => writeLocal(path.join("r1-batch", `b${String(index).padStart(2, "0")}.txt`), `batch ${index}`));
      // A directory squatting on one target makes exactly that upload fail with a plain SFTP status error.
      fs.mkdirSync(servers.sessions.toLocalPath("/r1-batch-out/b07.txt"), { recursive: true });
      servers.sessions.resetSftpChannelOpenCount();

      const result = await service.uploadBatch(items, "/r1-batch-out", "sessions", { onError: "continue", fileConcurrency: 8 });

      assert.equal(result.failedCount, 1);
      assert.equal(result.uploadedCount, 23);
      assert.ok(servers.sessions.stats.sftpChannelOpenCount <= 4, `opened ${servers.sessions.stats.sftpChannelOpenCount} SFTP channels (a status error must not force a reopen)`);
    });

    test("a connection-level failure still discards the session and the batch recovers", async () => {
      const items = Array.from({ length: 12 }, (_, index) => writeLocal(path.join("r1-drop", `c${String(index).padStart(2, "0")}.txt`), `drop ${index}`));
      await service.uploadBatch(items.slice(0, 1), "/r1-drop-out", "sessions", {});
      servers.sessions.resetConnectionCount();
      servers.sessions.dropAllConnections();
      await new Promise((resolve) => setTimeout(resolve, 100));

      const first = await service.uploadBatch(items, "/r1-drop-out", "sessions", { onError: "continue", fileConcurrency: 4 });
      const second = await service.uploadBatch(items, "/r1-drop-out", "sessions", { onError: "continue", fileConcurrency: 4, skipIfIdentical: false });

      assert.equal(second.failedCount, 0, JSON.stringify(second.results.filter((r) => r.status === "failed")));
      assert.ok(first.uploadedCount + first.skippedCount > 0);
      assert.ok(servers.sessions.stats.connectionCount >= 1, "a new connection was opened");
      for (let index = 0; index < items.length; index += 1) {
        assert.equal(fs.readFileSync(servers.sessions.toLocalPath(`/r1-drop-out/c${String(index).padStart(2, "0")}.txt`), "utf8"), `drop ${index}`);
      }
    });
  });

  describe("section 6 R2: collect enumeration uses the READDIR attributes", () => {
    test("no STAT/LSTAT request is made, sizes are right, directories are not collected", async () => {
      for (let index = 0; index < 6; index += 1) write(servers.collect, `/r2/out/f${index}.json`, "x".repeat(10 + index));
      fs.mkdirSync(servers.collect.toLocalPath("/r2/out/dir.json"), { recursive: true });
      servers.collect.resetRequestCounts();

      const matches = await findRemoteCollectFiles("collect", "/r2", ["out/*.json"]);

      assert.deepEqual(matches.map((match) => [match.relativePath, match.bytes]), Array.from({ length: 6 }, (_, index) => [`out/f${index}.json`, 10 + index]));
      assert.equal(servers.collect.stats.requestCounts.STAT ?? 0, 0);
      assert.equal(servers.collect.stats.requestCounts.LSTAT ?? 0, 0);
    });

    test("a matching entry that is not a regular file (a FIFO) is not collected", async () => {
      write(servers.collect, "/r2b/out/real.json", "{}");
      write(servers.collect, "/r2b/out/pipe.json", "");
      servers.collect.presentAsFifo("/r2b/out/pipe.json");

      const matches = await findRemoteCollectFiles("collect", "/r2b", ["out/*.json"]);

      assert.deepEqual(matches.map((match) => match.relativePath), ["out/real.json"]);
    });
  });

  describe("section 6 R3: copy-data capability is cached per server", () => {
    test("the second same-server relay opens no SFTP channel for the probe", async () => {
      write(servers.relay, "/r3-src.bin", randomBytes(50_000));
      servers.relay.resetSftpChannelOpenCount();
      await service.transferBetweenServers("copyProbe", "/r3-src.bin", "copyProbe", "/r3-dst-1.bin", {});
      const first = servers.relay.stats.sftpChannelOpenCount;
      servers.relay.resetSftpChannelOpenCount();

      const message = await service.transferBetweenServers("copyProbe", "/r3-src.bin", "copyProbe", "/r3-dst-2.bin", { vvv: true });

      assert.match(message, /windowed via SFTP/);
      assert.match(message, /not advertised/);
      assert.equal(servers.relay.stats.sftpChannelOpenCount, first - 1, "the relay's own source+dest channels only");
    });

    test("concurrent first relays share one probe", async () => {
      write(servers.relay, "/r3-src2.bin", randomBytes(20_000));
      servers.relay.resetSftpChannelOpenCount();

      await Promise.all([1, 2, 3].map((n) =>
        service.transferBetweenServers("copyProbe2", "/r3-src2.bin", "copyProbe2", `/r3-dst2-${n}.bin`, {})));

      // 3 relays x (source + dest) channels + exactly one probe channel.
      assert.equal(servers.relay.stats.sftpChannelOpenCount, 3 * 2 + 1);
    });

    test("a probe that fails to run is not cached: the next same-server relay probes again and succeeds", async () => {
      const data = randomBytes(30_000);
      write(servers.relay, "/r3-src3.bin", data);
      servers.relay.rejectNextSftpRequests = 1; // the probe's session open
      try {
        await assert.rejects(() => service.transferBetweenServers("copyProbe3", "/r3-src3.bin", "copyProbe3", "/r3-dst3.bin", {}));
      } finally {
        servers.relay.rejectNextSftpRequests = 0;
      }

      const message = await service.transferBetweenServers("copyProbe3", "/r3-src3.bin", "copyProbe3", "/r3-dst3.bin", {});

      assert.match(message, /Transfer complete/);
      assert.equal(md5(fs.readFileSync(servers.relay.toLocalPath("/r3-dst3.bin"))), md5(data));
    });
  });
});
