import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { expect, test, vi } from "vitest";
import { NativeRpc, NativeRpcError } from "../../../src/commands/controller/providers/native-rpc.js";

test("private native RPC separates notifications, approval requests and exact response IDs", async () => {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  const messages: unknown[] = []; let wire = "";
  child.stdin.on("data", chunk => { wire += chunk.toString(); });
  const rpc = new NativeRpc(child, (message) => messages.push(message), 200);
  const result = rpc.request("thread/start", { cwd: "/work" });
  const sent = JSON.parse(wire);
  child.stdout.write(JSON.stringify({ method: "thread/started", params: { threadId: "native" } }) + "\n");
  child.stdout.write(JSON.stringify({ id: 501, method: "item/commandExecution/requestApproval", params: {} }) + "\n");
  child.stdout.write(JSON.stringify({ id: sent.id, result: { thread: { id: "native" } } }) + "\n");
  await expect(result).resolves.toEqual({ thread: { id: "native" } });
  expect(messages).toHaveLength(2);
  rpc.respond(501, { decision: "decline" });
  expect(wire).toContain('"decision":"decline"');
  rpc.dispose();
});

test("native rejection is distinguishable from uncertain transport loss and all pending calls settle", async () => {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  let wire = ""; child.stdin.on("data", chunk => { wire += chunk.toString(); });
  const rpc = new NativeRpc(child, () => {}, 200);
  const rejected = rpc.request("turn/start", {});
  const sent = JSON.parse(wire);
  child.stdout.write(JSON.stringify({ id: sent.id, error: { code: -32602, message: "stale turn" } }) + "\n");
  await expect(rejected).rejects.toBeInstanceOf(NativeRpcError);
  const lost = rpc.request("turn/start", {});
  child.emit("close", 1, null);
  await expect(lost).rejects.toThrow("closed");
  rpc.dispose();
});


test("the default initialization deadline remains pending until 30000 ms then retains an unknown typed outcome", async () => {
  vi.useFakeTimers();
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough() });
  const rpc = new NativeRpc(child, () => {});
  let settled = false;
  const result = rpc.request("initialize", {}).finally(() => { settled = true; });
  const rejected = expect(result).rejects.toMatchObject({ name: "NativeRpcTimeoutError", method: "initialize" });
  try {
    await vi.advanceTimersByTimeAsync(29_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    expect(settled).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  } finally { rpc.dispose(); vi.useRealTimers(); }
});
