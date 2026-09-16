import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as net from "node:net";
import { generateKeyPairSync } from "node:crypto";
import { spawn } from "node:child_process";
import ssh2 from "ssh2";
import { after, before, describe, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSHConnectionManager } from "../services/ssh-connection-manager.js";
import { registerTransferTool } from "../tools/transfer.js";
import {
  shellQuotePosix,
  buildDirectRsyncCommand,
  buildDirectTarSshCommand,
  classifyDirectProbeFailure,
  selectDirectBackend,
} from "../services/direct-transfer.js";
import { RealSshTestServer } from "./helpers/real-ssh-server.js";

/**
 * PLAN.MD P1-08a acceptance. Covers:
 *   - white-box: pure command builders (buildDirectRsyncCommand /
 *     buildDirectTarSshCommand), the probe-failure classifier, and backend
 *     selection -- exhaustive, no I/O.
 *   - grey-box + black-box: real RealSshTestServer fixtures (real ssh2
 *     servers, real SFTP) playing "source" and "destination", driven
 *     through the real `transfer` MCP tool over a real InMemoryTransport,
 *     with real local `ssh`/`tar` subprocesses actually executing the
 *     direct-transfer commands (see helpers/real-ssh-server.ts's generic
 *     shell-exec fallback). rsync itself is not installed on this dev
 *     machine (verified independently below rather than assumed), so the
 *     tar|ssh backend is what gets a real end-to-end run here; rsync's own
 *     end-to-end run is covered by direct-transfer-linux-pending.test.ts
 *     (gated, requires two real Linux hosts this suite is not allowed to
 *     provision).
 *
 * The single most important property this file proves for real: strategy=
 * "direct" makes the MCP host open ZERO real SFTP OPEN/READ requests on
 * either endpoint -- proven with the same real server-side counters
 * (RealSshServerStats.openedFiles / readRequests) transfer-real.test.ts
 * already uses for its own concurrency assertions, not client-side
 * bookkeeping. See "grey-box + black-box: strategy=direct ... zero SFTP".
 */

function responseText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = result.content as Array<{ type: string; text?: string }>;
  return content
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .filter((text): text is string => typeof text === "string")
    .join("\n");
}

function assertNoInsecureSshFlags(command: string): void {
  assert.doesNotMatch(command, /StrictHostKeyChecking=no/i, "must never disable host key checking");
  assert.doesNotMatch(command, /UserKnownHostsFile=\/dev\/null/i, "must never point known_hosts at /dev/null");
  assert.doesNotMatch(command, /CheckHostIP=no/i, "must never disable host IP checking");
  assert.doesNotMatch(command, /(^|\s)-i\s/, "must never pass an explicit identity file (no key material ever handled)");
  assert.match(command, /BatchMode=yes/, "must always set BatchMode=yes to fail fast instead of hanging on a prompt");
}

describe("direct-transfer: white-box pure functions", () => {
  test("shellQuotePosix: pinned exact output including the embedded-quote escape", () => {
    assert.equal(shellQuotePosix(""), "''");
    assert.equal(shellQuotePosix("abc"), "'abc'");
    assert.equal(shellQuotePosix("a b"), "'a b'");
    assert.equal(shellQuotePosix("it's"), "'it'\\''s'");
    assert.equal(shellQuotePosix("''"), "''\\'''\\'''");
  });

  test("buildDirectRsyncCommand: pinned exact output, no insecure flags, no identity flag", () => {
    const command = buildDirectRsyncCommand(
      "/src/dir with space",
      { user: "alice", host: "dest.example.com", port: 2222 },
      "/dst/target",
      { connectTimeoutSeconds: 6 },
    );
    assert.equal(
      command,
      "rsync -a -e 'ssh -o BatchMode=yes -o ConnectTimeout=6 -p 2222' -- '/src/dir with space' 'alice@dest.example.com:/dst/target'",
    );
    assertNoInsecureSshFlags(command);
  });

  test("buildDirectRsyncCommand: fractional/invalid timeout and port are rejected, not silently coerced into a broken command", () => {
    assert.throws(() => buildDirectRsyncCommand("/a", { user: "u", host: "h", port: 0 }, "/b", { connectTimeoutSeconds: 5 }));
    assert.throws(() => buildDirectRsyncCommand("/a", { user: "u", host: "h", port: 70000 }, "/b", { connectTimeoutSeconds: 5 }));
    assert.throws(() => buildDirectRsyncCommand("/a", { user: "u", host: "h", port: 22 }, "/b", { connectTimeoutSeconds: 0 }));
  });

  test("buildDirectTarSshCommand: pinned structure (keywords/order literal, quoting delegated to the already-pinned shellQuotePosix), no insecure flags, no identity flag", () => {
    const dest = { user: "alice", host: "dest.example.com", port: 2222 };
    const command = buildDirectTarSshCommand("/src/nested/file.bin", dest, "/dst/target/file.bin", { connectTimeoutSeconds: 6 });

    const remoteScript = 'set -e; d=$(mktemp -d); tar -xf - -C "$d"; mkdir -p "$(dirname "$1")"; mv -f "$d/$2" "$1"; rm -rf "$d"';
    const innerRemoteCommand = [
      "sh -c", shellQuotePosix(remoteScript), "_", shellQuotePosix("/dst/target/file.bin"), shellQuotePosix("file.bin"),
    ].join(" ");
    const expected = [
      "tar -cf - -C", shellQuotePosix("/src/nested"), "--", shellQuotePosix("file.bin"),
      "|", "ssh -o BatchMode=yes -o ConnectTimeout=6 -p 2222",
      "'alice'@'dest.example.com'",
      shellQuotePosix(innerRemoteCommand),
    ].join(" ");
    assert.equal(command, expected);
    assertNoInsecureSshFlags(command);
    // The remote-side script uses "$1"/"$2" positional parameters rather
    // than interpolating destPath/basename directly into script text --
    // pin that the actual path VALUES only ever appear as their own
    // separately-quoted trailing arguments, never spliced into the "set -e;
    // ..." script body itself.
    assert.doesNotMatch(command, /"\$\(dirname "\/dst/, "destPath must not be interpolated directly into the script body");
  });

  test("buildDirectTarSshCommand: a source/dest path containing a single quote is escaped, not injected raw -- verified with a real shell syntax check", async () => {
    const dest = { user: "alice", host: "dest.example.com", port: 22 };
    // Deliberately adversarial: if quoting were done naively (plain string
    // interpolation instead of shellQuotePosix), a single quote here would
    // break out of the surrounding quotes and inject live shell syntax --
    // e.g. a path like `/x' ; touch /tmp/pwned ; echo '` would stop being
    // inert text and become a real command.
    const maliciousSource = "/src/odd ' ; touch /tmp/handfree-pwned-marker ; echo ' name/file.bin";
    const maliciousDest = "/dst/odd ' ; touch /tmp/handfree-pwned-marker ; echo ' target/file.bin";
    const command = buildDirectTarSshCommand(maliciousSource, dest, maliciousDest, { connectTimeoutSeconds: 6 });
    assert.ok(command.includes("'\\''"), "expected the embedded-quote escape to appear for the malicious input's quotes");
    assertNoInsecureSshFlags(command);

    // Real proof, not just an escape-substring guess: hand the ACTUAL
    // constructed command to a real POSIX shell in syntax-check-only mode
    // (`-n`: parse but never execute). If quoting were broken, either the
    // parse would fail outright (unbalanced quotes), or -- unprovable by -n
    // alone, which is why the substring check above still matters -- the
    // injected text would have become live command boundaries instead of
    // one opaque quoted argument.
    const exitCode = await new Promise<number | null>((resolve) => {
      const child = spawn("sh", ["-n", "-c", command], { stdio: "ignore", windowsHide: true });
      child.once("error", () => resolve(null));
      child.once("close", (code) => resolve(code));
    });
    assert.equal(exitCode, 0, "the constructed command must be syntactically valid POSIX shell (sh -n)");
  });

  test("classifyDirectProbeFailure: real captured OpenSSH client stderr text is classified correctly", () => {
    // Captured for real from this machine's actual OpenSSH client (see this
    // task's investigation notes): `ssh -o BatchMode=yes -p <closed-port>
    // 127.0.0.1 true`, `ssh ... 10.255.255.1 true`, and
    // `ssh ... nosuchhost.invalid true`. Host-key/auth strings are the
    // well-known, version-stable OpenSSH message text.
    const cases: Array<{ description: string; exitCode: number | null; stderr: string; expectedCategory: string }> = [
      {
        description: "real: connection refused (closed local port)",
        exitCode: 255,
        stderr: "ssh: connect to host 127.0.0.1 port 65432: Connection refused\r\n",
        expectedCategory: "route",
      },
      {
        description: "real: connection timed out (unreachable IP)",
        exitCode: 255,
        stderr: "ssh: connect to host 10.255.255.1 port 22: Connection timed out\r\n",
        expectedCategory: "route",
      },
      {
        description: "real: could not resolve hostname",
        exitCode: 255,
        stderr: "ssh: Could not resolve hostname nosuchhost.invalid: Name or service not known\r\n",
        expectedCategory: "route",
      },
      {
        description: "well-known stable OpenSSH text: unknown host key, BatchMode blocks the prompt",
        exitCode: 255,
        stderr: "Host key verification failed.\r\n",
        expectedCategory: "hostKey",
      },
      {
        description: "well-known stable OpenSSH text: non-interactive auth exhausted",
        exitCode: 255,
        stderr: "alice@dest.example.com: Permission denied (publickey,password).\r\n",
        expectedCategory: "auth",
      },
      {
        description: "unrecognized text falls back to 'unknown', not silently misclassified as one of the others",
        exitCode: 1,
        stderr: "some other genuinely unexpected failure text\n",
        expectedCategory: "unknown",
      },
    ];
    for (const { description, exitCode, stderr, expectedCategory } of cases) {
      const result = classifyDirectProbeFailure(exitCode, stderr);
      assert.equal(result.category, expectedCategory, `${description}: got category ${result.category}`);
      assert.ok(result.reason.length > 0, `${description}: expected a non-empty human reason`);
    }
    // The NAT-traversal disclaimer is required text for the timeout case specifically.
    assert.match(
      classifyDirectProbeFailure(255, "ssh: connect to host 10.255.255.1 port 22: Connection timed out\r\n").reason,
      /NAT/,
    );
  });

  test("selectDirectBackend: exhaustive over all 8 capability combinations, rsync preferred over tar-ssh, ssh required for either", () => {
    const cases: Array<{ rsyncAvailable: boolean; sshAvailable: boolean; tarAvailable: boolean; expected: { ok: true; backend: "rsync" | "tar-ssh" } | { ok: false } }> = [
      { rsyncAvailable: true, sshAvailable: true, tarAvailable: true, expected: { ok: true, backend: "rsync" } },
      { rsyncAvailable: true, sshAvailable: true, tarAvailable: false, expected: { ok: true, backend: "rsync" } },
      { rsyncAvailable: false, sshAvailable: true, tarAvailable: true, expected: { ok: true, backend: "tar-ssh" } },
      { rsyncAvailable: false, sshAvailable: true, tarAvailable: false, expected: { ok: false } },
      { rsyncAvailable: true, sshAvailable: false, tarAvailable: true, expected: { ok: false } },
      { rsyncAvailable: true, sshAvailable: false, tarAvailable: false, expected: { ok: false } },
      { rsyncAvailable: false, sshAvailable: false, tarAvailable: true, expected: { ok: false } },
      { rsyncAvailable: false, sshAvailable: false, tarAvailable: false, expected: { ok: false } },
    ];
    for (const { expected, ...caps } of cases) {
      const result = selectDirectBackend(caps);
      assert.equal(result.ok, expected.ok, JSON.stringify(caps));
      if (expected.ok && result.ok) assert.equal(result.backend, expected.backend, JSON.stringify(caps));
      if (!expected.ok && !result.ok) assert.ok(result.reason.length > 0, JSON.stringify(caps));
    }
  });
});

async function findUnusedTcpPort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function commandReallyAvailable(binary: string, args: string[]): Promise<boolean> {
  return await new Promise((resolve) => {
    const child = spawn(binary, args, { stdio: "ignore", windowsHide: true });
    child.once("error", () => resolve(false));
    child.once("close", (code) => resolve(code === 0));
  });
}

describe("direct-transfer: real fixture acceptance (relay vs. direct, strategy=auto/direct)", { concurrency: false }, () => {
  const manager = SSHConnectionManager.getInstance();
  const transferService = manager.getTransferService();
  const suiteRoot = fs.mkdtempSync(path.join(os.tmpdir(), "handfree-direct-transfer-"));
  const sourceServerRoot = path.join(suiteRoot, "source-server");
  const sourceUntrustedRoot = path.join(suiteRoot, "source-untrusted-server");
  const sourceTrustedRoot = path.join(suiteRoot, "source-trusted-server");
  const destinationServerRoot = path.join(suiteRoot, "destination-server");
  const untrustedHome = path.join(suiteRoot, "home-untrusted");
  const trustedHome = path.join(suiteRoot, "home-trusted");

  // Stands in for "the key already present on the source server" --
  // generated once, written only into the throwaway trustedHome directory
  // below (never into this test process's real ~/.ssh, never transmitted
  // anywhere -- destination authenticates it via signature verification of
  // a real ssh handshake, not by receiving the private key).
  const { privateKey: clientPrivateKeyPem } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { format: "pem", type: "pkcs1" },
    publicKeyEncoding: { format: "pem", type: "pkcs1" },
  });
  // ssh2's own utils.parseKey cannot parse a PEM "RSA PUBLIC KEY"/"PUBLIC
  // KEY" block (verified for real -- see this task's investigation notes),
  // only PEM PRIVATE keys or the OpenSSH single-line format. Derive the
  // latter from the private key above, exactly as RealSshTestServer's own
  // authorizedPublicKeyOpenSsh option requires.
  const clientParsedKey = (ssh2.utils as any).parseKey(clientPrivateKeyPem);
  const clientPublicKeyOpenSsh = `${clientParsedKey.type} ${clientParsedKey.getPublicSSH().toString("base64")}`;

  const destinationServer = new RealSshTestServer(destinationServerRoot, 8, 0, 0, {
    authorizedPublicKeyOpenSsh: clientPublicKeyOpenSsh,
  });
  const sourceServer = new RealSshTestServer(sourceServerRoot);
  // HOME has no .ssh/known_hosts and no identity at all: every connection
  // this instance's spawned ssh makes to an unknown host must fail the
  // host-key check (BatchMode=yes blocks the interactive prompt).
  const sourceUntrustedServer = new RealSshTestServer(sourceUntrustedRoot, 8, 0, 0, {
    execEnv: { ...process.env, HOME: untrustedHome, USERPROFILE: untrustedHome },
  });
  // HOME has a real id_rsa (the keypair above) and a real known_hosts entry
  // for destinationServer's own real generated host key -- both pinned
  // ahead of time, never auto-accepted mid-connection.
  const sourceTrustedServer = new RealSshTestServer(sourceTrustedRoot, 8, 0, 0, {
    execEnv: { ...process.env, HOME: trustedHome, USERPROFILE: trustedHome },
  });

  const mcpServer = new McpServer({ name: "direct-transfer-test", version: "1.0.0" });
  const mcpClient = new Client({ name: "direct-transfer-test-client", version: "1.0.0" });

  before(async () => {
    fs.mkdirSync(path.join(untrustedHome, ".ssh"), { recursive: true });
    fs.mkdirSync(path.join(trustedHome, ".ssh"), { recursive: true });
    fs.writeFileSync(path.join(trustedHome, ".ssh", "id_rsa"), clientPrivateKeyPem, { mode: 0o600 });
    fs.chmodSync(path.join(trustedHome, ".ssh", "id_rsa"), 0o600);

    await Promise.all([
      sourceServer.start(),
      sourceUntrustedServer.start(),
      sourceTrustedServer.start(),
      destinationServer.start(),
    ]);

    // Written only after destinationServer.start() so the real port is known.
    fs.writeFileSync(
      path.join(trustedHome, ".ssh", "known_hosts"),
      destinationServer.knownHostsLine() + "\n",
      "utf8",
    );

    const unreachablePort = await findUnusedTcpPort();

    manager.setConfig(
      {
        source: { host: "127.0.0.1", port: sourceServer.port, username: "test", password: "test", disableSftpPathPolicy: true, keepaliveInterval: 0 },
        "source-untrusted": { host: "127.0.0.1", port: sourceUntrustedServer.port, username: "test", password: "test", disableSftpPathPolicy: true, keepaliveInterval: 0 },
        "source-trusted": { host: "127.0.0.1", port: sourceTrustedServer.port, username: "test", password: "test", disableSftpPathPolicy: true, keepaliveInterval: 0 },
        destination: { host: "127.0.0.1", port: destinationServer.port, username: "test", password: "test", disableSftpPathPolicy: true, keepaliveInterval: 0 },
        "destination-restricted": { host: "127.0.0.1", port: destinationServer.port, username: "test", password: "test", allowedRemoteDirectories: ["/allowed"], keepaliveInterval: 0 },
        "destination-unreachable": { host: "127.0.0.1", port: unreachablePort, username: "test", password: "test", disableSftpPathPolicy: true, keepaliveInterval: 0 },
      },
      ["source", "source-untrusted", "source-trusted", "destination", "destination-restricted", "destination-unreachable"],
    );
    registerTransferTool(mcpServer);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await mcpServer.connect(serverTransport);
    await mcpClient.connect(clientTransport);
  });

  after(async () => {
    manager.disconnect();
    await Promise.all([mcpClient.close(), mcpServer.close()]);
    await Promise.all([
      sourceServer.stop(),
      sourceUntrustedServer.stop(),
      sourceTrustedServer.stop(),
      destinationServer.stop(),
    ]);
    fs.rmSync(suiteRoot, { recursive: true, force: true });
    manager.setConfig({}, undefined);
  });

  test("black-box MCP: omitting strategy keeps relay's original success response text unchanged", async () => {
    const remoteInput = sourceServer.toLocalPath("/unchanged/input.txt");
    fs.mkdirSync(path.dirname(remoteInput), { recursive: true });
    fs.writeFileSync(remoteInput, "unchanged relay behavior\n", "utf8");
    fs.mkdirSync(destinationServer.toLocalPath("/unchanged"), { recursive: true });
    const result = await mcpClient.callTool({
      name: "transfer",
      arguments: {
        mode: "relay", sourceServer: "source", sourceRemotePath: "/unchanged/input.txt",
        destServer: "destination", destRemotePath: "/unchanged/output.txt",
        skipIfIdentical: false, timeout: 5000,
      },
    });
    assert.equal(result.isError, undefined, responseText(result));
    assert.match(responseText(result), /^Transfer complete \(windowed via SFTP, verified: size=\d+ bytes/);
  });

  test("grey-box: probeDirectTransfer detects backend availability for real (rsync presence/absence independently verified, not assumed)", async () => {
    const rsyncReallyAvailable = await commandReallyAvailable("rsync", ["--version"]);
    const report = await transferService.probeDirectTransfer("source", "destination", "/anything/out.txt", { timeout: 5000 });
    assert.equal(report.items.backendAvailable.ok, true, JSON.stringify(report.items.backendAvailable));
    assert.equal(report.items.backendAvailable.backend, rsyncReallyAvailable ? "rsync" : "tar-ssh");
  });

  test("black-box MCP: strategy=direct with a destination path outside allowedRemoteDirectories fails before any exec attempt on either side", async () => {
    const sourceExecBefore = sourceServer.stats.execCommandCount;
    const destExecBefore = destinationServer.stats.execCommandCount;
    const result = await mcpClient.callTool({
      name: "transfer",
      arguments: {
        mode: "relay", sourceServer: "source", sourceRemotePath: "/whatever/file.txt",
        destServer: "destination-restricted", destRemotePath: "/not-allowed/file.txt",
        strategy: "direct", timeout: 5000,
      },
    });
    assert.equal(result.isError, true);
    assert.match(responseText(result), /not inside any allowedRemoteDirectories|allowedRemoteDirectories/i);
    assert.equal(sourceServer.stats.execCommandCount, sourceExecBefore, "must not have attempted any exec on source");
    assert.equal(destinationServer.stats.execCommandCount, destExecBefore, "must not have attempted any exec on destination");
  });

  test("black-box MCP: strategy=direct fails explicitly (not silently) when the destination host key is not pinned on the source, and never claims to auto-accept it", async () => {
    const result = await mcpClient.callTool({
      name: "transfer",
      arguments: {
        mode: "relay", sourceServer: "source-untrusted", sourceRemotePath: "/anything/in.txt",
        destServer: "destination", destRemotePath: "/anything/out.txt",
        strategy: "direct", timeout: 8000,
      },
    });
    assert.equal(result.isError, true);
    const text = responseText(result);
    assert.match(text, /Direct transfer is not possible/);
    assert.match(text, /host key/i);
    assert.doesNotMatch(text, /StrictHostKeyChecking=no|UserKnownHostsFile=\/dev\/null/i);
  });

  test("black-box MCP: strategy=direct fails explicitly, without claiming NAT traversal, when the destination is genuinely unreachable from the source", async () => {
    const result = await mcpClient.callTool({
      name: "transfer",
      arguments: {
        mode: "relay", sourceServer: "source-trusted", sourceRemotePath: "/anything/in.txt",
        destServer: "destination-unreachable", destRemotePath: "/anything/out.txt",
        strategy: "direct", timeout: 8000,
      },
    });
    assert.equal(result.isError, true);
    const text = responseText(result);
    assert.match(text, /Direct transfer is not possible/);
    assert.match(text, /could not reach|refused|unreachable|timed out/i);
  });

  test("grey-box: strategy=auto falls back to relay with an accurate reason when the destination host key is unknown on the source, and the file still arrives correctly", async () => {
    const remoteInput = sourceUntrustedServer.toLocalPath("/auto-fallback/input.txt");
    fs.mkdirSync(path.dirname(remoteInput), { recursive: true });
    fs.writeFileSync(remoteInput, "auto fallback content\n", "utf8");
    fs.mkdirSync(destinationServer.toLocalPath("/auto-fallback"), { recursive: true });

    const result = await mcpClient.callTool({
      name: "transfer",
      arguments: {
        mode: "relay", sourceServer: "source-untrusted", sourceRemotePath: "/auto-fallback/input.txt",
        destServer: "destination", destRemotePath: "/auto-fallback/output.txt",
        strategy: "auto", skipIfIdentical: false, timeout: 8000,
      },
    });
    assert.equal(result.isError, undefined, responseText(result));
    const text = responseText(result);
    assert.match(text, /auto strategy: direct transfer not possible/);
    assert.match(text, /host key/i);
    assert.match(text, /fell back to relay/);
    assert.match(text, /Transfer complete \(windowed via SFTP/);
    assert.equal(
      fs.readFileSync(destinationServer.toLocalPath("/auto-fallback/output.txt"), "utf8"),
      "auto fallback content\n",
    );
  });

  test("grey-box + black-box: strategy=direct (tar-ssh) copies real bytes source->destination while the MCP host relays ZERO SFTP data, contrasted with strategy=relay which genuinely does use SFTP", async () => {
    const payload = Buffer.from("real direct-transfer payload -- deterministic content.\n".repeat(80), "utf8");
    const remoteInput = sourceTrustedServer.toLocalPath("/direct-copy/input.bin");
    fs.mkdirSync(path.dirname(remoteInput), { recursive: true });
    fs.writeFileSync(remoteInput, payload);
    fs.mkdirSync(destinationServer.toLocalPath("/direct-copy"), { recursive: true });

    const sourceOpenedBefore = sourceTrustedServer.stats.openedFiles;
    const destOpenedBefore = destinationServer.stats.openedFiles;
    const sourceReadsBefore = sourceTrustedServer.stats.readRequests.length;
    const destReadsBefore = destinationServer.stats.readRequests.length;

    const result = await mcpClient.callTool({
      name: "transfer",
      arguments: {
        mode: "relay", sourceServer: "source-trusted", sourceRemotePath: "/direct-copy/input.bin",
        destServer: "destination", destRemotePath: "/direct-copy/output.bin",
        strategy: "direct", timeout: 15000,
      },
    });
    assert.equal(result.isError, undefined, responseText(result));
    assert.match(responseText(result), /Direct transfer complete \(tar-ssh/);
    assert.match(responseText(result), /relayed no file data/);

    // Real bytes really landed on the destination's real disk, byte-identical.
    assert.deepEqual(fs.readFileSync(destinationServer.toLocalPath("/direct-copy/output.bin")), payload);

    // THE single most important assertion this whole delivery exists to
    // prove: zero real SFTP OPEN/READ requests on EITHER side during a
    // direct transfer -- from the servers' own real counters, not this
    // test's or the client's bookkeeping.
    assert.equal(sourceTrustedServer.stats.openedFiles, sourceOpenedBefore, "source: no real SFTP OPEN during a direct transfer");
    assert.equal(destinationServer.stats.openedFiles, destOpenedBefore, "destination: no real SFTP OPEN during a direct transfer");
    assert.equal(sourceTrustedServer.stats.readRequests.length, sourceReadsBefore, "source: no real SFTP READ during a direct transfer");
    assert.equal(destinationServer.stats.readRequests.length, destReadsBefore, "destination: no real SFTP READ during a direct transfer");

    // Contrast, in the same test, so the zero-delta assertions above are
    // proven to be a meaningful signal rather than a counter that simply
    // never moves: the SAME copy via the default (relay) strategy DOES open
    // a real SFTP file on the destination.
    const destOpenedBeforeRelay = destinationServer.stats.openedFiles;
    const relayResult = await mcpClient.callTool({
      name: "transfer",
      arguments: {
        mode: "relay", sourceServer: "source-trusted", sourceRemotePath: "/direct-copy/input.bin",
        destServer: "destination", destRemotePath: "/direct-copy/output-via-relay.bin",
        timeout: 15000,
      },
    });
    assert.equal(relayResult.isError, undefined, responseText(relayResult));
    assert.match(responseText(relayResult), /Transfer complete \(windowed via SFTP/);
    assert.ok(
      destinationServer.stats.openedFiles > destOpenedBeforeRelay,
      "relay strategy must open at least one real SFTP file on the destination -- the contrast this test depends on",
    );
    assert.deepEqual(fs.readFileSync(destinationServer.toLocalPath("/direct-copy/output-via-relay.bin")), payload);
  });

  test("grey-box: strategy=auto uses direct (tar-ssh) when it is genuinely possible, and reports it without an 'auto strategy: ... fell back' prefix", async () => {
    const remoteInput = sourceTrustedServer.toLocalPath("/auto-direct/input.txt");
    fs.mkdirSync(path.dirname(remoteInput), { recursive: true });
    fs.writeFileSync(remoteInput, "auto picks direct when possible\n", "utf8");
    fs.mkdirSync(destinationServer.toLocalPath("/auto-direct"), { recursive: true });

    const destOpenedBefore = destinationServer.stats.openedFiles;
    const result = await mcpClient.callTool({
      name: "transfer",
      arguments: {
        mode: "relay", sourceServer: "source-trusted", sourceRemotePath: "/auto-direct/input.txt",
        destServer: "destination", destRemotePath: "/auto-direct/output.txt",
        strategy: "auto", timeout: 15000,
      },
    });
    assert.equal(result.isError, undefined, responseText(result));
    const text = responseText(result);
    assert.doesNotMatch(text, /fell back to relay/);
    assert.match(text, /Direct transfer complete \(tar-ssh/);
    assert.equal(destinationServer.stats.openedFiles, destOpenedBefore, "auto's direct path must not touch SFTP either");
    assert.equal(
      fs.readFileSync(destinationServer.toLocalPath("/auto-direct/output.txt"), "utf8"),
      "auto picks direct when possible\n",
    );
  });
});
