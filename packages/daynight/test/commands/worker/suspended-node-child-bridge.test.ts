import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import * as net from "node:net";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createSuspendedNodeChild } from "../../../src/commands/worker/suspended-node-child.js";
import * as suspendedProcess from "../../../src/platform/windows-suspended-process.js";

vi.mock("node:net", { spy: true });

afterEach(() => vi.restoreAllMocks());

it("preserves split UTF-8 command fields and 300 KiB of input through the real guardian bridge", async () => {
  const server = net.createServer();
  let socket: net.Socket | undefined, processChild: ChildProcess | undefined;
  server.on("connection", connection => { socket = connection; });
  vi.spyOn(net, "createServer").mockImplementationOnce(listener => {
    server.on("connection", listener as (socket: net.Socket) => void);
    return server;
  });
  if (process.platform !== "win32") {
    // Run the exact generated bootstrap in a real Node process. Unix sockets
    // use a short relative address inside the worktree's ignored scratch area.
    const endpoint = `../../.tmp/guardian-utf8-${randomUUID()}.sock`, listen = server.listen;
    await mkdir(path.resolve(import.meta.dirname, "../../../../../.tmp"), { recursive: true });
    vi.spyOn(server, "listen").mockImplementationOnce(function (this: net.Server, ...args: unknown[]) {
      return Reflect.apply(listen, this, [endpoint, args.at(-1)]);
    });
    vi.spyOn(suspendedProcess, "createSuspendedProcess").mockImplementationOnce(async options => {
      const child = spawn(options.file, [...options.args], { env: { ...options.environment, DAYNIGHT_CHILD_PIPE: endpoint }, stdio: "ignore" });
      processChild = child;
      return {
        pid: child.pid!, resume: () => {}, terminate: () => { child.kill("SIGKILL"); },
        hasExited: () => child.exitCode !== null || child.signalCode !== null, close: () => {},
      };
    });
  }
  const source = `
    process.on('message', message => {
      if (message.kind === 'finish') channel.end();
      else process.send({kind:'echo',message});
    });
    channel.on('data', () => {
      if (!channel.writableEnded) process.send({kind:'received',bytes:channel.bytesRead});
    });
  `;
  const guardian = await createSuspendedNodeChild({ source, args: [], environment: process.env });
  const { child } = guardian;
  const errors: Error[] = [], echoes: unknown[] = [];
  let receivedBytes = 0, closed = false;
  child.on("error", error => { errors.push(error); });
  child.on("message", (message: { kind: string; bytes?: number; message?: unknown }) => {
    if (message.kind === "received") receivedBytes = message.bytes!;
    if (message.kind === "echo") echoes.push(message.message);
  });
  child.once("close", () => { closed = true; });
  child.stdout.resume(); child.stderr.resume();
  try {
    guardian.resume();
    await vi.waitFor(() => expect(child.connected).toBe(true), { timeout: 5000 });
    const command = {
      kind: "run", file: "C:\\工具\\é😀\\命令.exe", args: ["参数😀", "café"],
      environment: { "变量": "值😀é" }, input: "中文🙂é".repeat(25_600),
    };
    expect(Buffer.byteLength(command.input)).toBe(300 * 1024);
    const wire = Buffer.from(`${JSON.stringify(command)}\n`);
    const inputStart = wire.indexOf(Buffer.from("中文"));
    const cuts = [
      wire.indexOf(Buffer.from("工具")) + 1,
      wire.indexOf(Buffer.from("参数")) + 2,
      wire.indexOf(Buffer.from("变量")) + 1,
      wire.indexOf(Buffer.from("值")) + 1,
      inputStart + 1, inputStart + 65_537, inputStart + 131_075, inputStart + 196_609,
      wire.length,
    ];
    const originalWrite = socket!.write.bind(socket!);
    let sentBytes = 0;
    const sent = Promise.withResolvers<void>();
    // Each next fragment waits for a receipt from the child's real socket, so
    // the receiver must observe the deliberately incomplete UTF-8 code points.
    vi.spyOn(socket!, "write").mockImplementationOnce((data, ...args: unknown[]) => {
      const callback = args.at(-1) as (error?: Error | null) => void;
      void (async () => {
        expect(Buffer.from(data)).toEqual(wire);
        for (const end of cuts) {
          await new Promise<void>((resolve, reject) => originalWrite(wire.subarray(sentBytes, end), error => error ? reject(error) : resolve()));
          sentBytes = end;
          await vi.waitFor(() => expect(receivedBytes).toBeGreaterThanOrEqual(end), { timeout: 5000 });
        }
      })().then(() => { callback(null); sent.resolve(); }, error => { callback(error); sent.reject(error); });
      return true;
    });
    child.send(command);
    await sent.promise;
    await vi.waitFor(() => expect(echoes).toHaveLength(1), { timeout: 5000 });
    expect(echoes[0]).toEqual(command);
    expect(errors).toEqual([]);
    child.send({ kind: "finish" });
    await vi.waitFor(() => expect(closed).toBe(true), { timeout: 5000 });
    guardian.closeHandles();
    if (processChild !== undefined) expect(processChild.exitCode).toBe(0);
  } finally {
    if (!closed) {
      child.kill("SIGKILL"); socket?.destroy();
      await vi.waitFor(() => expect(closed).toBe(true), { timeout: 5000 });
    }
    guardian.closeHandles(); server.close();
  }
}, 30_000);
