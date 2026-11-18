import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mock, test } from "node:test";
import { captureProcessEvidence, observeProcessStat, stopEvidenceGroup } from "../src/process-evidence.ts";

const stat = (group: string, state = "X", name = "worker"): string => {
  const fields = Array<string>(50).fill("0");
  fields[0] = state; fields[2] = group; fields[19] = "123456";
  return `42 (${name}) ${fields.join(" ")}\n`;
};

test("stat parsing preserves fields after unusual process names", async () => {
  assert.deepEqual(await observeProcessStat(async () => stat("42", "S", "a) b\nc")), { state: "S", group: 42, start: "123456" });
});

test("unavailable process group is reobserved before accepting absence or identity", async () => {
  let reads = 0;
  assert.equal(await observeProcessStat(async () => {
    if (++reads === 1) return stat("-1");
    throw Object.assign(new Error("gone"), { code: "ENOENT" });
  }), null);
  assert.equal(reads, 2);

  reads = 0;
  assert.deepEqual(await observeProcessStat(async () => ++reads === 1 ? stat("-1", "R") : stat("42", "S")), { state: "S", group: 42, start: "123456" });
  assert.equal(reads, 2);
});

test("persistent unavailable or malformed identity fails closed", async () => {
  let reads = 0;
  await assert.rejects(observeProcessStat(async () => { reads++; return stat("-1"); }), /group identity is unavailable/);
  assert.equal(reads, 5);
  for (const line of [stat("-2"), stat("-1").replace("123456", "bad"), stat("-1", "?"), stat("-1").replace("X 0 -1", "X corrupt -1"), stat("-1").replace("X 0 -1 0 0 0 0", "X 0 -1 0 0 0 -100"), stat("-1").split(" ").slice(0, 22).join(" "), "invalid"]) {
    reads = 0;
    await assert.rejects(observeProcessStat(async () => { reads++; return line; }), /identity is malformed/);
    assert.equal(reads, 1);
  }
});

test("an expired scan cannot signal the original process group", async () => {
  const child = spawn(process.execPath, ["-e", "console.log('ready');setInterval(() => {}, 1000)"], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
  const exited = once(child, "exit");
  try {
    await once(child.stdout, "data");
    const proof = await captureProcessEvidence(child.pid!);
    let checks = 0;
    const clock = mock.method(Date, "now", () => ++checks === 1 ? 0 : 100);
    try { await assert.rejects(stopEvidenceGroup(proof, [], 50), /exceeded its deadline/); }
    finally { clock.mock.restore(); }
    assert.doesNotThrow(() => process.kill(child.pid!, 0));
  } finally {
    if (child.exitCode === null && child.signalCode === null) process.kill(-child.pid!, "SIGKILL");
    await exited;
  }
});
