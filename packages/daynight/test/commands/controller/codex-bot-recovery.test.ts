import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, appendFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { CodexBotRecovery, type CodexBotRecoveryOptions } from "../../../src/commands/controller/providers/codex-bot-recovery.js";

let root: string, source: string, options: CodexBotRecoveryOptions;
const nativeSessionId = "00000000-0000-4000-8000-000000000001", turn = "completed-turn", providerVersion = "0.169.0";
beforeEach(async () => {
  await mkdir(join(process.cwd(), ".tmp"), { recursive: true });
  root = await mkdtemp(join(process.cwd(), ".tmp", "codex-bot-recovery-")); source = join(root, "original.jsonl");
  options = { directory: join(root, "owned"), cwd: root, identity: { serverOrigin: "https://daynight.example", ownerUserId: randomUUID(), botId: randomUUID(), sessionId: randomUUID() } };
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const rollout = (completed: string | null = turn) => [
  { type: "session_meta", payload: { id: nativeSessionId, cwd: root, cli_version: providerVersion } },
  ...(completed === null ? [] : [
    { type: "event_msg", payload: { type: "task_started", turn_id: completed } },
    { type: "response_item", payload: { type: "message", content: [{ text: "保护中文内容" }] } },
    { type: "event_msg", payload: { type: "task_complete", turn_id: completed } },
  ]),
].map(item => JSON.stringify(item)).join("\n") + "\n";
const input = (protectedThroughTurn: string | null = turn) => ({ path: source, nativeSessionId, providerVersion, protectedThroughTurn });
const manifest = async () => JSON.parse(await readFile(join(options.directory, "manifest.json"), "utf8"));
const protect = async () => { const storage = new CodexBotRecovery(options); await writeFile(source, rollout()); await storage.protect(input()); return storage; };

test("a verified point resumes the original thread from a separate dirty active copy", async () => {
  await protect(); const original = await manifest();
  await unlink(source);
  const recovered = new CodexBotRecovery(options), active = await recovered.prepare(nativeSessionId, providerVersion);
  expect(active).toMatch(/active-.*\.jsonl$/); expect(await readFile(active!, "utf8")).toBe(rollout());
  expect(recovered.protectedThroughTurn).toBe(turn); expect((await manifest()).dirty).toBe(true);
  await appendFile(active!, JSON.stringify({ type: "event_msg", payload: { type: "thread_settings_applied", thread_settings: { model: "new" } } }) + "\n");
  expect(await readFile(join(options.directory, original.point.file), "utf8")).toBe(rollout());
  await recovered.protect({ ...input(), path: active! });
  expect((await manifest()).dirty).toBe(false);
  expect((await readdir(options.directory)).filter(name => name.startsWith("snapshot-"))).toHaveLength(1);
  const next = new CodexBotRecovery(options), nextActive = await next.prepare(nativeSessionId, providerVersion);
  expect(nextActive).not.toBe(active); expect((await readdir(options.directory)).filter(name => name.startsWith("active-"))).toHaveLength(1);
});

test("a pending first start cannot create a replacement thread after a restart", async () => {
  const storage = new CodexBotRecovery(options);
  expect(await storage.prepare(null, providerVersion)).toBeUndefined();
  await storage.markDirty();
  await expect(new CodexBotRecovery(options).prepare(null, providerVersion)).rejects.toMatchObject({ code: "outcome_unknown" });
  await writeFile(source, rollout(null)); await storage.protect(input(null));
  expect((await manifest()).point.protectedThroughTurn).toBeNull();
  await expect(new CodexBotRecovery(options).prepare(null, providerVersion)).rejects.toMatchObject({ code: "recovery_material_invalid" });
});

test("pending side effects cannot fall back to a previously completed turn", async () => {
  const storage = await protect(); await storage.markDirty();
  await expect(new CodexBotRecovery(options).prepare(nativeSessionId, providerVersion)).rejects.toMatchObject({ code: "outcome_unknown" });
  expect((await manifest()).point.protectedThroughTurn).toBe(turn);
});

test.each(["0.169.1", "0.168.0", "unknown"])("unverified native version %s never starts or rewrites storage", async value => {
  const storage = await protect(), before = await manifest();
  await expect(storage.prepare(nativeSessionId, value)).rejects.toMatchObject({ code: "recovery_version_unsupported" });
  expect(await manifest()).toEqual(before);
});

test.each(["thread", "bot", "owner", "service", "session", "cwd"])("recovery rejects mismatched %s identity", async field => {
  await protect(); const next = structuredClone(options);
  if (field === "bot") next.identity.botId = randomUUID();
  if (field === "owner") next.identity.ownerUserId = randomUUID();
  if (field === "service") next.identity.serverOrigin = "https://other.example";
  if (field === "session") next.identity.sessionId = randomUUID();
  if (field === "cwd") { next.cwd = join(root, "other"); await mkdir(next.cwd); }
  await expect(new CodexBotRecovery(next).prepare(field === "thread" ? randomUUID() : nativeSessionId, providerVersion)).rejects.toMatchObject({ code: "recovery_material_invalid" });
});

test.each(["snapshot", "manifest"])("missing %s reports absent recovery material", async field => {
  await protect(); const point = await manifest();
  await unlink(join(options.directory, field === "manifest" ? "manifest.json" : point.point.file));
  await expect(new CodexBotRecovery(options).prepare(nativeSessionId, providerVersion)).rejects.toMatchObject({ code: "recovery_material_missing" });
  if (field === "snapshot") expect(await manifest()).toEqual(point);
  expect((await readdir(options.directory)).some(name => name.startsWith("active-"))).toBe(false);
});

test("a valid JSONL with changed bytes still fails the immutable digest", async () => {
  await protect(); const point = await manifest();
  await appendFile(join(options.directory, point.point.file), JSON.stringify({ type: "event_msg", payload: { type: "thread_settings_applied", thread_settings: { model: "tampered" } } }) + "\n");
  await expect(new CodexBotRecovery(options).prepare(nativeSessionId, providerVersion)).rejects.toMatchObject({ code: "recovery_material_invalid" });
  expect(await manifest()).toEqual(point);
  expect((await readdir(options.directory)).some(name => name.startsWith("active-"))).toBe(false);
  await writeFile(join(options.directory, point.point.file), rollout());
  expect(await new CodexBotRecovery(options).prepare(nativeSessionId, providerVersion)).toMatch(/active-.*\.jsonl$/);
});

test.each(["partial", "wrong-turn", "active", "wrong-thread", "wrong-cwd", "invalid-json", "invalid-utf8"])("%s source cannot replace the last complete point", async mode => {
  const storage = await protect(), previous = await manifest();
  await storage.markDirty();
  if (mode === "partial") await appendFile(source, '{"type":');
  if (mode === "wrong-turn") await writeFile(source, rollout("another-turn"));
  if (mode === "active") await appendFile(source, JSON.stringify({ type: "event_msg", payload: { type: "task_started", turn_id: "next-turn" } }) + "\n");
  if (mode === "wrong-thread") await writeFile(source, rollout().replace(nativeSessionId, randomUUID()));
  if (mode === "wrong-cwd") await writeFile(source, rollout().replace(JSON.stringify(root), JSON.stringify(process.cwd())));
  if (mode === "invalid-json") await appendFile(source, "no-json\n");
  if (mode === "invalid-utf8") await appendFile(source, Buffer.from([0xff, 0x0a]));
  await expect(storage.protect(input())).rejects.toMatchObject({ code: ["partial", "wrong-turn", "active"].includes(mode) ? "recovery_material_incomplete" : "recovery_material_invalid" });
  expect((await manifest()).point).toEqual(previous.point); expect((await manifest()).dirty).toBe(true);
  expect((await readdir(options.directory)).filter(name => name.startsWith("snapshot-"))).toEqual([previous.point.file]);
});

test("the protected watermark cannot be cleared or assigned to another completed turn", async () => {
  const storage = await protect();
  await expect(storage.protect(input(null))).rejects.toMatchObject({ code: "recovery_material_invalid" });
  await expect(storage.protect(input("unknown-turn"))).rejects.toMatchObject({ code: "recovery_material_incomplete" });
  expect(storage.protectedThroughTurn).toBe(turn);
});

test("a complete compacted turn is protected independently of the preceding turn", async () => {
  const storage = await protect(); await storage.markDirty();
  const compact = [
    { type: "event_msg", payload: { type: "task_started", turn_id: "compact-turn" } },
    { type: "compacted", payload: { message: "summary", replacement_history: [] } },
    { type: "event_msg", payload: { type: "task_complete", turn_id: "compact-turn" } },
  ].map(item => JSON.stringify(item)).join("\n") + "\n";
  await appendFile(source, compact);
  await storage.protect(input("compact-turn"));
  expect(storage.protectedThroughTurn).toBe("compact-turn");
  const active = await new CodexBotRecovery(options).prepare(nativeSessionId, providerVersion);
  expect(await readFile(active!, "utf8")).toContain('"type":"compacted"');
});

test("a path escape in a manifest cannot read outside the Bot directory", async () => {
  await protect(); const value = await manifest(); value.point.file = "../original.jsonl";
  await writeFile(join(options.directory, "manifest.json"), JSON.stringify(value));
  await expect(new CodexBotRecovery(options).prepare(nativeSessionId, providerVersion)).rejects.toMatchObject({ code: "recovery_material_invalid" });
});

test("an unsupported manifest format preserves the existing recovery material", async () => {
  await protect(); const value = await manifest(); value.recoveryFormatVersion = 2;
  await writeFile(join(options.directory, "manifest.json"), JSON.stringify(value));
  await expect(new CodexBotRecovery(options).prepare(nativeSessionId, providerVersion)).rejects.toMatchObject({ code: "recovery_version_unsupported" });
  expect(await readFile(join(options.directory, value.point.file), "utf8")).toBe(rollout());
});

test("an unpersisted first rollout is retryable without publishing a point", async () => {
  const storage = new CodexBotRecovery(options); await storage.prepare(null, providerVersion); await storage.markDirty();
  await expect(storage.protect(input(null))).rejects.toMatchObject({ code: "recovery_material_incomplete", retryable: true });
  await writeFile(source, "");
  await expect(storage.protect(input(null))).rejects.toMatchObject({ code: "recovery_material_incomplete", retryable: true });
  expect((await manifest()).dirty).toBe(true); expect((await manifest()).point).toBeNull();
});

test.each([
  { type: "unknown_record", payload: {} },
  { type: "response_item", payload: { type: "function_call", name: "spawn_agent" } },
  { type: "response_item", payload: { type: "function_call", name: "functions.send_input" } },
  { type: "event_msg", payload: { type: "collab_waiting_begin" } },
  { type: "response_item", payload: { history_base: { thread: "other" } } },
  { type: "response_item", payload: { forked_from_id: "other" } },
  { type: "response_item", payload: { type: "message", content: [{ type: "input_image", image_url: "https://example.com/image.png" }] } },
  { type: "response_item", payload: { type: "message", content: [{ type: "local_image", path: "/outside.png" }] } },
])("unsupported native dependencies never publish a complete recovery point: %j", async record => {
  const storage = await protect(), old = await manifest(); await storage.markDirty();
  await appendFile(source, JSON.stringify(record) + "\n");
  await expect(storage.protect(input())).rejects.toMatchObject({ code: "recovery_material_invalid", retryable: false });
  expect((await manifest()).point).toEqual(old.point);
});

test("embedded images and initial configuration context need no external recovery file", async () => {
  const storage = new CodexBotRecovery(options);
  await writeFile(source, rollout(null) + JSON.stringify({ type: "turn_context", payload: { model: "selected" } }) + "\n");
  await storage.protect(input(null));
  await writeFile(source, rollout() + JSON.stringify({ type: "response_item", payload: { type: "message", content: [{ type: "input_image", image_url: "data:image/png;base64,AAAA" }] } }) + "\n");
  await storage.protect(input());
  expect(storage.protectedThroughTurn).toBe(turn);
});

test("only a matching settings record beginning after dispatch protects updated settings", async () => {
  const storage = await protect(), applied = (thread_id: string) => JSON.stringify({ type: "event_msg", payload: { type: "thread_settings_applied", thread_id, thread_settings: { model: "selected" } } }) + "\n";
  await appendFile(source, applied(nativeSessionId));
  const settingsAfter = (await readFile(source)).length;
  await storage.markDirty();
  await expect(storage.protect({ ...input(), settingsAfter })).rejects.toMatchObject({ retryable: true });
  await appendFile(source, applied(randomUUID()));
  await expect(storage.protect({ ...input(), settingsAfter })).rejects.toMatchObject({ retryable: true });
  await appendFile(source, applied(nativeSessionId));
  await storage.protect({ ...input(), settingsAfter });
  expect((await manifest()).dirty).toBe(false);
});

test("a durably aborted turn preserves its interruption and resumes the same thread", async () => {
  const storage = await protect(); await storage.markDirty();
  const aborted = [
    { type: "event_msg", payload: { type: "task_started", turn_id: "cancelled-turn" } },
    { type: "event_msg", payload: { type: "turn_aborted", turn_id: "cancelled-turn", reason: "interrupted" } },
  ].map(item => JSON.stringify(item)).join("\n") + "\n";
  await appendFile(source, aborted); await storage.protect(input("cancelled-turn"));
  expect(storage.protectedThroughTurn).toBe("cancelled-turn"); expect((await manifest()).dirty).toBe(false);
  const resumed = new CodexBotRecovery(options), active = await resumed.prepare(nativeSessionId, providerVersion);
  expect(resumed.protectedThroughTurn).toBe("cancelled-turn");
  expect(await readFile(active!, "utf8")).toContain('"type":"turn_aborted"');
});

test.each(["missing-id", "empty-id", "partial", "error-only"])("%s interruption evidence cannot clear the pending operation", async mode => {
  const storage = await protect(), old = await manifest(); await storage.markDirty();
  await appendFile(source, JSON.stringify({ type: "event_msg", payload: { type: "task_started", turn_id: "cancelled-turn" } }) + "\n");
  const payload = mode === "error-only" ? { type: "error", message: "cancel requested", turn_id: "cancelled-turn" }
    : { type: "turn_aborted", ...(mode === "missing-id" ? {} : { turn_id: mode === "empty-id" ? "" : "cancelled-turn" }), reason: "interrupted" };
  await appendFile(source, JSON.stringify({ type: "event_msg", payload }) + (mode === "partial" ? "" : "\n"));
  await expect(storage.protect(input("cancelled-turn"))).rejects.toMatchObject({ code: "recovery_material_incomplete", retryable: true });
  expect((await manifest()).dirty).toBe(true); expect((await manifest()).point).toEqual(old.point);
});

test("embedded world state, tool schemas and usage records do not become native dependencies", async () => {
  const storage = await protect();
  const records = [
    { type: "world_state", payload: { full: true, state: {
      agents_md: { body: "Use the project conventions." }, model: { model: "selected", instructions: "Instructions." },
      tools: [{ type: "function", name: "spawn_agent", parameters: { type: "object", properties: {
        history_base: { type: "string" }, image_url: { type: "string" }, subagent: { type: "boolean" },
      }, examples: [{ type: "function_call", name: "spawn_agent" }] } }],
      environments: { environments: { local: { cwd: root, shell: "powershell", status: "available" } } },
    } } },
    { type: "token_usage_record", payload: { thread_id: nativeSessionId, turn_id: turn, session_id: nativeSessionId,
      usage: { input_tokens: 120, cached_input_tokens: 10, output_tokens: 20, total_tokens: 140 },
      turn_token_usage: { input_tokens: 120, output_tokens: 20, total_tokens: 140 },
      thread_token_usage: { input_tokens: 120, output_tokens: 20, total_tokens: 140 },
    } },
    { type: "response_item", payload: { type: "function_call_output", call_id: "arbitrary-result", output: {
      history_base: { type: "function_call", name: "spawn_agent" }, image_url: "ordinary user JSON", subagent: true,
    } } },
  ];
  await appendFile(source, records.map(item => JSON.stringify(item)).join("\n") + "\n");
  await storage.protect(input());
  const active = await new CodexBotRecovery(options).prepare(nativeSessionId, providerVersion);
  expect(await readFile(active!, "utf8")).toContain('"type":"world_state"');
  expect(await readFile(active!, "utf8")).toContain('"type":"token_usage_record"');
});

test("compacted native calls still retain their external thread dependency", async () => {
  const storage = await protect();
  await appendFile(source, JSON.stringify({ type: "compacted", payload: { replacement_history: [{ type: "function_call", name: "spawn_agent", arguments: "{}" }] } }) + "\n");
  await expect(storage.protect(input())).rejects.toMatchObject({ code: "recovery_material_invalid", retryable: false });
});

test("capture preserves complete UTF-8 records spanning multiple IO chunks", async () => {
  const storage = await protect();
  await appendFile(source, JSON.stringify({ type: "response_item", payload: { type: "message", content: [{ type: "output_text", text: "中文🌙".repeat(14_000) }] } }) + "\n");
  await storage.protect(input());
  const active = await new CodexBotRecovery(options).prepare(nativeSessionId, providerVersion);
  expect(await readFile(active!)).toEqual(await readFile(source));
});
