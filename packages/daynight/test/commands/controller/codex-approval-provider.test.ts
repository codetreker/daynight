import { test, expect, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { openCodexProvider } from "../../../src/commands/controller/providers/codex.js";
import type { ProviderEntry } from "../../../src/commands/controller/providers/types.js";
import type { SessionInteraction } from "../../../src/session/protocol.js";

const fileMethod = "item/fileChange/requestApproval";
const fileItem = { type: "fileChange", id: "patch", status: "inProgress", changes: [{ path: "notes/hello.txt", kind: { type: "update", move_path: null }, diff: "-hello\n+hello from phone" }] };
const event = (overrides = {}, method = "item/started") => ({ method, params: { threadId: "native-thread", turnId: "native-turn", item: fileItem, ...overrides } });

async function open(cases: Record<string, unknown>) {
  const entries: ProviderEntry[] = [];
  const provider = await openCodexProvider({ cwd: process.cwd(), model: null, args: [], resumeNativeSessionId: null,
    executable: fileURLToPath(new URL("./fixtures/codex-native.mjs", import.meta.url)),
    env: { ...process.env, CODEX_TEST_APPROVAL_CASES: JSON.stringify(cases) }, onTimeline: e => entries.push(e), onState: () => {}, onSpawn: () => {} });
  const send = async (text: string): Promise<SessionInteraction> => {
    const start = entries.length;
    await provider.send(text, randomUUID(), null);
    await vi.waitFor(() => expect(entries.slice(start).some(e => e.kind === "interaction")).toBe(true));
    const entry = entries.slice(start).find(e => e.kind === "interaction");
    if (!entry || entry.kind !== "interaction") throw new Error("Missing approval");
    return entry.interaction;
  };
  return { provider, entries, send };
}

test("command approval keeps the native shell command first and preserves rejection", async () => {
  const command = "/bin/zsh -lc 'date'";
  const { provider, entries, send } = await open({ command: { method: "item/commandExecution/requestApproval", params: { command, cwd: "/workspace", reason: "Read the current date", availableDecisions: ["accept", "cancel"] } } });
  try {
    const card = await send("command");
    expect(card).toMatchObject({ title: "Approve command", detail: `${command}\ncwd: /workspace\nRead the current date`, actions: ["allow_once", "reject"] });
    await provider.respond(card.interactionId, "1", { kind: "approval", action: "reject" });
    expect(entries).toContainEqual(expect.objectContaining({ kind: "assistant_message", content: [{ type: "text", text: "native-decision:cancel" }] }));
  } finally { await provider.close(); }
});

test.each(["allow_once", "allow_session", "reject"] as const)("file approval uses the matching live item and preserves %s", async action => {
  const { provider, entries, send } = await open({ file: { method: fileMethod, events: [event()], params: { reason: "Update the greeting" } } });
  try {
    const card = await send("file");
    expect(card).toMatchObject({ title: "Approve file changes", actions: ["allow_once", "allow_session", "reject"] });
    expect(card.kind === "approval" && card.detail).toContain("notes/hello.txt");
    expect(card.kind === "approval" && card.detail).toContain("+hello from phone");
    expect(card.kind === "approval" && card.detail).not.toMatch(/threadId|turnId|itemId|startedAtMs|availableDecisions/);
    await provider.respond(card.interactionId, "1", { kind: "approval", action });
    expect(entries).toContainEqual(expect.objectContaining({ kind: "assistant_message", content: [{ type: "text", text: `native-decision:${action === "allow_once" ? "accept" : action === "allow_session" ? "acceptForSession" : "decline"}` }] }));
    expect(entries.filter(e => e.kind === "interaction").at(-1)).toMatchObject({ interaction: { state: "resolved" } });
  } finally { await provider.close(); }
});

test.each([
  [event({ threadId: "other-thread" })],
  [event({ turnId: "other-turn" })],
  [event({ item: { ...fileItem, id: "other-item" } })],
  [event(), event({}, "item/completed")],
  [event({ threadId: undefined })],
])("file approvals never use unrelated or completed item data: %j", async (...events) => {
  const { provider, send } = await open({ file: { method: fileMethod, events, params: { reason: "Native explanation" } } });
  try {
    const card = await send("file");
    expect(card).toMatchObject({ detail: "Native explanation" });
  } finally { await provider.close(); }
});

test("turn completion discards approval display context even when native item completion is absent", async () => {
  const { provider, send } = await open({ first: { method: fileMethod, events: [event()], params: { reason: "First request" } }, second: { method: fileMethod, params: { reason: "Second request" } } });
  try {
    const first = await send("first");
    expect(first.kind === "approval" && first.detail).toContain("notes/hello.txt");
    await provider.respond(first.interactionId, "1", { kind: "approval", action: "reject" });
    await provider.waitForTurn("native-turn", Date.now() + 1000);
    expect(await send("second")).toMatchObject({ detail: "Second request" });
  } finally { await provider.close(); }
});
