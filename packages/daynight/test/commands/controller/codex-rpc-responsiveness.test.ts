import { EventEmitter, once } from "node:events";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createConnection, createServer } from "node:net";
import { PassThrough, Readable } from "node:stream";
import { setImmediate as nextIo } from "node:timers/promises";
import { afterEach, expect, test, vi } from "vitest";
import { CodexRpc } from "../../../src/commands/controller/providers/codex-rpc.js";
import { CodexJsonDecoder } from "../../../src/commands/controller/providers/codex-rpc-json.js";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
const noSpool = () => { throw new Error("This input must not create media."); };
const transport = (stdout = new PassThrough()) => Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout });
const notification = (index: number) => JSON.stringify({ method: "notice", params: { index } }) + "\n";
const socketPair = async () => {
  const server = createServer(); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const accepted = once(server, "connection"), address = server.address();
  if (address === null || typeof address === "string") throw new Error("Missing TCP address.");
  const client = createConnection(address.port, "127.0.0.1");
  const [[peer]] = await Promise.all([accepted, once(client, "connect")]);
  return { client, peer: peer as import("node:net").Socket, close: async () => {
    client.destroy(); (peer as import("node:net").Socket).destroy();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  } };
};

test.each(["one chunk", "many chunks"])("ready socket I/O runs before ordered notifications exhaust %s", async mode => {
  const sockets = await socketPair(), count = 40, delivered: number[] = [];
  const lines = Array.from({ length: count }, (_, index) => Buffer.from(notification(index)));
  const stdout = Readable.from(mode === "one chunk" ? [Buffer.concat(lines)] : lines, { objectMode: true });
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout });
  const ready = Promise.withResolvers<number>(), complete = Promise.withResolvers<void>();
  sockets.client.once("data", () => ready.resolve(delivered.length));
  const rpc = new CodexRpc(child, message => {
    delivered.push((message.params as { index: number }).index);
    if (delivered.length === 1) sockets.peer.write("ready");
    if (delivered.length === count) complete.resolve();
  }, { createSpool: noSpool });
  try {
    const observed = await ready.promise;
    expect(observed).toBeGreaterThan(0); expect(observed).toBeLessThan(count);
    await complete.promise; expect(delivered).toEqual(Array.from({ length: count }, (_, index) => index));
  } finally { rpc.dispose(); await rpc.stopped; await sockets.close(); }
});

test("bounded partial-frame slices give ready socket I/O a turn and preserve split UTF-8", async () => {
  const sockets = await socketPair(), child = transport();
  const input = Buffer.from(JSON.stringify({ method: "notice", params: { value: "中文😀".repeat(30) } }) + "\n");
  const ready = Promise.withResolvers<number>(), complete = Promise.withResolvers<unknown>();
  const original = CodexJsonDecoder.prototype.write, slices: number[] = [];
  vi.spyOn(CodexJsonDecoder.prototype, "write").mockImplementation(function (this: CodexJsonDecoder, bytes) {
    slices.push(bytes.length);
    if (slices.length === 1) sockets.peer.write("ready");
    return original.call(this, bytes);
  });
  sockets.client.once("data", () => ready.resolve(slices.length));
  const rpc = new CodexRpc(child, message => complete.resolve(message), { createSpool: noSpool, limits: { bufferBytes: 4 } });
  try {
    child.stdout.write(input);
    const observed = await ready.promise;
    expect(observed).toBeGreaterThan(0); expect(observed).toBeLessThan(Math.ceil(input.length / 4));
    expect(await complete.promise).toEqual(JSON.parse(input.toString()));
    expect(slices.every(size => size <= 4)).toBe(true);
    expect(slices.reduce((sum, size) => sum + size, 0)).toBe(input.length);
  } finally { rpc.dispose(); await rpc.stopped; await sockets.close(); }
});

test("completing a partial frame clears its old timer before yielding to I/O", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] }); vi.setSystemTime(1000);
  const child = transport(), received: unknown[] = [], failures: Error[] = [], checked = Promise.withResolvers<void>();
  const rpc = new CodexRpc(child, message => {
    received.push(message);
    if (received.length === 1) setImmediate(() => { vi.advanceTimersByTime(2); checked.resolve(); });
  }, { createSpool: noSpool, limits: { frameMs: 100 }, onFatalError: error => failures.push(error) });
  try {
    child.stdout.write('{"method":"notice","params":'); await nextIo();
    expect(vi.getTimerCount()).toBe(1); vi.advanceTimersByTime(99);
    child.stdout.write('{} }\n' + notification(1)); await checked.promise;
    await nextIo();
    expect(failures).toEqual([]); expect(received).toHaveLength(2); expect(vi.getTimerCount()).toBe(0);
  } finally { rpc.dispose(); await rpc.stopped; }
});

test("successive partial slices retain the original absolute frame deadline and join its immediate", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] }); vi.setSystemTime(1000);
  const child = transport(), failures: Error[] = [], received: unknown[] = [];
  const rpc = new CodexRpc(child, message => received.push(message), { createSpool: noSpool, limits: { frameMs: 100 }, onFatalError: error => failures.push(error) });
  try {
    child.stdout.write('{"method":"notice","params":{"value":"'); await nextIo();
    vi.advanceTimersByTime(60);
    child.stdout.write("continued"); await nextIo();
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(40); await rpc.stopped;
    expect(failures).toHaveLength(1); expect(failures[0]!.message).toContain("frame deadline");
    expect(received).toEqual([]); expect(vi.getTimerCount()).toBe(0);
  } finally { rpc.dispose(); await rpc.stopped; }
});

test.each(["dispose", "error"])("%s during an awaited immediate stops dispatch and joins reader cleanup", async action => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const child = transport(), failures: Error[] = [], received: unknown[] = [], nativeError = new Error("Original native error.");
  let stopped = false, stoppedAtClose: boolean | undefined;
  const rpc = new CodexRpc(child, message => {
    received.push(message);
    setImmediate(() => {
      stoppedAtClose = stopped;
      if (action === "dispose") rpc.dispose();
      else child.emit("error", nativeError);
    });
  }, { createSpool: noSpool, onFatalError: error => failures.push(error) });
  void rpc.stopped.then(() => { stopped = true; });
  try {
    child.stdout.write(notification(0) + notification(1) + '{"partial":');
    await rpc.stopped;
    expect(stoppedAtClose).toBe(false); expect(received).toHaveLength(1); expect(vi.getTimerCount()).toBe(0);
    expect(child.stdout.destroyed).toBe(true);
    if (action === "dispose") expect(failures).toEqual([]);
    else expect(failures).toEqual([nativeError]);
  } finally { rpc.dispose(); await rpc.stopped; }
});

test("natural exit blocks new writes while draining received notifications and a pending response", async () => {
  const child = transport(), received: number[] = [], failures: Error[] = [], closed = Promise.withResolvers<void>();
  const rpc = new CodexRpc(child, message => {
    received.push((message.params as { index: number }).index);
    if (received.length === 1) setImmediate(() => { child.emit("exit"); closed.resolve(); });
  }, { createSpool: noSpool, onFatalError: error => failures.push(error) });
  try {
    const response = rpc.request("finish", {});
    void response.catch(() => {});
    child.stdout.end(notification(0) + notification(1) + JSON.stringify({ id: 1, result: "confirmed" }) + "\n");
    await closed.promise;
    await expect(rpc.request("too-late", {})).rejects.toThrow("closed");
    expect(() => rpc.notify("too-late")).toThrow("closed");
    expect(() => rpc.respond(2, {})).toThrow("closed");
    expect(() => rpc.reject(2, "unsupported")).toThrow("closed");
    expect(child.stdin.read().toString()).toBe('{"id":1,"method":"finish","params":{}}\n');
    expect(failures).toEqual([]);
    expect(await response).toBe("confirmed");
    await rpc.stopped;
    expect(received).toEqual([0, 1]); expect(failures).toHaveLength(1);
    expect(failures[0]!.message).toContain("Native transport ended");
  } finally { rpc.dispose(); await rpc.stopped; }
});

test("a real subprocess exit drains every final notification and the successful response before reporting EOF", async () => {
  const child = spawn(process.execPath, [fileURLToPath(new URL("./fixtures/codex-rpc-exit.mjs", import.meta.url))], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const received: number[] = [], events: string[] = [];
  const rpc = new CodexRpc(child, message => { received.push((message.params as { index: number }).index); }, { createSpool: noSpool, onFatalError: () => events.push("EOF") });
  try {
    const response = await rpc.request("finish", {}).then(value => { events.push("response"); return value; });
    expect(response).toEqual({ confirmed: true });
    await rpc.stopped;
    expect(received).toEqual(Array.from({ length: 1000 }, (_, index) => index));
    expect(events).toEqual(["response", "EOF"]);
  } finally { rpc.dispose(); child.kill(); await rpc.stopped; }
});

test.each(["", '{"id":1,"result":'])("natural close settles an unanswered operation after validating final bytes %j", async suffix => {
  const child = transport(), received: unknown[] = [], failures: Error[] = [];
  const rpc = new CodexRpc(child, message => {
    received.push(message);
    setImmediate(() => child.emit("close"));
  }, { createSpool: noSpool, onFatalError: error => failures.push(error) });
  try {
    const pending = expect(rpc.request("unconfirmed", {})).rejects.toThrow(suffix ? "incomplete frame" : "Native transport ended");
    child.stdout.end(notification(0) + suffix);
    await pending; await rpc.stopped;
    expect(received).toHaveLength(1); expect(failures).toHaveLength(1);
  } finally { rpc.dispose(); await rpc.stopped; }
});

test("a real frame deadline firing during an immediate joins the reader without rearming", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] }); vi.setSystemTime(1000);
  const child = transport(), failures: Error[] = [];
  let stopped = false, stoppedAtDeadline: boolean | undefined;
  const original = CodexJsonDecoder.prototype.write;
  vi.spyOn(CodexJsonDecoder.prototype, "write").mockImplementation(function (this: CodexJsonDecoder, bytes) {
    setImmediate(() => { stoppedAtDeadline = stopped; vi.advanceTimersByTime(100); });
    return original.call(this, bytes);
  });
  const rpc = new CodexRpc(child, () => { throw new Error("Incomplete input must not publish."); }, { createSpool: noSpool, limits: { frameMs: 100 }, onFatalError: error => failures.push(error) });
  void rpc.stopped.then(() => { stopped = true; });
  try {
    child.stdout.write('{"method":'); await rpc.stopped;
    expect(stoppedAtDeadline).toBe(false); expect(failures).toHaveLength(1);
    expect(failures[0]!.message).toContain("frame deadline"); expect(vi.getTimerCount()).toBe(0);
  } finally { rpc.dispose(); await rpc.stopped; }
});

test("closing from a frame consumer cannot rearm the partial-frame timer", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const child = transport(), received: unknown[] = [];
  const rpc = new CodexRpc(child, message => { received.push(message); rpc.dispose(); }, { createSpool: noSpool });
  try {
    child.stdout.write('{"method":"notice","params":'); await nextIo(); expect(vi.getTimerCount()).toBe(1);
    child.stdout.write('{} }\n' + notification(1)); await rpc.stopped;
    expect(received).toHaveLength(1); expect(vi.getTimerCount()).toBe(0);
  } finally { rpc.dispose(); await rpc.stopped; }
});
