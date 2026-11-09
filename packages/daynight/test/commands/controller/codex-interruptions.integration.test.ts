import { textNativeInput } from "../../../src/commands/controller/providers/native-input.js";
import { expect, test, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { openControllerLifecycleStore } from "../../../src/commands/controller/lifecycle-store.js";
import type { ControllerLaunchTicket } from "../../../src/commands/controller/launch-ticket.js";
import { fileURLToPath } from "node:url";
import { openCodexProvider } from "../../../src/commands/controller/providers/codex.js";
import type { ProviderEntry } from "../../../src/commands/controller/providers/types.js";

const open = async (scenario: string, resumed = false, journal?: { hasTimelineEntry(id: string): boolean; projectTimeline(entry: ProviderEntry): unknown }) => {
  const entries: ProviderEntry[] = [], observed: string[] = [];
  let child!: ChildProcess;
  const provider = await openCodexProvider({ cwd: process.cwd(), model: null, args: [], resumeNativeSessionId: resumed ? "native-thread" : null,
    executable: fileURLToPath(new URL("./fixtures/codex-native.mjs", import.meta.url)), env: { ...process.env, CODEX_TEST_INTERRUPT: scenario },
    ...(journal ? { hasTimelineEntry: (id: string) => journal.hasTimelineEntry(id) } : {}),
    onTimeline: entry => { entries.push(entry); journal?.projectTimeline(entry); }, onInputObserved: id => observed.push(typeof id === "string" ? id : id.operationId), onState: () => {}, onSpawn: value => { child = value; } });
  return { provider, entries, observed, child };
};
const rows = (entries: readonly ProviderEntry[]) => [...new Map(entries.map(entry => [entry.entryId, entry])).values()];
const markers = (entries: readonly ProviderEntry[]) => rows(entries).filter(entry => entry.kind === "error" && entry.code === "turn_interrupted");

test.each(["history-user", "history-read-failure", "ack-first"])("%s input keeps one durable row across a new provider and journal instance", async scenario => {
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp/controller-tests");
  await mkdir(base, { recursive: true });
  const home = await mkdtemp(path.join(base, "codex-interrupt-"));
  const ticket: ControllerLaunchTicket = { schemaVersion: 1, launchId: randomUUID(), executionId: randomUUID(), controllerId: randomUUID(), controllerInstanceId: randomUUID(), sessionId: randomUUID(), executionGeneration: "1", serverOrigin: "https://daynight.example", projectId: randomUUID(), taskId: randomUUID(), claimId: randomUUID(), workerId: randomUUID(), worktreeId: randomUUID(), userId: randomUUID(), provider: "codex", cwd: home, nativeHome: path.join(home, ".codex"), configuration: { agent: "codex", agentControlMode: "web", model: null, args: [], recoveryLimit: 2 }, initialOperationId: randomUUID(), initialPrompt: "test", resumeNativeSessionId: null, credentialFile: path.join(home, "grant.json"), ipcEndpoint: path.join(home, "c.sock"), ipcSecret: "a".repeat(64), createdAt: new Date().toISOString() };
  const filename = path.join(home, "state.sqlite"), historyEpoch = randomUUID();
  let journal = openControllerLifecycleStore(filename, ticket, { contentOwnedLocally: true });
  const stored = () => journal.readTimeline({ historyEpoch, direction: "tail", cursor: null, limit: 100 }).items;
  const hooks = { hasTimelineEntry: (id: string) => journal.hasTimelineEntry(id), projectTimeline: (entry: ProviderEntry) => journal.projectTimeline(entry) };
  try {
    const live = await open(scenario, false, hooks);
    try {
      const sent = await live.provider.send(textNativeInput("cancel"), "11111111-1111-4111-8111-111111111111", null);
      await live.provider.cancel(sent.turnId!);
      if (scenario === "history-user") await vi.waitFor(() => expect(live.observed).toContain("11111111-1111-4111-8111-111111111111"));
      if (scenario === "history-read-failure") await vi.waitFor(() => expect(live.entries.some(entry => entry.kind === "error" && entry.code === "native_input_missing")).toBe(true));
    } finally { await live.provider.close(); }
    const originalUser = stored().find(entry => entry.kind === "user_message")!;
    journal.close(); journal = openControllerLifecycleStore(filename, ticket, { contentOwnedLocally: true });
    const restored = await open("history-user", true, hooks);
    await restored.provider.close();
    const users = stored().filter(entry => entry.kind === "user_message");
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({ entryId: originalUser.entryId, entrySeq: originalUser.entrySeq, content: [{ type: "text", text: "cancel" }] });
    expect(markers(stored())).toHaveLength(1);
  } finally { journal.close(); await rm(home, { recursive: true, force: true }); }
});
