import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import type { ControllerLaunchTicket } from "../../../src/commands/controller/launch-ticket.js";
import { openControllerLifecycleStore } from "../../../src/commands/controller/lifecycle-store.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const fixture = async () => {
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp/controller-tests");
  await mkdir(base, { recursive: true });
  const home = await mkdtemp(path.join(base, "inspection-")); roots.push(home);
  const ticket: ControllerLaunchTicket = { schemaVersion: 1, launchId: randomUUID(), executionId: randomUUID(), controllerId: randomUUID(), controllerInstanceId: randomUUID(), sessionId: randomUUID(), executionGeneration: "1", serverOrigin: "https://daynight.example", projectId: randomUUID(), taskId: randomUUID(), claimId: randomUUID(), workerId: randomUUID(), worktreeId: randomUUID(), userId: randomUUID(), provider: "codex", cwd: home, nativeHome: path.join(home, ".codex"), configuration: { agent: "codex", agentControlMode: "web", model: null, args: [], recoveryLimit: 2 }, initialOperationId: randomUUID(), initialPrompt: "worker-managed task", resumeNativeSessionId: null, credentialFile: path.join(home, "grant.json"), ipcEndpoint: path.join(home, "c.sock"), ipcSecret: "a".repeat(64), createdAt: new Date().toISOString() };
  const file = path.join(home, "journal.sqlite");
  return { file, ticket, open: () => openControllerLifecycleStore(file, ticket, { contentOwnedLocally: true }) };
};
const query = (historyEpoch: string, cursor: string | null = null, limit = 20) => ({ historyEpoch, cursor, limit, responseOverhead: 4096 });
const responseBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`));

it("reads durable original entries backwards without repeating concurrent appends", async () => {
  const f = await fixture(); let store = f.open();
  const ids = Array.from({ length: 5 }, () => randomUUID());
  try {
    ids.forEach((entryId, i) => store.projectTimeline({ entryId, revision: "1", kind: "assistant_message", content: [{ type: "text", text: `message ${i}` }] }));
    store.acknowledgeEvents("5"); store.close(); store = f.open();
    const epoch = randomUUID(), tail = store.readInspection(query(epoch, null, 2));
    expect(tail.items.map(item => item.entryId)).toEqual(ids.slice(3));
    expect(tail.items[0]).toMatchObject({ role: "assistant", timestamp: null, body: { content: [{ type: "text", text: "message 3" }] }, truncated: false, contentRef: null });
    store.projectTimeline({ entryId: randomUUID(), revision: "1", kind: "reasoning", text: "later" });
    const middle = store.readInspection(query(epoch, tail.beforeCursor, 2));
    const first = store.readInspection(query(epoch, middle.beforeCursor, 2));
    expect([...first.items, ...middle.items, ...tail.items].map(item => item.entryId)).toEqual(ids);
    expect(first.hasMoreBefore).toBe(false);
    expect(() => store.readInspection(query(randomUUID(), tail.beforeCursor))).toThrow(expect.objectContaining({ code: "reset_required" }));
  } finally { store.close(); }
});

it("returns a real empty page and validates limits before reading", async () => {
  const f = await fixture(), store = f.open();
  try {
    const epoch = randomUUID();
    expect(store.readInspection(query(epoch))).toMatchObject({ items: [], beforeCursor: null, hasMoreBefore: false });
    for (const limit of [0, 201, 1.5]) expect(() => store.readInspection(query(epoch, null, limit))).toThrow();
    expect(() => store.readInspection({ ...query(epoch), responseOverhead: 262144 })).toThrow();
  } finally { store.close(); }
});

it("reassembles canonical original JSON with Unicode-safe chunks beyond the web display budget", async () => {
  const f = await fixture(), store = f.open(), epoch = randomUUID(), entryId = randomUUID();
  const text = "\u2028😀".repeat(140000) + "<>&\n";
  try {
    store.projectTimeline({ entryId, revision: "1", kind: "tool_call", callId: "tool", name: "shell", input: text, output: [{ type: "text", text: "工具输出" }], status: "completed", truncated: false });
    expect(store.readTimeline({ historyEpoch: epoch, direction: "tail", cursor: null, limit: 1 }).items[0]).toMatchObject({ kind: "error", code: "display_budget_exceeded" });
    const page = store.readInspection(query(epoch, null, 1)), item = page.items[0]!;
    expect(item).toMatchObject({ entryId, kind: "tool_call", body: null, truncated: true });
    expect(responseBytes(page) + 4096).toBeLessThanOrEqual(262144);
    let cursor = item.contentRef!.cursor, original = "", offset = 0;
    for (;;) {
      const chunk = store.readEntryChunk({ historyEpoch: epoch, cursor, limit: 32768 });
      expect(chunk.offset).toBe(String(offset));
      expect(chunk.fragment.isWellFormed()).toBe(true);
      expect(Buffer.byteLength(chunk.fragment)).toBeLessThanOrEqual(32768);
      expect(responseBytes(chunk) + 4096).toBeLessThanOrEqual(262144);
      original += chunk.fragment; offset += Buffer.byteLength(chunk.fragment);
      if (chunk.eof) { expect(chunk.nextCursor).toBeNull(); break; }
      expect(chunk.nextCursor).not.toBe(cursor); cursor = chunk.nextCursor!;
    }
    expect(String(Buffer.byteLength(original))).toBe(item.contentRef!.byteLength);
    expect(createHash("sha256").update(original).digest("hex")).toBe(item.contentRef!.sha256);
    expect(JSON.parse(original)).toMatchObject({ entryId, entrySeq: "1", revision: "1", input: text, output: [{ type: "text", text: "工具输出" }] });
    expect(original.indexOf('"callId"')).toBeLessThan(original.indexOf('"entryId"'));
    store.projectTimeline({ entryId, revision: "1", kind: "reasoning", text: "updated" });
    expect(() => store.readEntryChunk({ historyEpoch: epoch, cursor: item.contentRef!.cursor, limit: 32768 })).toThrow(expect.objectContaining({ code: "content_changed" }));
    expect(() => store.readEntryChunk({ historyEpoch: randomUUID(), cursor, limit: 32768 })).toThrow(expect.objectContaining({ code: "reset_required" }));
  } finally { store.close(); }
});

it("advances past entries replaced with content references within the full response budget", async () => {
  const f = await fixture(), store = f.open(), epoch = randomUUID();
  try {
    const ids = Array.from({ length: 4 }, () => randomUUID());
    ids.forEach(entryId => store.projectTimeline({ entryId, revision: "1", kind: "reasoning", text: "\u2028".repeat(30000) }));
    const page = store.readInspection(query(epoch, null, 4));
    expect(page.items.map(item => item.entryId)).toEqual(ids);
    expect(page.items.some(item => item.body === null && item.contentRef !== null)).toBe(true);
    expect(responseBytes(page) + 4096).toBeLessThanOrEqual(262144);
    expect(page.hasMoreBefore).toBe(false);
    expect(store.readInspection(query(epoch, page.beforeCursor, 4)).items).toEqual([]);
  } finally { store.close(); }
});

it("keeps valid fractional form bounds in canonical entry content", async () => {
  const f = await fixture(), store = f.open(), epoch = randomUUID(), entryId = randomUUID();
  try {
    store.projectTimeline({ entryId, revision: "1", kind: "interaction", interaction: { interactionId: randomUUID(), revision: "1", kind: "form", state: "pending", title: "x".repeat(270000), canDismiss: false, fields: [{ fieldId: "fraction", type: "number", label: "Fraction", required: true, min: 0.1, max: 1e21 }, { fieldId: "tiny", type: "number", label: "Tiny", required: false, min: -0, max: 1e-7 }] } });
    const item = store.readInspection(query(epoch, null, 1)).items[0]!;
    let cursor = item.contentRef!.cursor, original = "";
    for (;;) {
      const chunk = store.readEntryChunk({ historyEpoch: epoch, cursor, limit: 32768 }); original += chunk.fragment;
      if (chunk.eof) break;
      cursor = chunk.nextCursor!;
    }
    expect(original).toContain('"max":1e+21,"min":0.1');
    expect(original).toContain('"max":1e-7,"min":0');
    expect(createHash("sha256").update(original).digest("hex")).toBe(item.contentRef!.sha256);
  } finally { store.close(); }
});

it("reserves HTML escaping used by the final MCP response encoder", async () => {
  const f = await fixture(), store = f.open(), epoch = randomUUID();
  try {
    store.projectTimeline({ entryId: randomUUID(), revision: "1", kind: "reasoning", text: "<>&".repeat(20000) });
    const page = store.readInspection(query(epoch, null, 1));
    expect(responseBytes(page) + 4096).toBeLessThanOrEqual(262144);
    expect(page.items[0]).toMatchObject({ body: null, truncated: true });
  } finally { store.close(); }
});
