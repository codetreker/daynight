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

test.each(["invalid JSON", "oversized frame", "close", "stdout end", "dispose"])("native RPC synchronously revokes consumers once on %s", async failure => {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough() });
  const revoke = vi.fn();
  const rpc = new NativeRpc(child, () => {}, 200, revoke);
  const pending = rpc.request("hooks/list", {});
  const rejected = expect(pending).rejects.toBeInstanceOf(Error);
  if (failure === "invalid JSON") child.stdout.write("not JSON\n");
  else if (failure === "oversized frame") child.stdout.write(" ".repeat(16 * 1024 * 1024 + 1) + "\n");
  else if (failure === "close") child.emit("close");
  else if (failure === "stdout end") child.stdout.emit("end");
  else rpc.dispose();
  expect(revoke).toHaveBeenCalledTimes(1);
  await rejected;
  child.emit("close"); rpc.dispose();
  expect(revoke).toHaveBeenCalledTimes(1);
  await expect(rpc.request("hooks/list", {})).rejects.toThrow("closed");
});

test("a failed native revocation callback still settles every pending request", async () => {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough() });
  const rpc = new NativeRpc(child, () => {}, 200, () => { throw new Error("consumer failed"); });
  const first = expect(rpc.request("hooks/list", {})).rejects.toThrow("Invalid native protocol");
  const second = expect(rpc.request("thread/read", {})).rejects.toThrow("Invalid native protocol");
  expect(() => child.stdout.write("invalid\n")).not.toThrow();
  await Promise.all([first, second]); rpc.dispose();
});
