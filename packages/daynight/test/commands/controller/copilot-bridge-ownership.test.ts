import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { CopilotBridgeChannel } from "../../../src/commands/controller/providers/copilot-bridge-channel.js";
const childProcess = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", async original => ({ ...await original<typeof import("node:child_process")>(), spawn: childProcess.spawn }));
import { isCopilotBridgeImage, releaseCopilotBridgeImage, retainCopilotBridgeImage, startCopilotBridge, type CopilotBridgeImage } from "../../../src/commands/controller/providers/copilot-bridge.js";

test("a released bridge reader retries failed physical removal without losing its retained transfer", async () => {
  const child = Object.assign(new EventEmitter(), { pid: 45678, exitCode: null as number | null, signalCode: null as NodeJS.Signals | null, stdout: new PassThrough(), stdin: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
  const exit = () => { child.exitCode = 0; child.emit("exit", 0, null); };
  child.kill.mockImplementation(() => { exit(); return true; });
  childProcess.spawn.mockImplementation(() => { queueMicrotask(() => child.emit("spawn")); return child; });
  const failures: Error[] = [], waiters = new Map<string, (value: unknown) => void>();
  let peer!: CopilotBridgeChannel;
  peer = new CopilotBridgeChannel(child.stdin, child.stdout, raw => {
    const message = raw as any;
    if (message.type === "response") { waiters.get(message.id)?.(message.value); waiters.delete(message.id); return; }
    if (message.type !== "request") throw new Error("Unexpected fixture bridge message");
    const value = message.method === "open" ? { sessionId: message.args[1] } : {};
    void peer.send({ type: "response", id: message.id, result: { value, images: [] } }).then(() => { if (message.method === "close") queueMicrotask(exit); }).catch(error => failures.push(error));
  }, error => failures.push(error));
  const media = (args: unknown) => {
    const id = randomUUID(), response = new Promise(resolve => waiters.set(id, resolve));
    void peer.send({ type: "request", id, method: "media", args }).catch(error => failures.push(error)); return response;
  };
  const remove = vi.fn(), failure = new Error("Fixture physical removal failed");
  const bridge = startCopilotBridge({ cwd: process.cwd(), env: {}, port: 23456, token: "a".repeat(64), onSpawn() {}, onLost: error => failures.push(error), media: { createSpool: () => ({ path: "/controlled/spool", write() {}, seal() {}, remove }) } });
  try {
    const client = await bridge.ready;
    let receive!: (marker: CopilotBridgeImage) => void;
    const received = new Promise<CopilotBridgeImage>(resolve => { receive = resolve; });
    await client.createSession({ sessionId: "fixture-session", onPermissionRequest: async () => ({ kind: "approved" }), onEvent: event => receive((event as any).data.attachments[0].data) });
    const transferId = randomUUID(), bytes = Buffer.from("abc");
    expect(await media({ action: "begin", transferId, length: bytes.length, mimeType: "image/png" })).toMatchObject({ available: true });
    await media({ action: "part", transferId, offset: 0, data: bytes.toString("base64") });
    await media({ action: "seal", transferId, sha256: createHash("sha256").update(bytes).digest("hex") });
    await peer.send({ type: "event", sessionId: "fixture-session", result: { value: { type: "user.message", id: "event", data: { attachments: [{ type: "blob", mimeType: "image/png", data: null }] } }, images: [{ path: ["data", "attachments", 0, "data"], transferId }] } });
    const marker = await received, release = retainCopilotBridgeImage(marker); releaseCopilotBridgeImage(marker);
    remove.mockImplementationOnce(() => { throw failure; });
    expect(() => release()).toThrow(failure); expect(isCopilotBridgeImage(marker)).toBe(true);
    expect(bridge.metrics()).toMatchObject({ mediaBytes: 3, mediaCount: 1 });
    release(); expect(remove).toHaveBeenCalledTimes(2); expect(isCopilotBridgeImage(marker)).toBe(false);
    expect(bridge.metrics()).toMatchObject({ mediaBytes: 0, mediaCount: 0 });
    release(); expect(remove).toHaveBeenCalledTimes(2);
    expect(failures).toEqual([]);
  } finally { remove.mockReset(); await bridge.close(); peer.close(); }
});

test.each(["unsealed", "sealed", "both"])("bridge close preserves failed %s spools while retiring every successfully removed transfer", async failing => {
  const child = Object.assign(new EventEmitter(), { pid: 45678, exitCode: null as number | null, signalCode: null as NodeJS.Signals | null, stdout: new PassThrough(), stdin: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
  const exit = () => { child.exitCode = 0; child.emit("exit", 0, null); };
  child.kill.mockImplementation(() => { exit(); return true; });
  childProcess.spawn.mockReset().mockImplementation(() => { queueMicrotask(() => child.emit("spawn")); return child; });
  const waiters = new Map<string, (value: unknown) => void>(), failures: Error[] = [], methods: string[] = [];
  let peer!: CopilotBridgeChannel;
  peer = new CopilotBridgeChannel(child.stdin, child.stdout, raw => {
    const message = raw as any;
    if (message.type === "response") { waiters.get(message.id)?.(message.value); waiters.delete(message.id); return; }
    methods.push(message.method);
    void peer.send({ type: "response", id: message.id, result: { value: {}, images: [] } }).then(() => { if (message.method === "close") queueMicrotask(exit); }).catch(error => failures.push(error));
  }, error => failures.push(error));
  const media = async (args: unknown) => { const id = randomUUID(), response = new Promise(resolve => waiters.set(id, resolve)); await peer.send({ type: "request", id, method: "media", args }); return response; };
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp/copilot-bridge-release"); mkdirSync(base, { recursive: true });
  const root = mkdtempSync(path.join(base, "case-")), spools: Array<{ path: string; remove: ReturnType<typeof vi.fn> }> = [], errors = [new Error("Unsealed unlink failure"), new Error("Sealed unlink failure")];
  const bridge = startCopilotBridge({ cwd: root, env: {}, port: 23456, token: "a".repeat(64), onSpawn() {}, onLost: error => failures.push(error), media: { createSpool() {
    const index = spools.length, filename = path.join(root, String(index)); writeFileSync(filename, "");
    const remove = vi.fn(() => unlinkSync(filename));
    if (failing === "both" || failing === (index === 0 ? "unsealed" : "sealed")) remove.mockImplementationOnce(() => { throw errors[index]; });
    spools.push({ path: filename, remove }); return { path: filename, write: bytes => writeFileSync(filename, bytes), seal() {}, remove };
  } } });
  try {
    await bridge.ready;
    const unsealed = randomUUID(), sealed = randomUUID(), bytes = Buffer.from("abc");
    await media({ action: "begin", transferId: unsealed, length: 3, mimeType: "image/png" });
    await media({ action: "begin", transferId: sealed, length: 3, mimeType: "image/png" });
    await media({ action: "part", transferId: sealed, offset: 0, data: bytes.toString("base64") });
    await media({ action: "seal", transferId: sealed, sha256: createHash("sha256").update(bytes).digest("hex") });
    const first = bridge.close(); expect(bridge.close()).toBe(first); const error = await first.catch(error => error);
    if (failing === "both") { expect(error).toBeInstanceOf(AggregateError); expect(error.errors).toEqual(errors); }
    else expect(error).toBe(errors[failing === "unsealed" ? 0 : 1]);
    expect(child.exitCode).toBe(0); expect(spools.map(spool => spool.remove.mock.calls.length)).toEqual([1, 1]);
    expect(spools.map(spool => existsSync(spool.path))).toEqual([failing !== "sealed", failing !== "unsealed"]);
    expect(bridge.metrics()).toMatchObject({ mediaBytes: failing === "both" ? 6 : 3, mediaCount: failing === "both" ? 2 : 1 });
    const second = bridge.close(); expect(second).not.toBe(first); await expect(second).resolves.toBeUndefined();
    expect(spools.map(spool => spool.remove.mock.calls.length)).toEqual([failing !== "sealed" ? 2 : 1, failing !== "unsealed" ? 2 : 1]);
    expect(spools.every(spool => !existsSync(spool.path))).toBe(true); expect(bridge.metrics()).toMatchObject({ mediaBytes: 0, mediaCount: 0 });
    await bridge.close(); expect(methods.filter(method => method === "close")).toHaveLength(1); expect(childProcess.spawn).toHaveBeenCalledOnce(); expect(failures).toEqual([]);
  } finally { for (const spool of spools) spool.remove.mockImplementation(() => rmSync(spool.path, { force: true })); await bridge.close().catch(() => {}); peer.close(); rmSync(root, { recursive: true, force: true }); }
});


test.each(["same", "changed", "foreign"])("bridge preserves only the exact %s permission callback object", async mode => {
  const child = Object.assign(new EventEmitter(), { pid: 45678, exitCode: null as number | null, signalCode: null as NodeJS.Signals | null, stdout: new PassThrough(), stdin: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
  const exit = () => { child.exitCode = 0; child.emit("exit", 0, null); };
  child.kill.mockImplementation(() => { exit(); return true; });
  childProcess.spawn.mockReset().mockImplementation(() => { queueMicrotask(() => child.emit("spawn")); return child; });
  const failures: Error[] = [], events: unknown[] = [];
  let peer!: CopilotBridgeChannel, callbackRequest: unknown;
  peer = new CopilotBridgeChannel(child.stdin, child.stdout, raw => {
    const message = raw as any;
    if (message.type !== "request") return;
    const value = message.method === "open" ? { sessionId: message.args[1] } : {};
    void peer.send({ type: "response", id: message.id, result: { value, images: [] } }).then(() => { if (message.method === "close") queueMicrotask(exit); }).catch(error => failures.push(error));
  }, error => failures.push(error));
  const bridge = startCopilotBridge({ cwd: process.cwd(), env: {}, port: 23456, token: "a".repeat(64), onSpawn() {}, onLost: error => failures.push(error) });
  try {
    const client = await bridge.ready;
    await client.createSession({ sessionId: "fixture-session", onPermissionRequest: request => { callbackRequest = request; return { kind: "no-result" }; }, onEvent: event => events.push(event) });
    const permissionIdentity = randomUUID(), request = { kind: "read", path: "/controlled/image.png", intention: "ordinary fixture" };
    await peer.send({ type: "request", id: randomUUID(), method: "callback", sessionId: "fixture-session", callback: "onPermissionRequest", args: [request, { sessionId: "fixture-session" }], permissionIdentity });
    await vi.waitFor(() => expect(callbackRequest).toBeDefined());
    await peer.send({ type: "event", sessionId: mode === "foreign" ? "foreign-session" : "fixture-session", permissionIdentity, result: { value: { type: "permission.requested", data: { requestId: "request", permissionRequest: { ...request, ...(mode === "changed" ? { path: "/other/image.png" } : {}) } } }, images: [] } });
    if (mode === "same") { await vi.waitFor(() => expect(events).toHaveLength(1)); expect((events[0] as any).data.permissionRequest).toBe(callbackRequest); expect(failures).toEqual([]); }
    else { await vi.waitFor(() => expect(failures).toHaveLength(1)); expect(events).toEqual([]); expect(failures[0]?.message).toContain("does not match"); }
  } finally { await bridge.close(); peer.close(); }
});
