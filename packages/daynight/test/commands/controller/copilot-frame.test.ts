import { once } from "node:events";
import { createConnection, createServer, type Socket } from "node:net";
import { PassThrough, Readable } from "node:stream";
import { afterEach, expect, test, vi } from "vitest";
import { createCopilotFrameTransform, startCopilotFrameProxy } from "../../../src/commands/controller/providers/copilot-frame.js";

afterEach(() => vi.useRealTimers());
const collect = async (parts: readonly Buffer[]) => {
  const parser = createCopilotFrameTransform(), chunks: Buffer[] = [];
  parser.on("data", chunk => chunks.push(chunk));
  const finished = once(parser, "end");
  Readable.from(parts).pipe(parser);
  await finished;
  return Buffer.concat(chunks);
};

test("the framing proxy preserves exact header and body bytes across arbitrary boundaries", async () => {
  const body = Buffer.from('{"method":"你好"}');
  const bytes = Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\nContent-Type: application/json\r\n\r\n`), body]);
  const next = Buffer.from("Content-Length: 2\r\n\r\n{}");
  expect(await collect([...bytes].map(byte => Buffer.from([byte])).concat([next]))).toEqual(Buffer.concat([bytes, next]));
});

test.each(["-1", "+1", "01", "1.0", "NaN", "134217729", "9007199254740993"])("invalid native Content-Length %s fails before forwarding the header", async length => {
  const parser = createCopilotFrameTransform(), chunks: Buffer[] = [];
  parser.on("data", chunk => chunks.push(chunk));
  const failed = once(parser, "error");
  parser.end(`Content-Length: ${length}\r\n\r\n{}`);
  expect((await failed)[0]).toBeInstanceOf(Error);
  expect(chunks).toHaveLength(0);
});

test.each(["Content-Length: 2\r\nContent-Length: 2", "Content-Length: 2\r\ncontent-length: 3", "Content-Type: application/json", "Content-Length: 2\nX: y"])("ambiguous or malformed header is not partially forwarded: %s", async header => {
  const parser = createCopilotFrameTransform(), chunks: Buffer[] = [];
  parser.on("data", chunk => chunks.push(chunk));
  const failed = once(parser, "error"); parser.end(`${header}\r\n\r\n{}`);
  expect((await failed)[0]).toBeInstanceOf(Error); expect(chunks).toHaveLength(0);
});

test("headers are bounded before allocation of a native frame", async () => {
  const parser = createCopilotFrameTransform(), failed = once(parser, "error");
  parser.resume(); parser.end(Buffer.alloc(8193, 65));
  expect((await failed)[0].message).toContain("header");
});

test("a truncated body closes framing instead of resynchronizing on another header", async () => {
  await expect(collect([Buffer.from("Content-Length: 100\r\n\r\n{}")])).rejects.toThrow("incomplete");
});

test("an idle connection remains open but an incomplete native frame expires after no progress", async () => {
  vi.useFakeTimers();
  const parser = createCopilotFrameTransform(), failed = once(parser, "error");
  parser.resume();
  await vi.advanceTimersByTimeAsync(30_001); expect(parser.destroyed).toBe(false);
  parser.write("Content-Length: 20\r\n\r\n{");
  await vi.advanceTimersByTimeAsync(29_999); expect(parser.destroyed).toBe(false);
  parser.write(" ");
  await vi.advanceTimersByTimeAsync(29_999); expect(parser.destroyed).toBe(false);
  await vi.advanceTimersByTimeAsync(2);
  expect((await failed)[0].message).toContain("progress");
});

test("slow receivers backpressure the bounded framing stream", async () => {
  const parser = createCopilotFrameTransform(), receiver = new PassThrough({ highWaterMark: 1 });
  parser.pipe(receiver);
  const body = Buffer.alloc(512 * 1024, 65);
  parser.write("Content-Length: 1048576\r\n\r\n");
  parser.write(body);
  expect(parser.write(body)).toBe(false);
  const chunks: Buffer[] = []; receiver.on("data", chunk => chunks.push(chunk));
  parser.end(); await once(receiver, "end");
  expect(Buffer.concat(chunks).equals(Buffer.concat([Buffer.from("Content-Length: 1048576\r\n\r\n"), body, body]))).toBe(true);
});

test("the real proxy preserves wire bytes, rejects a second SDK connection and joins its sockets", async () => {
  const nativeSockets: Socket[] = [], incoming: Buffer[] = [], failures: Error[] = [];
  const bytes = Buffer.from('Content-Length: 2\r\nX-Header: unchanged\r\n\r\n{}');
  const native = createServer(socket => { nativeSockets.push(socket); socket.on("data", chunk => { incoming.push(chunk); socket.write(chunk); }); });
  native.listen(0, "127.0.0.1"); await once(native, "listening");
  const address = native.address(); if (!address || typeof address === "string") throw new Error("Missing fixture address.");
  const proxy = await startCopilotFrameProxy(address.port, error => failures.push(error));
  const client = createConnection(proxy.port, "127.0.0.1");
  const output: Buffer[] = []; let received = 0;
  const echoed = new Promise<void>(resolve => client.on("data", chunk => { output.push(chunk); received += chunk.length; if (received === bytes.length) resolve(); }));
  try {
    await once(client, "connect"); client.write(bytes); await echoed;
    expect(Buffer.concat(incoming)).toEqual(bytes); expect(Buffer.concat(output)).toEqual(bytes);
    const second = createConnection(proxy.port, "127.0.0.1"), rejected = once(second, "close"); await rejected;
    expect(nativeSockets).toHaveLength(1); expect(failures).toEqual([]);
    const clientClosed = once(client, "close"), nativeClosed = once(nativeSockets[0]!, "close");
    await proxy.close(); await Promise.all([clientClosed, nativeClosed]);
    expect(client.destroyed).toBe(true); expect(nativeSockets[0]!.destroyed).toBe(true); expect(failures).toEqual([]);
  } finally { client.destroy(); await proxy.close(); for (const socket of nativeSockets) socket.destroy(); await new Promise<void>(resolve => native.close(() => resolve())); }
});

test("an over-limit native header closes the real connection without forwarding its body", async () => {
  const nativeSockets: Socket[] = [], received: Buffer[] = [];
  const native = createServer(socket => { nativeSockets.push(socket); socket.write("Content-Length: 134217729\r\n\r\nsecret"); });
  native.listen(0, "127.0.0.1"); await once(native, "listening");
  const address = native.address(); if (!address || typeof address === "string") throw new Error("Missing fixture address.");
  let failure: Error | undefined;
  const proxy = await startCopilotFrameProxy(address.port, error => { failure = error; });
  const client = createConnection(proxy.port, "127.0.0.1"); client.on("data", chunk => received.push(chunk));
  try {
    await once(client, "close"); expect(received).toEqual([]); expect(failure?.message).toContain("limit");
  } finally { client.destroy(); await proxy.close(); for (const socket of nativeSockets) socket.destroy(); await new Promise<void>(resolve => native.close(() => resolve())); }
});
