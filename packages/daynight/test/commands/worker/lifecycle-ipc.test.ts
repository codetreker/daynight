import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import path from "node:path";
import { startLifecycleIpcServer, requestLifecycleIpc, LifecycleIpcUnknownError } from "../../../src/commands/worker/lifecycle-ipc.js";

const identity = { serverOrigin: "http://localhost:8787", userId: "11111111-1111-4111-8111-111111111111", workerId: "22222222-2222-4222-8222-222222222222" }, operationId = "33333333-3333-4333-8333-333333333333";
const roots: string[] = [], servers: Awaited<ReturnType<typeof startLifecycleIpcServer>>[] = [];
afterEach(async () => { for (const server of servers.splice(0)) await server.close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const fixture = async (handle: Parameters<typeof startLifecycleIpcServer>[0]["handle"]) => {
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp/lifecycle-ipc-tests"); await mkdir(base, { recursive: true, mode: 0o700 });
  const workerDirectory = await mkdtemp(path.join(base, "case-")); roots.push(workerDirectory);
  const server = await startLifecycleIpcServer({ workerDirectory, identity, handle }); servers.push(server);
  return { workerDirectory, server };
};
const sendFrame = (endpoint: string, frame: string): Promise<string> => new Promise((resolve, reject) => {
  const socket = createConnection(endpoint); let output = "";
  const timer = setTimeout(() => { socket.destroy(); reject(new Error("Fixture socket timed out")); }, 2000);
  socket.once("connect", () => socket.write(frame)); socket.on("data", chunk => { output += String(chunk); });
  socket.once("error", reject); socket.once("close", () => { clearTimeout(timer); resolve(output); });
});
describe("authenticated lifecycle IPC", () => {
  it("dispatches only the restricted action to the original manager over a real socket", async () => {
    const handle = vi.fn(async () => {}), f = await fixture(handle);
    await requestLifecycleIpc({ workerDirectory: f.workerDirectory, identity, kind: "disable", operationId });
    expect(handle).toHaveBeenCalledExactlyOnceWith({ kind: "disable", operationId });
    await requestLifecycleIpc({ workerDirectory: f.workerDirectory, identity, kind: "query", operationId: null });
    expect(handle).toHaveBeenLastCalledWith({ kind: "query", operationId: null });
  });
  it("refuses another Worker before sending any request", async () => {
    const handle = vi.fn(), f = await fixture(handle);
    await expect(requestLifecycleIpc({ workerDirectory: f.workerDirectory, identity: { ...identity, workerId: identity.userId }, kind: "resume", operationId })).rejects.toThrow();
    expect(handle).not.toHaveBeenCalled();
  });
  it("rejects unauthenticated, shell-bearing and over-budget frames before application work", async () => {
    const handle = vi.fn(), f = await fixture(handle);
    const descriptor = JSON.parse(await readFile(path.join(f.workerDirectory, "lifecycle-ipc.json"), "utf8")) as { endpoint: string; secret: string };
    const request = { protocolVersion: 1, requestId: operationId, identity, secret: descriptor.secret, action: { kind: "resume", operationId } };
    expect(await sendFrame(descriptor.endpoint, `${JSON.stringify({ ...request, secret: "0".repeat(64) })}\n`)).toBe("");
    await sendFrame(descriptor.endpoint, `${JSON.stringify({ ...request, action: { ...request.action, shell: "unexpected" } })}\n`);
    await sendFrame(descriptor.endpoint, "x".repeat(16 * 1024 + 1));
    expect(handle).not.toHaveBeenCalled();
  });
  it("retains an unknown possibly delivered result and never replays a handler", async () => {
    let finish!: () => void; const pending = new Promise<void>(resolve => { finish = resolve; });
    const handle = vi.fn(() => pending), f = await fixture(handle);
    const request = requestLifecycleIpc({ workerDirectory: f.workerDirectory, identity, kind: "resume", operationId, timeoutMs: 30 });
    try { await expect(request).rejects.toBeInstanceOf(LifecycleIpcUnknownError); expect(handle).toHaveBeenCalledOnce(); }
    finally { finish(); }
  });
});
