import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { openLocalBotStores } from "../../../src/commands/worker/bots/local-store.js";
import { openBotStore } from "../../../src/commands/worker/bots/store.js";
import { resolveWorkerPaths } from "../../../src/commands/worker/paths.js";
import { resolveBotPaths } from "../../../src/commands/worker/bots/paths.js";
import { inspectLocalBotDeletion, recoverLocalBotDeletion } from "../../../src/commands/worker/bots/deletion-local.js";
import { acquireInstanceLockSync } from "../../../src/platform/instance-lock.js";
import type { BotDefinition, BotDeleted } from "../../../src/commands/worker/bots/types.js";
import type { BotDeletionRecovery } from "../../../src/commands/bot/deletion-api.js";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const cleanups: (() => void)[] = [];
afterEach(() => { vi.unstubAllGlobals(); for (const close of cleanups.splice(0).reverse()) close(); vi.unstubAllEnvs(); });
const fixture = (evidence: "retained" | "missing" = "retained") => {
  const root = path.resolve(import.meta.dirname, "../../../../../.tmp/bot-deletion-local"); mkdirSync(root, { recursive: true });
  const homeDirectory = mkdtempSync(path.join(root, "case-")); cleanups.push(() => rmSync(homeDirectory, { recursive: true, force: true }));
  vi.stubEnv("DN_CONFIG_DIR", path.join(homeDirectory, "state"));
  const paths = resolveWorkerPaths(homeDirectory);
  mkdirSync(paths.workerDirectory, { recursive: true, mode: 0o700 });
  writeFileSync(paths.configFile, `workerId: ${id(2)}\n`, { mode: 0o600 });
  openBotStore(paths.databaseFile, { onMigration: () => {} }).close();
  const owner = { serverOrigin: "https://fixture.example", ownerUserId: id(1), workerId: id(2) };
  const stores = openLocalBotStores({ owner, stateDirectory: paths.stateDirectory, legacyDatabaseFile: paths.databaseFile, onMigration: () => {} });
  cleanups.push(() => stores.close());
  const definition: BotDefinition = { id: id(3), workerId: id(2), ownerUserId: id(1), version: "1", creationOrder: "1", name: "Assistant", requestedOverrides: {}, resolvedConfiguration: { workerId: id(2), cwd: homeDirectory, provider: "codex", model: null, args: [] }, roleConfiguration: null, sessionId: null, testExecutionId: null, startupResult: { state: "pending", code: null }, deletion: null, createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z" };
  stores.store.observe(owner, definition, 1);
  let binding: BotDeletionRecovery["originalBinding"] = { sessionId: id(4), testExecutionId: id(5), executionGeneration: "1", controllerId: id(6), controllerInstanceId: id(7) };
  if (evidence === "retained") {
    const intent = stores.store.prepare(owner, id(3), { homeDirectory, recoveryLimit: 0 });
    stores.store.observe(owner, { ...definition, version: "2", sessionId: id(4), testExecutionId: intent.executionId }, 2);
    stores.executions.prepare(stores.store.get(owner, id(3))!);
    binding = { sessionId: id(4), testExecutionId: intent.executionId, executionGeneration: "1", controllerId: intent.registration.controllerId, controllerInstanceId: intent.controllerInstanceId };
  }
  const bot: BotDeleted = { id: id(3), workerId: id(2), version: "4", deletion: { deletionId: id(8), requestedVersion: "3", workerCleanup: { state: "failed", code: "execution_evidence_missing" }, serverCleanup: { state: "pending", code: null } } };
  stores.store.observe(owner, bot, 3);
  const recovery: BotDeletionRecovery = { schemaVersion: 1, botId: id(3), workerId: id(2), hostingWorkerId: id(2), version: "4", deletionId: id(8), requestedVersion: "3", requiresStopProof: true, recoveryRequired: true, originalBinding: binding, workerCleanup: { state: "failed", code: "execution_evidence_missing" }, decision: null, serverCleanup: { state: "pending", code: null } };
  stores.close();
  const input = { homeDirectory, packageDirectory: path.resolve(import.meta.dirname, "../../../"), workingDirectory: homeDirectory,
    serverUrl: owner.serverOrigin, ownerUserId: owner.ownerUserId, serverToken: "fixture-token", botId: id(3), recovery, signal: new AbortController().signal };
  return { paths, stores, owner, bot, recovery, input };
};

test("readonly inspection identifies retained evidence without claiming the original writer stopped", async () => {
  const f = fixture(), file = resolveBotPaths(f.paths.stateDirectory, id(3)).databaseFile;
  const before = readFileSync(file);
  expect(await inspectLocalBotDeletion(f.input)).toMatchObject({ originalWorkerMatched: true, hostingWorkerMatched: true,
    storage: "available", evidence: "retained", canRecover: true, localProcessState: "unverified",
    checks: { bindingMatched: true, launchIntentPresent: true, journalPresent: false, ticketPresent: false } });
  expect(readFileSync(file)).toEqual(before);
  expect(existsSync(f.paths.lockFile)).toBe(false);
});

test("missing records and a forged binding cannot become local stop evidence", async () => {
  const missing = fixture("missing");
  expect(await inspectLocalBotDeletion(missing.input)).toMatchObject({ evidence: "missing", canRecover: false, localProcessState: "unverified" });
  await expect(recoverLocalBotDeletion(missing.input)).rejects.toMatchObject({ code: "evidence_missing" });
  const retained = fixture();
  expect(await inspectLocalBotDeletion({ ...retained.input, recovery: { ...retained.recovery, originalBinding: { ...retained.recovery.originalBinding!, controllerId: id(99) } } })).toMatchObject({ storage: "unreadable", canRecover: false });
});

test("inspection distinguishes original record ownership from current hosting machine", async () => {
  const f = fixture();
  writeFileSync(f.paths.configFile, `workerId: ${id(20)}\n`);
  const recovery = { ...f.recovery, hostingWorkerId: id(20) };
  expect(await inspectLocalBotDeletion({ ...f.input, recovery })).toMatchObject({ workerId: id(2), hostingWorkerId: id(20),
    originalWorkerMatched: false, hostingWorkerMatched: true, storage: "available", evidence: "retained" });
  expect(await inspectLocalBotDeletion(f.input)).toMatchObject({ hostingWorkerMatched: false, canRecover: false });
});

test("recovery refuses a live Worker lock without touching the server or original owner", async () => {
  const f = fixture(), lock = acquireInstanceLockSync(f.paths.lockFile, f.paths.databaseFile);
  cleanups.push(() => lock.release());
  const before = readFileSync(f.paths.lockFile), fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  await expect(recoverLocalBotDeletion(f.input)).rejects.toMatchObject({ code: "worker_running", receiptConfirmed: false });
  expect(readFileSync(f.paths.lockFile)).toEqual(before); expect(fetch).not.toHaveBeenCalled();
});

test("explicit local recovery reuses the real never-started proof protocol and retains its exact receipt", async () => {
  const f = fixture(), receipts: unknown[] = [];
  let current = f.bot;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    let body: unknown;
    if (init.method === "POST") {
      const receipt = JSON.parse(init.body as string); receipts.push(receipt);
      current = { ...current, version: "5", deletion: { ...current.deletion, workerCleanup: receipt.result, serverCleanup: { state: "completed", code: null } } };
      body = current;
    } else body = url.endsWith("/deletion-recovery") ? f.recovery : current;
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json", "Daynight-User-ID": id(1) } });
  }));
  await expect(recoverLocalBotDeletion(f.input)).resolves.toEqual({ receiptConfirmed: true });
  expect(receipts).toEqual([expect.objectContaining({ deletionId: id(8), result: { state: "completed", code: null },
    stop: expect.objectContaining({ ...f.recovery.originalBinding, stopProof: expect.objectContaining({ kind: "never_started" }) }) })]);
  expect(existsSync(f.paths.lockFile)).toBe(false);
  const local = openLocalBotStores({ owner: f.owner, stateDirectory: f.paths.stateDirectory, legacyDatabaseFile: f.paths.databaseFile });
  try { expect(local.store.get(f.owner, id(3))).toMatchObject({ intent: null, definition: null, cleanup: { localCompleted: true, stop: expect.objectContaining(f.recovery.originalBinding!) } }); }
  finally { local.close(); }
});
