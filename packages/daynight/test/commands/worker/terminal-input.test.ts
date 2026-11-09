import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import type { Socket } from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { submitTerminalInput, validateMacosPromptInput } from "../../../src/commands/worker/herdr/terminal-input.js";

const cleanup: (() => Promise<void>)[] = [];
const frame = (...bytes: number[]) => {
  const prefix = Buffer.alloc(4); prefix.writeUInt32LE(bytes.length);
  return Buffer.concat([prefix, Buffer.from(bytes)]);
};
const shutdown = (reason = "detached") => frame(3, 1, reason.length, ...Buffer.from(reason));
const screen = frame(1, 1, 80, 24, 1, 0);
const keyboard = frame(16, 0, 0);
const fixture = async (handle?: (socket: Socket, message: Buffer) => boolean) => {
  await mkdir(".tmp", { recursive: true });
  const directory = await mkdtemp(".tmp/ti-");
  const endpoint = process.platform === "win32" ? `\\\\.\\pipe\\daynight-ti-${path.basename(directory)}` : `${directory}/s`;
  const messages: Buffer[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket); socket.on("error", () => {}); socket.once("close", () => sockets.delete(socket));
    let pending = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 4 && pending.length >= pending.readUInt32LE() + 4) {
        const length = pending.readUInt32LE();
        const message = pending.subarray(4, length + 4); pending = pending.subarray(length + 4);
        messages.push(message);
        if (handle?.(socket, message)) continue;
        if (message[0] === 0) socket.write(frame(0, 22, 1, 0));
        if (message[0] === 5) socket.write(Buffer.concat([screen, keyboard]));
        if (message[0] === 4) socket.end(shutdown());
      }
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(endpoint, resolve); });
  cleanup.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  const run = (overrides: Partial<Parameters<typeof submitTerminalInput>[0]> = {}) => submitTerminalInput({
    endpoint, terminalId: "original-terminal", width: 80, height: 24, herdrVersion: "0.9.5",
    inputs: [{ kind: "paste", text: "你好\nsecond line 😀" }], signal: new AbortController().signal,
    beforeWrite: async () => {}, ...overrides,
  });
  return { run, messages };
};
afterEach(async () => { vi.useRealTimers(); for (const close of cleanup.splice(0).reverse()) await close(); });

describe("strict Herdr terminal input", () => {
  it("preflights the same complete paste byte limit and text rules", () => {
    expect(() => validateMacosPromptInput("界".repeat(5461) + "x")).not.toThrow();
    expect(() => validateMacosPromptInput("界".repeat(5462))).toThrow(expect.objectContaining({ name: "PromptInputLimitError", inputPath: "macos_terminal", actualBytes: 16386, maxBytes: 16384, submission: "not-submitted" }));
    expect(() => validateMacosPromptInput("bad\x1b")).toThrow("Invalid terminal paste");
  });

  it("attaches by exact terminal ID without takeover and preserves a complete Unicode paste", async () => {
    const f = await fixture();
    expect(await f.run()).toMatchObject({ status: "transport_completed" });
    expect(f.messages.map((message) => message[0])).toEqual([0, 5, 1, 4]);
    expect(f.messages[0]).toEqual(Buffer.from([0, 22, 80, 24, 0, 0, 0]));
    expect(f.messages[1]).toEqual(Buffer.from([5, 17, ...Buffer.from("original-terminal"), 0]));
    expect(f.messages[2]?.subarray(2).toString()).toBe("\x1b[200~你好\nsecond line 😀\x1b[201~");
  });

  it("waits for both a full baseline and keyboard state before revalidating admission", async () => {
    let attachSocket: Socket | undefined;
    let calls = 0;
    const f = await fixture((socket, message) => {
      if (message[0] !== 5) return false;
      attachSocket = socket; socket.write(keyboard); return true;
    });
    const result = f.run({ beforeWrite: async () => { calls++; } });
    while (!attachSocket) await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(calls).toBe(0);
    attachSocket.write(screen);
    expect(await result).toMatchObject({ status: "transport_completed" }); expect(calls).toBe(1);
  });

  it("rechecks admission between paste and Enter and reports partial dispatch as unknown", async () => {
    let received!: () => void; const receipt = new Promise<void>((resolve) => { received = resolve; });
    const f = await fixture((_socket, message) => { if (message[0] === 1) received(); return false; }); let calls = 0;
    expect(await f.run({ inputs: [{ kind: "paste", text: "draft" }, { kind: "keys", key: "Enter" }], beforeWrite: async () => {
      if (++calls === 2) { await receipt; throw new Error("closing"); }
    } })).toMatchObject({ status: "unknown" });
    expect(f.messages.filter((message) => message[0] === 1)).toHaveLength(1);
  });

  it("does not send when admission is revoked after attach", async () => {
    const f = await fixture();
    expect(await f.run({ beforeWrite: async () => { throw new Error("stale epoch"); } })).toMatchObject({ status: "rejected" });
    expect(f.messages.some((message) => message[0] === 1)).toBe(false);
  });

  it("does not replay an input when the peer closes after the write", async () => {
    const f = await fixture((socket, message) => { if (message[0] !== 1) return false; socket.destroy(); return true; });
    expect(await f.run()).toMatchObject({ status: "unknown" });
    expect(f.messages.filter((message) => message[0] === 1)).toHaveLength(1);
  });

  it.each(["0.9.4", "0.9.6", "0.9.5-preview", "unknown"])("rejects unverified Herdr version %s before connecting", async (herdrVersion) => {
    const f = await fixture(); expect(await f.run({ herdrVersion })).toMatchObject({ status: "rejected" }); expect(f.messages).toEqual([]);
  });

  it.each([
    [[0, 23, 1, 0]], [[0, 22, 0, 0]], [[0, 22, 1, 1, 3, 98, 97, 100]], [[0, 22, 1, 0, 0]],
  ])("rejects an incompatible or malformed handshake %j without attach", async (welcome) => {
    const f = await fixture((socket, message) => { if (message[0] !== 0) return false; socket.write(frame(...welcome)); return true; });
    expect(await f.run()).toMatchObject({ status: "rejected" }); expect(f.messages).toHaveLength(1);
  });

  it("rejects a replaced or busy terminal without name fallback", async () => {
    const f = await fixture((socket, message) => { if (message[0] !== 5) return false; socket.end(shutdown("not found")); return true; });
    expect(await f.run()).toMatchObject({ status: "rejected" }); expect(f.messages.map((message) => message[0])).toEqual([0, 5]);
  });

  it.each(["bad\x1b[201~text", "bad\u0000", "bad\u007f", "\ud800", "x".repeat(16385)])("rejects invalid paste without connecting", async (text) => {
    const f = await fixture(); expect(await f.run({ inputs: [{ kind: "paste", text }] })).toMatchObject({ status: "rejected" }); expect(f.messages).toEqual([]);
  });

  it("cancels a pending admission check without writing when it eventually resolves", async () => {
    const controller = new AbortController(); let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const f = await fixture();
    const result = f.run({ signal: controller.signal, beforeWrite: async () => { controller.abort(); await gate; } });
    expect(await result).toMatchObject({ status: "rejected" }); release();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(f.messages.some((message) => message[0] === 1)).toBe(false);
  });

  it("accepts fragmented wire frames and rejects unknown keyboard flags", async () => {
    const f = await fixture((socket, message) => {
      if (message[0] !== 5) return false;
      const bytes = Buffer.concat([screen, frame(16, 32, 0)]);
      for (const byte of bytes) socket.write(Buffer.from([byte])); return true;
    });
    expect(await f.run()).toMatchObject({ status: "rejected" });
    expect(f.messages.some((message) => message[0] === 1)).toBe(false);
  });

  it("preserves CRLF paste and rejects C1 control characters under the Session v2 contract", async () => {
    const f = await fixture();
    expect(await f.run({ inputs: [{ kind: "paste", text: "first\r\nsecond" }] })).toMatchObject({ status: "transport_completed" });
    expect(f.messages[2]?.subarray(2).toString()).toBe("\x1b[200~first\r\nsecond\x1b[201~");
    expect(await f.run({ inputs: [{ kind: "paste", text: "\u009b31m" }] })).toMatchObject({ status: "rejected" });
  });

  it.each([
    { key: "Enter", bytes: "\r" }, { key: "Escape", bytes: "\x1b" }, { key: "ArrowUp", bytes: "\x1b[A" },
    { key: "ArrowDown", bytes: "\x1b[B" }, { key: "ArrowLeft", bytes: "\x1b[D" }, { key: "ArrowRight", bytes: "\x1b[C" },
    { key: "Home", bytes: "\x1b[H" }, { key: "End", bytes: "\x1b[F" }, { key: "Delete", bytes: "\x1b[3~" },
    { key: "PageUp", bytes: "\x1b[5~" }, { key: "PageDown", bytes: "\x1b[6~" },
    { key: "Tab", bytes: "\t" }, { key: "Backspace", bytes: "\x7f" },
    { key: "Ctrl+C", bytes: "\x03" }, { key: "Ctrl+D", bytes: "\x04" }, { key: "Ctrl+U", bytes: "\x15" },
  ] as const)("encodes the permitted legacy shortcut $key", async ({ key, bytes }) => {
    const f = await fixture(); expect(await f.run({ inputs: [{ kind: "keys", key }] })).toMatchObject({ status: "transport_completed" });
    expect(f.messages[2]?.subarray(2).toString()).toBe(bytes);
  });

  it("validates and ignores direct-terminal mouse and notification metadata", async () => {
    const f = await fixture((socket, message) => {
      if (message[0] !== 5) return false;
      socket.write(Buffer.concat([frame(8, 0, 0), frame(4, 1, 2, 111, 107, 0), screen, keyboard])); return true;
    });
    expect(await f.run()).toMatchObject({ status: "transport_completed" });
  });

  it("rejects a varint masquerading as a wire boolean", async () => {
    const f = await fixture((socket, message) => {
      if (message[0] !== 5) return false;
      socket.write(Buffer.concat([frame(8, 251, 0, 0, 0), screen, keyboard])); return true;
    });
    expect(await f.run()).toMatchObject({ status: "rejected" });
    expect(f.messages.some((message) => message[0] === 1)).toBe(false);
  });

  it.each([
    { name: "delta without baseline", bytes: frame(1, 1, 80, 24, 0, 0) },
    { name: "changed dimensions", bytes: frame(1, 1, 81, 24, 1, 0) },
    { name: "unknown message", bytes: frame(250) },
    { name: "truncated vector", bytes: frame(1, 1, 80, 24, 1, 8, 65) },
    { name: "invalid notification kind", bytes: frame(4, 3, 0, 0) },
    { name: "empty frame", bytes: frame() },
    { name: "unsupported modifyOtherKeys", bytes: frame(16, 0, 3) },
    { name: "unsafe frame sequence", bytes: frame(1, 253, 255, 255, 255, 255, 255, 255, 255, 255, 80, 24, 1, 0) },
  ])("rejects $name before native input", async ({ bytes }) => {
    const f = await fixture((socket, message) => { if (message[0] !== 5) return false; socket.write(bytes); return true; });
    expect(await f.run()).toMatchObject({ status: "rejected" }); expect(f.messages.some((message) => message[0] === 1)).toBe(false);
  });

  it("discards valid local-only metadata without forwarding or executing it", async () => {
    const f = await fixture((socket, message) => {
      if (message[0] !== 5) return false;
      socket.write(Buffer.concat([frame(2, 1, 65), frame(5, 1, 65), frame(6, 1, 1, 65), frame(7), frame(9, 1), screen, keyboard])); return true;
    });
    expect(await f.run()).toMatchObject({ status: "transport_completed" });
  });

  it("encodes a large valid paste using bincode length rather than a truncated byte", async () => {
    const f = await fixture(); const text = "文".repeat(500);
    expect(await f.run({ inputs: [{ kind: "paste", text }] })).toMatchObject({ status: "transport_completed" });
    expect(f.messages[2]?.subarray(1, 4)).toEqual(Buffer.from([251, 232, 5]));
    expect(f.messages[2]?.subarray(4).toString()).toBe(`\x1b[200~${text}\x1b[201~`);
  });

  it.each([
    { width: 0 }, { height: 1001 }, { endpoint: "bad\0socket" }, { terminalId: "" }, { inputs: [] },
    { inputs: [{ kind: "keys", key: "arbitrary" }] }, { inputs: [{ kind: "keys", key: "Enter" }, { kind: "keys", key: "Enter" }] },
  ])("rejects invalid input parameters before connecting", async (overrides) => {
    const f = await fixture();
    expect(await f.run(overrides as Parameters<typeof f.run>[0])).toMatchObject({ status: "rejected" }); expect(f.messages).toEqual([]);
  });

  it("rejects an already cancelled request without connecting", async () => {
    const f = await fixture(); const controller = new AbortController(); controller.abort();
    expect(await f.run({ signal: controller.signal })).toMatchObject({ status: "rejected" }); expect(f.messages).toEqual([]);
  });

  it("bounds a stalled admission callback by the 10 second batch deadline", async () => {
    const f = await fixture(); let reached = false;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const result = f.run({ beforeWrite: async () => { reached = true; await new Promise<void>(() => {}); } });
    while (!reached) await new Promise<void>((resolve) => setImmediate(resolve));
    await vi.advanceTimersByTimeAsync(10000);
    expect(await result).toMatchObject({ status: "rejected", reason: "Terminal input deadline exceeded." });
    expect(f.messages.some((message) => message[0] === 1)).toBe(false);
  });

  it.each([
    { key: "Enter", flags: 11, modify: 0, bytes: "\x1b[13;1:1u\x1b[13;1:3u" },
    { key: "ArrowUp", flags: 3, modify: 0, bytes: "\x1b[1;1:1A\x1b[1;1:3A" },
    { key: "Delete", flags: 3, modify: 0, bytes: "\x1b[3;1:1~\x1b[3;1:3~" },
    { key: "Ctrl+C", flags: 1, modify: 0, bytes: "\x1b[99;5u" },
    { key: "Ctrl+C", flags: 0, modify: 2, bytes: "\x1b[27;5;99~" },
  ] as const)("honors keyboard mode $flags/$modify for $key", async ({ key, flags, modify, bytes }) => {
    const f = await fixture((socket, message) => { if (message[0] !== 5) return false; socket.write(Buffer.concat([screen, frame(16, flags, modify)])); return true; });
    expect(await f.run({ inputs: [{ kind: "keys", key }] })).toMatchObject({ status: "transport_completed" });
    expect(f.messages[2]?.subarray(2).toString()).toBe(bytes);
  });
});
