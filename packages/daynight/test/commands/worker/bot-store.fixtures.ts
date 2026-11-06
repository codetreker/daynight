import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { vi } from "vitest";
import type { SqliteDatabaseSource } from "../../../src/platform/sqlite-access.js";
import { openBotStore } from "../../../src/commands/worker/bots/store.js";
import type { Bot, BotOwner } from "../../../src/commands/worker/bots/types.js";

export const root = fileURLToPath(new URL("../../../../../.tmp/bot-store-tests/", import.meta.url));
export const dirs: string[] = [];
export const handles: { close(): void }[] = [];
export const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const owner: BotOwner = { serverOrigin: "https://daynight.example", ownerUserId: id(1), workerId: id(2) };
export const bot = (): Bot => ({ id: id(3), workerId: owner.workerId, version: "1", deletion: null, ownerUserId: owner.ownerUserId, name: "Assistant", creationOrder: "1", requestedOverrides: {}, resolvedConfiguration: { workerId: owner.workerId, cwd: root, provider: "codex", model: null, args: [] }, roleConfiguration: null, sessionId: null, testExecutionId: null, startupResult: { state: "pending", code: null }, createdAt: "2026-11-04T00:00:00Z", updatedAt: "2026-11-04T00:00:00Z" });
export const createBotStoreFixture = <T extends SqliteDatabaseSource>(source: (home: string) => T) => {
  mkdirSync(root, { recursive: true }); const home = mkdtempSync(path.join(root, "case-")); dirs.push(home);
  const database = source(home);
  const open = () => { const store = openBotStore(database, { onMigration: () => {} }); handles.push(store); return store; };
  return { home, database, open, store: open() };
};
export const cleanupBotStores = () => { vi.restoreAllMocks(); for (const handle of handles.splice(0)) handle.close(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); };
