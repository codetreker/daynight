import { once } from "node:events";
import * as net from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSuspendedNodeChild } from "../../../src/commands/worker/suspended-node-child.js";
import * as suspendedProcess from "../../../src/platform/windows-suspended-process.js";

vi.mock("node:net", { spy: true });

afterEach(() => vi.restoreAllMocks());

const outputFrame = (stream: "stdout" | "stderr", data: Buffer) => `${JSON.stringify({ kind: "launcher-output", stream, data: data.toString("base64") })}\n`;

// Exercise the production parser, sockets and streams on every platform. Only
// native process creation/exit and the pipe address are controlled here; Windows
// additionally exercises its real suspended process in the native case below.
const transport = async () => {
  const server = net.createServer();
  let connection: net.Socket | undefined;
  server.on("connection", socket => { connection = socket; });
  const listen = server.listen;
  vi.spyOn(server, "listen").mockImplementationOnce(function (this: net.Server, ...args: unknown[]) {
    return Reflect.apply(listen, this, [0, "127.0.0.1", args.at(-1)]);
  });
  vi.spyOn(net, "createServer").mockImplementationOnce(listener => {
    server.on("connection", listener as (socket: net.Socket) => void);
    return server;
  });
  let exited = false, secret = "";
  const exitObserved = Promise.withResolvers<void>();
  const native = { pid: 123, resume: vi.fn(), terminate: vi.fn(() => { exited = true; }), hasExited: () => { if (exited) exitObserved.resolve(); return exited; }, close: vi.fn() };
  vi.spyOn(suspendedProcess, "createSuspendedProcess").mockImplementationOnce(async options => {
    secret = options.environment.DAYNIGHT_CHILD_SECRET!;
    return native;
  });
  const guardian = await createSuspendedNodeChild({ source: "", args: [], environment: {} });
  const errors: Error[] = [];
  guardian.child.on("error", error => { errors.push(error); });
  const closed = Promise.withResolvers<void>();
  let didClose = false;
  guardian.child.once("close", () => { didClose = true; closed.resolve(); });
  const address = server.address() as net.AddressInfo;
  const peer = net.connect(address.port, "127.0.0.1");
  peer.on("error", () => {});
  await once(peer, "connect");
  peer.write(`${JSON.stringify({ secret })}\n`);
  await vi.waitFor(() => expect(guardian.child.connected).toBe(true));
  return {
    guardian, peer, native, errors, closed: closed.promise, didClose: () => didClose,
    exitObserved: exitObserved.promise,
    closeChannel: async () => {
      const closed = new Promise<void>(resolve => { connection!.once("close", () => resolve()); });
      connection!.destroy(); await closed;
    },
    exit: () => { exited = true; },
    cleanup: () => {
      exited = true; peer.destroy();
      guardian.child.stdout.resume(); guardian.child.stderr.resume();
      guardian.closeHandles(); server.close();
    },
  };
};

describe("Windows guardian channel closure", () => {
  it.each(["partial", "invalid-json", "invalid-output"] as const)("reports %s capture failure and closes streams after native exit", async mode => {
    const fixture = await transport();
    const { child } = fixture.guardian;
    child.stdout.resume(); child.stderr.resume();
    try {
      const frame = mode === "partial" ? '{"kind":"launcher-output"' : mode === "invalid-json" ? '{invalid}\n' : '{"kind":"launcher-output","stream":"other","data":""}\n';
      fixture.peer.end(frame); fixture.exit();
      await vi.waitFor(() => expect(fixture.didClose()).toBe(true));
      expect(fixture.errors).toHaveLength(1);
      expect(fixture.errors[0]!.message).toMatch(mode === "partial" ? /incomplete frame/ : /invalid .*frame/);
      expect(child.stdout.readableEnded).toBe(true);
      expect(child.stderr.readableEnded).toBe(true);
      fixture.guardian.closeHandles();
      expect(fixture.native.close).toHaveBeenCalledOnce();
    } finally { fixture.cleanup(); }
  });

  it.each([false, true])("drains complete frames and their backpressured writer before closing (truncated=%s)", async truncated => {
    const fixture = await transport();
    const { child } = fixture.guardian;
    const first = Buffer.alloc(128 * 1024, "a"), second = Buffer.from("second complete frame"), errorOutput = Buffer.from("stderr complete frame");
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    child.stderr.on("data", chunk => { stderr.push(chunk); });
    try {
      fixture.peer.end(outputFrame("stdout", first) + outputFrame("stdout", second) + outputFrame("stderr", errorOutput) + (truncated ? '{"kind":"launcher-output"' : ""));
      await vi.waitFor(() => expect(child.stdout.writableNeedDrain).toBe(true));
      fixture.exit();
      expect(fixture.didClose()).toBe(false);
      expect(child.stdout.writableEnded).toBe(false);
      expect(fixture.native.close).not.toHaveBeenCalled();
      child.stdout.on("data", chunk => { stdout.push(chunk); });
      await vi.waitFor(() => expect(fixture.didClose()).toBe(true));
      expect(Buffer.concat(stdout)).toEqual(Buffer.concat([first, second]));
      expect(Buffer.concat(stderr)).toEqual(errorOutput);
      expect(child.stdout.readableEnded).toBe(true);
      expect(child.stderr.readableEnded).toBe(true);
      expect(fixture.errors.map(error => error.message)).toEqual(truncated ? ["Windows guardian channel ended with an incomplete frame."] : []);
      fixture.guardian.closeHandles();
      expect(fixture.native.close).toHaveBeenCalledOnce();
    } finally { fixture.cleanup(); }
  });

  it("joins the last backpressured write after both channel closure and native exit", async () => {
    const fixture = await transport();
    const { child } = fixture.guardian;
    const data = Buffer.alloc(128 * 1024, "w"), output: Buffer[] = [];
    child.stderr.resume();
    try {
      fixture.peer.write(outputFrame("stdout", data));
      await vi.waitFor(() => expect(child.stdout.writableNeedDrain).toBe(true));
      await fixture.closeChannel();
      fixture.exit(); await fixture.exitObserved;
      expect(fixture.didClose()).toBe(false);
      expect(child.stdout.writableEnded).toBe(false);
      child.stdout.on("data", chunk => { output.push(chunk); });
      await vi.waitFor(() => expect(fixture.didClose()).toBe(true));
      expect(Buffer.concat(output)).toEqual(data);
      expect(fixture.errors).toEqual([]);
      fixture.guardian.closeHandles();
      expect(fixture.native.close).toHaveBeenCalledOnce();
    } finally { fixture.cleanup(); }
  });

  it.skipIf(process.platform !== "win32")("closes the real original guardian after truncated output under backpressure", async () => {
    const data = Buffer.alloc(128 * 1024, "n"), tail = Buffer.from("complete tail");
    const source = `channel.end(JSON.stringify({kind:'launcher-output',stream:'stdout',data:Buffer.alloc(128*1024,'n').toString('base64')})+'\\n'+${JSON.stringify(outputFrame("stdout", tail) + '{"kind":"launcher-output"')});`;
    const guardian = await createSuspendedNodeChild({ source, args: [], environment: process.env });
    const errors: Error[] = [], output: Buffer[] = [];
    const { child } = guardian;
    let closed = false;
    child.on("error", error => { errors.push(error); });
    child.once("close", () => { closed = true; });
    child.stderr.resume();
    try {
      guardian.resume();
      await vi.waitFor(() => expect(child.stdout.writableNeedDrain).toBe(true), { timeout: 5000 });
      expect(closed).toBe(false);
      child.stdout.on("data", chunk => { output.push(chunk); });
      await vi.waitFor(() => expect(closed).toBe(true), { timeout: 5000 });
      expect(Buffer.concat(output)).toEqual(Buffer.concat([data, tail]));
      expect(errors.map(error => error.message)).toEqual(["Windows guardian channel ended with an incomplete frame."]);
      expect(child.stdout.readableEnded).toBe(true);
      expect(child.stderr.readableEnded).toBe(true);
      guardian.closeHandles();
    } finally {
      child.stdout.resume(); child.stderr.resume();
      if (!closed) {
        child.kill("SIGKILL");
        await vi.waitFor(() => expect(closed).toBe(true), { timeout: 5000 });
      }
      guardian.closeHandles();
    }
  }, 15_000);
});
