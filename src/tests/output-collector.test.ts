import { describe, it } from "node:test";
import assert from "node:assert";
import { OutputCollector } from "../utils/output-collector.js";

describe("OutputCollector", () => {
  it("returns everything when total bytes are below the cap", () => {
    const c = new OutputCollector(64);
    c.push("hello");
    c.push(" world");
    const snap = c.getSnapshot();
    assert.strictEqual(snap.tail.toString("utf8"), "hello world");
    assert.strictEqual(snap.totalBytes, 11);
    assert.strictEqual(snap.droppedBytes, 0);
    assert.strictEqual(snap.truncated, false);
  });

  it("drops bytes from the head when total exceeds the cap", () => {
    const c = new OutputCollector(5);
    c.push("abcdef"); // 6 bytes -> drop 1 from head, keep "bcdef"
    const snap = c.getSnapshot();
    assert.strictEqual(snap.tail.toString("utf8"), "bcdef");
    assert.strictEqual(snap.totalBytes, 6);
    assert.strictEqual(snap.droppedBytes, 1);
    assert.strictEqual(snap.truncated, true);
  });

  it("keeps only the most recent bytes across multiple pushes", () => {
    const c = new OutputCollector(4);
    c.push("aaaa");
    c.push("bbbb");
    c.push("cccc"); // tail should be "cccc"
    const snap = c.getSnapshot();
    assert.strictEqual(snap.tail.toString("utf8"), "cccc");
    assert.strictEqual(snap.totalBytes, 12);
    assert.strictEqual(snap.droppedBytes, 8);
  });

  it("handles maxBytes=0 by dropping all input", () => {
    const c = new OutputCollector(0);
    c.push("hello");
    const snap = c.getSnapshot();
    assert.strictEqual(snap.tail.length, 0);
    assert.strictEqual(snap.totalBytes, 5);
    assert.strictEqual(snap.droppedBytes, 5);
    assert.strictEqual(snap.truncated, true);
  });

  it("trims a partial chunk at the head when overshoot < chunk length", () => {
    const c = new OutputCollector(3);
    c.push("abcde"); // 5 bytes, overshoot 2 -> keep "cde"
    const snap = c.getSnapshot();
    assert.strictEqual(snap.tail.toString("utf8"), "cde");
    assert.strictEqual(snap.droppedBytes, 2);
  });

  it("rejects negative or non-finite maxBytes", () => {
    assert.throws(() => new OutputCollector(-1), /non-negative/);
    assert.throws(() => new OutputCollector(Number.NaN), /non-negative/);
    assert.throws(() => new OutputCollector(Number.POSITIVE_INFINITY), /finite/);
  });

  it("ignores empty pushes", () => {
    const c = new OutputCollector(10);
    c.push("");
    c.push(Buffer.alloc(0));
    const snap = c.getSnapshot();
    assert.strictEqual(snap.totalBytes, 0);
    assert.strictEqual(snap.droppedBytes, 0);
    assert.strictEqual(snap.tail.length, 0);
  });

  it("accepts Buffers and strings interchangeably", () => {
    const c = new OutputCollector(20);
    c.push(Buffer.from([0x68, 0x69])); // "hi"
    c.push(" world");
    assert.strictEqual(c.getSnapshot().tail.toString("utf8"), "hi world");
  });
});
