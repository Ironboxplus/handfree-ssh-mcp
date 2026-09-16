import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { describePrivateKeyReadFailure } from "../connection/ssh-connection-pool.js";

/**
 * Regression test for a real secret leak observed while running the P2 Linux
 * acceptance against the shared .88 lab host.
 *
 * `privateKey` in this project's config is always a filesystem PATH -- every
 * call site does `fs.readFileSync(config.privateKey)`. Pasting the key itself
 * into that field is an easy misconfiguration (several other SSH tools do
 * accept inline key material there). When that happens, Node's ENOENT message
 * contains the value it tried to open -- the entire private key -- and the
 * connection pool used to interpolate that message straight into a ToolError.
 * The key then reaches the logs and the tool response returned to the caller.
 *
 * This was not hypothetical: it printed a real ed25519 private key to the
 * terminal during acceptance.
 */
describe("private key read failure is reported without echoing key material", () => {
  // Structurally shaped like a real OpenSSH key, but the body is obviously
  // fake so this file never contains anything resembling a usable secret.
  const FAKE_KEY = [
    "-----BEGIN OPENSSH PRIVATE KEY-----",
    "bm90LWEtcmVhbC1rZXktanVzdC10ZXN0LWZpbGxlcg==",
    "-----END OPENSSH PRIVATE KEY-----",
  ].join("\n");

  test("inline key material is never echoed back", () => {
    const enoent = new Error(`ENOENT: no such file or directory, open '${FAKE_KEY}'`);
    const message = describePrivateKeyReadFailure(FAKE_KEY, enoent);

    assert.ok(
      !message.includes("bm90LWEtcmVhbC1rZXktanVzdC10ZXN0LWZpbGxlcg=="),
      "the key body must not appear in the error message",
    );
    assert.ok(!message.includes("BEGIN OPENSSH PRIVATE KEY"), "the PEM header must not appear either");
    assert.match(message, /must be a filesystem path/);
  });

  test("other PEM key flavors are caught too, not just OpenSSH", () => {
    for (const header of [
      "-----BEGIN RSA PRIVATE KEY-----",
      "-----BEGIN EC PRIVATE KEY-----",
      "-----BEGIN DSA PRIVATE KEY-----",
      "-----BEGIN PRIVATE KEY-----",
      "-----BEGIN ENCRYPTED PRIVATE KEY-----",
    ]) {
      const value = `${header}\nc2VjcmV0LWJvZHk=\n`;
      const message = describePrivateKeyReadFailure(value, new Error(`ENOENT: open '${value}'`));
      assert.ok(
        !message.includes("c2VjcmV0LWJvZHk="),
        `key body leaked for ${header}`,
      );
    }
  });

  test("an ordinary missing path is still reported verbatim, so real errors stay debuggable", () => {
    const enoent = new Error("ENOENT: no such file or directory, open '/home/arc/.ssh/id_ed25519'");
    const message = describePrivateKeyReadFailure("/home/arc/.ssh/id_ed25519", enoent);

    // Redaction must not swallow the ordinary case: a user with a genuine typo
    // in their key path needs to see which path failed.
    assert.equal(message, enoent.message);
    assert.match(message, /id_ed25519/);
  });

  test("a path that merely mentions 'key' is not mistaken for key material", () => {
    const enoent = new Error("ENOENT: no such file or directory, open '/keys/private-key-backup'");
    const message = describePrivateKeyReadFailure("/keys/private-key-backup", enoent);
    assert.equal(message, enoent.message);
  });
});
