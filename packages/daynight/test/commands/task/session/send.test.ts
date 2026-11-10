import { mkdir, mkdtemp, readFile, readdir, rm, chmod } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createOperationStore, sessionBodyHash } from "../../../../src/commands/task/session/operation-store.js";
import type { SessionOperationRecord } from "../../../../src/commands/task/session/operation-store.js";
import { fixture, sendArgs, queryArgs, actorId, origin, receipt, response, missing, inspection, operationId, operationUrl, projectId, sessionId, taskId } from "./fixtures.js";
let root: string;
beforeAll(async () => { const tmp = fileURLToPath(new URL("../../../../../../.tmp/", import.meta.url)); await mkdir(tmp, { recursive: true }); root = await mkdtemp(path.join(tmp, "session-send-")); });
afterAll(async () => { await rm(root, { recursive: true, force: true }); });
const recordPath = (state: string) => path.join(state, "session-operations", sessionBodyHash(origin), actorId, `${operationId}.json`);
const saved = async (state: string) => JSON.parse(await readFile(recordPath(state), "utf8")) as SessionOperationRecord;
it("saves only exact message hash, original full fence and receipt before returning pending", async () => {
  const f = await fixture(root), body = "\ufeff  /compact 中文😀\r\n\n";
  expect(await f.run(sendArgs(body))).toBe(3);
  expect(f.output()).toContain(operationId); expect(JSON.parse(f.output())).toMatchObject({ state: "accepted", projectId, taskId, sessionId });
  const post = f.fetch.mock.calls.find(([, init]) => init?.method === "POST")!;
  expect(JSON.parse(post[1]!.body as string)).toMatchObject({ payload: { content: [{ type: "text", text: body }], expectedTurnId: null } });
  expect(JSON.parse(post[1]!.body as string)).not.toHaveProperty("connectionEpoch");
  const record = await saved(f.state); expect(record).toMatchObject({ bodySha256: sessionBodyHash(body), phase: "receipt", fence: inspection.fence });
  expect(JSON.stringify(record)).not.toContain(body); expect(JSON.stringify(record)).not.toContain("test-token");
  f.fetch.mockClear();
  expect(await f.run(sendArgs(body))).toBe(3);
  expect(f.fetch.mock.calls.map(([url]) => String(url).split("/").at(-1))).toEqual(["me", operationId]);
  expect(JSON.parse(f.output()).state).toBe("not_found");
});
it("rejects local target or body conflicts without inspection or POST", async () => {
  const f = await fixture(root); await f.run(sendArgs()); f.fetch.mockClear();
  expect(await f.run(sendArgs("different"))).toBe(1); expect(f.errors()).toContain("conflicts"); expect(f.fetch).toHaveBeenCalledOnce();
  const args = sendArgs(); args[2] = actorId; expect(await f.run(args)).toBe(1); expect(f.errors()).toContain("conflicts");
});
it("queries a supplied ID before first use and never resends an existing remote receipt", async () => {
  const f = await fixture(root), base = f.fetch.getMockImplementation()!;
  f.fetch.mockImplementation(async (url, init) => String(url).endsWith(`/operations/${operationId}`) ? response({ operation: receipt("provider_accepted"), currentBinding: false }) : base(url, init));
  expect(await f.run(sendArgs())).toBe(0); expect(f.output()).toContain("does not prove acceptance");
  expect(f.fetch.mock.calls.map(([url]) => String(url).split("/").at(-1))).toEqual(["me", operationId]);
  expect(await readdir(f.state)).toEqual(["config.yml"]);
});
it.each(["network", "protocol", "auth"])("does not treat a %s lookup failure as first-use permission", async failure => {
  const f = await fixture(root), base = f.fetch.getMockImplementation()!;
  f.fetch.mockImplementation(async (url, init) => {
    if (!String(url).endsWith(`/operations/${operationId}`)) return base(url, init);
    if (failure === "network") throw new Error("message-secret");
    return failure === "protocol" ? response({ bad: true }) : response({ error: { code: "unauthenticated", message: "message-secret", requestId: operationId } }, 401);
  });
  expect(await f.run(sendArgs())).toBe(1); expect(f.errors()).not.toContain("message-secret"); expect(f.fetch.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false); expect(await readdir(f.state)).toEqual(["config.yml"]);
});
it.each(["prepared", "dispatch_unknown"] as const)("recovers a %s record only by querying the original operation", async phase => {
  const f = await fixture(root), store = await createOperationStore(f.state, origin, actorId, operationId);
  try {
    await store.acquire();
    await store.write({ schemaVersion: 1, origin, actorId, projectId, taskId, sessionId, operationId, fence: inspection.fence, expectedTurnId: "original-turn", bodySha256: sessionBodyHash("original message"), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), phase, receipt: null });
  } finally { await store.close(); }
  expect(await f.run(sendArgs())).toBe(3); expect(f.fetch.mock.calls.map(([url]) => String(url).split("/").at(-1))).toEqual(["me", operationId]);
  expect(await f.run(["operation", "--operation-id", operationId, "--json"])).toBe(3); expect(JSON.parse(f.output())).toMatchObject({ state: "not_found", operationId, projectId, taskId, sessionId });
});
it.each(["provider_accepted", "confirmed", "accepted", "offered", "dispatching", "unknown", "rejected", "failed", "expired"] as const)("maps the actual original %s state for operation reads", async state => {
  const f = await fixture(root), base = f.fetch.getMockImplementation()!;
  f.fetch.mockImplementation(async (url, init) => String(url).endsWith(`/operations/${operationId}`) ? response({ operation: receipt(state), currentBinding: false }) : base(url, init));
  expect(await f.run(queryArgs)).toBe(["confirmed", "provider_accepted"].includes(state) ? 0 : ["rejected", "failed", "expired"].includes(state) ? 1 : 3);
  expect(JSON.parse(f.output())).toMatchObject({ state, currentBinding: false }); expect(await readdir(f.state)).toEqual(["config.yml"]);
});
it("rejects malformed or partial arguments without HTTP, files or leaked text", async () => {
  const f = await fixture(root);
  for (const args of [["send", taskId, sessionId, "--text", "SECRET", "--bad"], ["operation", taskId], ["operation", "--operation-id", operationId, "--project", projectId], sendArgs().concat("--stdin"), sendArgs().map(value => value === "0" ? "61" : value), sendArgs("\ud800SECRET"), sendArgs("x" + "\u0001".repeat(400_000))]) {
    expect(await f.run(args)).toBe(2); expect(f.errors()).not.toContain("SECRET"); expect(await readdir(f.state)).toEqual(["config.yml"]);
  }
  expect(f.fetch.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
});
it.each([
  { currentBinding: false }, { source: "archive" }, { session: { ...inspection.session, agentControlMode: "herdr" } },
  { session: { ...inspection.session, activity: "working", currentTurnId: "turn", send: { allowed: false, mode: null, reason: "unsupported" } } },
])("refuses an ineligible Session without writing records or POST %#", async change => {
  const f = await fixture(root), base = f.fetch.getMockImplementation()!;
  f.fetch.mockImplementation(async (url, init) => String(url).endsWith("/inspection") ? response({ ...inspection, ...change }) : base(url, init));
  expect(await f.run(sendArgs())).toBe(1); expect(f.fetch.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false); expect(await readdir(f.state)).toEqual(["config.yml"]);
});
it("freezes true working steer eligibility and its original turn", async () => {
  const f = await fixture(root), base = f.fetch.getMockImplementation()!;
  f.fetch.mockImplementation(async (url, init) => String(url).endsWith("/inspection") ? response({ ...inspection, session: { ...inspection.session, activity: "working", currentTurnId: "turn-7", send: { allowed: true, mode: "steer", reason: "allowed" } } }) : base(url, init));
  expect(await f.run(sendArgs())).toBe(3); expect((await saved(f.state)).expectedTurnId).toBe("turn-7"); expect(JSON.parse(f.output())).toMatchObject({ sendMode: "steer", expectedTurnId: "turn-7" });
});
it("preserves unknown after a lost POST receipt and only queries on restart", async () => {
  const f = await fixture(root), base = f.fetch.getMockImplementation()!;
  f.fetch.mockImplementation(async (url, init) => { if (init?.method === "POST") throw new Error("lost receipt"); return base(url, init); });
  expect(await f.run(sendArgs())).toBe(3); expect(JSON.parse(f.output()).state).toBe("unknown"); expect((await saved(f.state)).phase).toBe("dispatch_unknown");
  f.fetch.mockClear(); expect(await f.run(sendArgs())).toBe(3); expect(f.fetch.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
});
it("retains actual native error only in live output, never in the record", async () => {
  const f = await fixture(root), base = f.fetch.getMockImplementation()!;
  f.fetch.mockImplementation(async (url, init) => init?.method === "POST" ? response({ operation: receipt("failed", { error: { code: "INPUT-SECRET", message: "BODY-SECRET\u001b[31m\nsecond" } }), operationUrl }, 202, actorId, { Location: operationUrl }) : base(url, init));
  expect(await f.run(sendArgs().filter(value => value !== "--json"))).toBe(1); expect(f.output()).toContain("BODY-SECRET\\u001b[31m\\nsecond");
  const record = JSON.stringify(await saved(f.state)); expect(record).not.toContain("SECRET"); expect(record).toContain("operation_error");
});
it("keeps the original identity when a receipt wait is interrupted", async () => {
  const f = await fixture(root), base = f.fetch.getMockImplementation()!;
  f.fetch.mockImplementation(async (url, init) => { const reply = await base(url, init); if (init?.method === "POST") setTimeout(() => f.signals.emit("SIGINT"), 10); return reply; });
  expect(await f.run(sendArgs().map(value => value === "0" ? "30" : value))).toBe(130); expect(JSON.parse(f.output())).toMatchObject({ state: "accepted", operationId });
});
it("bounds a hanging GET to the total receipt wait and keeps the latest receipt", async () => {
  const f = await fixture(root), base = f.fetch.getMockImplementation()!; let posted = false;
  f.fetch.mockImplementation(async (url, init) => { if (posted && String(url).endsWith(`/operations/${operationId}`)) return new Promise(() => {}); if (init?.method === "POST") posted = true; return base(url, init); });
  const start = performance.now(); expect(await f.run(sendArgs().map(value => value === "0" ? "1" : value))).toBe(3); expect(performance.now() - start).toBeLessThan(2_000); expect(JSON.parse(f.output())).toMatchObject({ state: "accepted", waitExpired: true });
});
it.skipIf(process.platform === "win32")("refuses unsafe recovery directories without changing the existing config permissions", async () => {
  const f = await fixture(root); await mkdir(path.join(f.state, "session-operations"), { mode: 0o755 }); await chmod(path.join(f.state, "session-operations"), 0o755);
  expect(await f.run(sendArgs())).toBe(1); expect(f.fetch.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
});
it.skipIf(process.platform === "win32").each(["directory", "prepared-file", "prepared-directory", "dispatch-file", "dispatch-directory", "receipt-file", "receipt-directory"])("keeps real filesystem %s barrier failure from enabling a retry", async failure => {
  const f = await fixture(root);
  const { open } = await import("node:fs/promises");
  const probe = await open(path.join(f.state, "probe"), "w");
  const prototype = Object.getPrototypeOf(probe) as { sync: () => Promise<void> };
  const original = prototype.sync; await probe.close();
  let fileSyncs = 0, pendingDirectory = 0;
  const spy = vi.spyOn(prototype, "sync").mockImplementation(async function (this: import("node:fs/promises").FileHandle) {
    const stat = await this.stat();
    if (stat.isFile() && stat.size > 0) {
      fileSyncs++; pendingDirectory = fileSyncs;
      if (["prepared-file", "dispatch-file", "receipt-file"][fileSyncs - 1] === failure) throw new Error("controlled file barrier failure");
    } else if (stat.isDirectory()) {
      if (failure === "directory" || ["prepared-directory", "dispatch-directory", "receipt-directory"][pendingDirectory - 1] === failure) throw new Error("controlled directory barrier failure");
      pendingDirectory = 0;
    }
    await original.call(this);
  });
  try {
    expect(await f.run(sendArgs())).toBe(1);
    const posts = f.fetch.mock.calls.filter(([, init]) => init?.method === "POST");
    expect(posts).toHaveLength(failure.startsWith("receipt") ? 1 : 0);
    if (failure.startsWith("receipt")) expect(JSON.parse(f.output())).toMatchObject({ state: "accepted", operationId });
  } finally { spy.mockRestore(); }
  if (!["directory", "prepared-file"].includes(failure)) {
    f.fetch.mockClear(); expect(await f.run(sendArgs())).toBe(3);
    expect(f.fetch.mock.calls.map(([url]) => String(url).split("/").at(-1))).toEqual(["me", operationId]);
  }
});
it("includes the first recovery GET in the total receipt wait deadline", async () => {
  const f = await fixture(root);
  const setupCode = await f.run(sendArgs()); expect(setupCode, f.errors() + f.output()).toBe(3);
  const base = f.fetch.getMockImplementation()!;
  const clock: { requestAt?: number; abortedAt?: number; reason?: unknown } = {};
  f.fetch.mockImplementation(async (url, init) => {
    if (!String(url).endsWith(`/operations/${operationId}`)) return base(url, init);
    clock.requestAt = performance.now();
    init!.signal!.addEventListener("abort", () => { clock.abortedAt = performance.now(); clock.reason = init!.signal!.reason; }, { once: true });
    return new Promise(() => {});
  });
  const start = performance.now(), code = await f.run(sendArgs().map(value => value === "0" ? "1" : value));
  expect(code, JSON.stringify({ stdout: f.output(), stderr: f.errors(), clock })).toBe(3);
  expect(clock.reason).toMatchObject({ kind: "request_timeout" });
  expect(performance.now() - start).toBeLessThan(2_000); expect(JSON.parse(f.output())).toMatchObject({ state: "unknown", waitExpired: true, operationId });
});
it("binds every subsequent response to the authenticated actor", async () => {
  const f = await fixture(root), base = f.fetch.getMockImplementation()!;
  f.fetch.mockImplementation(async (url, init) => String(url).endsWith("/inspection") ? response(inspection, 200, projectId) : base(url, init));
  expect(await f.run(sendArgs())).toBe(1); expect(f.fetch.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false); expect(await readdir(f.state)).toEqual(["config.yml"]);
});
it("uses the documented default wait to observe provider acceptance without waiting for task completion", async () => {
  const f = await fixture(root), base = f.fetch.getMockImplementation()!; let posted = false;
  f.fetch.mockImplementation(async (url, init) => {
    if (posted && String(url).endsWith(`/operations/${operationId}`)) return response({ operation: receipt("provider_accepted"), currentBinding: true });
    if (init?.method === "POST") posted = true;
    return base(url, init);
  });
  const args = sendArgs(); args.splice(args.indexOf("--wait-seconds"), 2);
  expect(await f.run(args)).toBe(0); expect(JSON.parse(f.output())).toMatchObject({ state: "provider_accepted", waitExpired: false }); expect(f.fetch.mock.calls.some(([url]) => String(url).endsWith(`/tasks/${taskId}`))).toBe(false);
});
it.each(["first-send", "recovery"] as const)("reports wait expiry when the %s receipt has headers but an incomplete body", async mode => {
  const f = await fixture(root);
  if (mode === "recovery") expect(await f.run(sendArgs())).toBe(3);
  const base = f.fetch.getMockImplementation()!;
  let posted = mode === "recovery", cancelledBody = false;
  f.fetch.mockImplementation(async (url, init) => {
    if (posted && String(url).endsWith(`/operations/${operationId}`)) return new Response(new ReadableStream<Uint8Array>({
      start: controller => controller.enqueue(Buffer.from('{"operation":')),
      cancel: () => { cancelledBody = true; },
    }), { status: 200, headers: { "content-type": "application/json", "Daynight-User-ID": actorId } });
    if (init?.method === "POST") posted = true;
    return base(url, init);
  });
  f.fetch.mockClear();
  const start = performance.now();
  expect(await f.run(sendArgs().map(value => value === "0" ? "1" : value))).toBe(3);
  expect(performance.now() - start).toBeLessThan(2_000);
  expect(JSON.parse(f.output())).toMatchObject({ state: mode === "first-send" ? "accepted" : "unknown", waitExpired: true, operationId });
  expect(cancelledBody).toBe(true);
  expect(f.fetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(mode === "first-send" ? 1 : 0);
});
it("keeps a fully received malformed receipt a protocol failure during the wait", async () => {
  const f = await fixture(root), base = f.fetch.getMockImplementation()!; let posted = false;
  f.fetch.mockImplementation(async (url, init) => {
    if (posted && String(url).endsWith(`/operations/${operationId}`)) return response({ invalid: true });
    if (init?.method === "POST") posted = true;
    return base(url, init);
  });
  expect(await f.run(sendArgs().map(value => value === "0" ? "1" : value))).toBe(1);
  expect(JSON.parse(f.output())).toMatchObject({ state: "accepted", waitExpired: false, operationId });
});

it.each([
  { source: "default request", limits: { requestMs: 500 } },
  { source: "overall operation", limits: { totalMs: 500, requestMs: 5_000 } },
])("keeps an earlier $source timeout distinct from receipt wait expiry", async ({ limits }) => {
  const f = await fixture(root), setupCode = await f.run(sendArgs());
  expect(setupCode, f.errors() + f.output()).toBe(3);
  const base = f.fetch.getMockImplementation()!;
  f.fetch.mockImplementation(async (url, init) => String(url).endsWith(`/operations/${operationId}`) ? new Promise(() => {}) : base(url, init));
  const code = await f.run(sendArgs().map(value => value === "0" ? "2" : value), limits);
  expect(code, f.errors() + f.output()).toBe(1);
  expect(JSON.parse(f.output())).toMatchObject({ state: "unknown", waitExpired: false, operationId });
});
