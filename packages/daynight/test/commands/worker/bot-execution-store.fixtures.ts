import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { vi } from "vitest";
import type { SqliteDatabaseSource } from "../../../src/platform/sqlite-access.js";
import { openBotExecutionStore } from "../../../src/commands/worker/bots/execution-store.js";
import { openBotStore } from "../../../src/commands/worker/bots/store.js";
import type { BotDefinition, BotOwner, BotRecord } from "../../../src/commands/worker/bots/types.js";
import type { ControllerSnapshot } from "../../../src/commands/controller/lifecycle-store.js";
import type { ProcessProof } from "../../../src/commands/controller/process-proof.js";

import { frozenToolLaunch } from "../../helpers/tool-launch.js";

export const root = fileURLToPath(new URL("../../../../../.tmp/bot-execution-store-tests/", import.meta.url));
export const dirs: string[] = [], handles: { close(): void }[] = [];
export const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const owner: BotOwner = { serverOrigin: "https://daynight.example", ownerUserId: id(1), workerId: id(2) };
export const definition = (): BotDefinition => ({ id: id(3), workerId: owner.workerId, version: "1", deletion: null, ownerUserId: owner.ownerUserId, name: "Assistant", creationOrder: "1", requestedOverrides: {}, resolvedConfiguration: { workerId: owner.workerId, cwd: root, provider: "codex", model: null, args: [] }, roleConfiguration: null, sessionId: null, testExecutionId: null, startupResult: { state: "pending", code: null }, createdAt: "2026-11-04T00:00:00Z", updatedAt: "2026-11-04T00:00:00Z" });
export const proof: ProcessProof = { pid: 123, parentPid: 12, processGroupId: 123, startedAt: "Wed Nov 4 12:00:00 2026", commandHash: "a".repeat(64) };
export const createBotExecutionFixture = <T extends SqliteDatabaseSource>(source: (home: string) => T) => {
  mkdirSync(root, { recursive: true }); const home = mkdtempSync(path.join(root, "case-")); dirs.push(home);
  const database = source(home), bots = openBotStore(database, { onMigration: () => {} }); handles.push(bots);
  bots.observe(owner, definition(), 1); bots.prepare(owner, id(3), { homeDirectory: home, recoveryLimit: 3, toolLaunch: frozenToolLaunch() });
  const intent = bots.get(owner, id(3))!.intent!;
  bots.observe(owner, { ...definition(), version: "2", sessionId: id(10), testExecutionId: intent.executionId }, 2);
  const record = bots.get(owner, id(3))!;
  const open = () => { const store = openBotExecutionStore(database, { onMigration: () => {} }); handles.push(store); return store; };
  return { home, database, bots, record, open, store: open() };
};
export const snapshot = (record: BotRecord): ControllerSnapshot => ({ executionId: record.intent!.executionId, testExecutionId: record.intent!.executionId, sessionId: record.intent!.sessionId!, executionGeneration: record.intent!.executionGeneration, controllerInstanceId: record.intent!.controllerInstanceId, lifecycle: "ready", nativeSessionId: id(20), initialInputState: "not_required", activity: "idle", currentTurnId: null, capabilities: { send: true, steer: false, cancel: false, respond: false }, controllerProcess: proof, nativeProcesses: [], nativeStopped: false, stoppedAt: null, error: null });
export const cleanupBotExecutions = () => { vi.restoreAllMocks(); for (const handle of handles.splice(0)) handle.close(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); };

export const stopped = (record: BotRecord): ControllerSnapshot => ({ ...snapshot(record), lifecycle: "stopped", activity: "stopped", nativeStopped: true, stoppedAt: "2026-11-05T00:00:00Z" });
export const submitted = (f: Pick<ReturnType<typeof createBotExecutionFixture>, "store" | "record" | "home">, record = f.record): void => {
  f.store.prepare(record);
  f.store.update(record, { launchSubmission: "acknowledged", controllerProcess: proof, snapshot: snapshot(record), aliasDirectory: path.join(f.home, `aliases-${record.intent!.executionGeneration}`) });
};
