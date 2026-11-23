import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import Database from "better-sqlite3";
import { ApiError } from "../../../src/api/client.js";
import { afterEach, expect, test, vi } from "vitest";
import { openLocalBotStores } from "../../../src/commands/worker/bots/local-store.js";
import { openBotStore } from "../../../src/commands/worker/bots/store.js";
import { resolveWorkerPaths } from "../../../src/commands/worker/paths.js";
import { resolveBotPaths } from "../../../src/commands/worker/bots/paths.js";
import { recoverLocalBotDeletion } from "../../../src/commands/worker/bots/deletion-local.js";
import { acquireInstanceLockSync } from "../../../src/platform/instance-lock.js";
import type { BotDefinition, BotDeleted } from "../../../src/commands/worker/bots/types.js";
import * as botProcess from "../../../src/commands/worker/bots/process.js";
import { openBotRecoveryStore } from "../../../src/commands/worker/bots/recovery-store.js";
import * as deletionFiles from "../../../src/commands/worker/bots/delete-files.js";
import type { BotRecord } from "../../../src/commands/worker/bots/types.js";
import type { BotDeletionStop } from "../../../src/commands/worker/bots/session-api.js";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const cleanups: (() => void)[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); for (const close of cleanups.splice(0).reverse()) close(); vi.unstubAllEnvs(); });
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
  let binding = { sessionId: id(4), testExecutionId: id(5), executionGeneration: "1", controllerId: id(6), controllerInstanceId: id(7) };
  if (evidence === "retained") {
    const intent = stores.store.prepare(owner, id(3), { homeDirectory, recoveryLimit: 0 });
    stores.store.observe(owner, { ...definition, version: "2", sessionId: id(4), testExecutionId: intent.executionId }, 2);
    stores.executions.prepare(stores.store.get(owner, id(3))!);
    binding = { sessionId: id(4), testExecutionId: intent.executionId, executionGeneration: "1", controllerId: intent.registration.controllerId, controllerInstanceId: intent.controllerInstanceId };
  }
  const bot: BotDeleted = { id: id(3), workerId: id(2), version: "4", deletion: { deletionId: id(8), requestedVersion: "3", workerCleanup: { state: "failed", code: "execution_evidence_missing" }, serverCleanup: { state: "pending", code: null } } };
  stores.store.observe(owner, bot, 3);
  stores.close();
  const input = { homeDirectory, packageDirectory: path.resolve(import.meta.dirname, "../../../"), workingDirectory: homeDirectory,
    serverUrl: owner.serverOrigin, ownerUserId: owner.ownerUserId, serverToken: "fixture-token", botId: id(3), bot, signal: new AbortController().signal };
  return { paths, stores, owner, bot, binding, input };
};
const stoppedProof = (record: BotRecord): BotDeletionStop => ({ protocol: "daynight.session.v1", sessionId: record.intent!.sessionId!,
  testExecutionId: record.intent!.executionId, executionGeneration: record.intent!.executionGeneration,
  controllerId: record.intent!.registration.controllerId, controllerInstanceId: record.intent!.controllerInstanceId,
  stopProof: { recordId: record.intent!.launchId, previousControllerInstanceId: record.intent!.controllerInstanceId, stoppedAt: "2026-11-23T00:00:00Z" } });

const hostedCleanup = async (f: ReturnType<typeof fixture>) => {
  const owner = { ...f.owner, workerId: id(20) }, paths = resolveBotPaths(f.paths.stateDirectory, id(3));
  writeFileSync(f.paths.configFile, `workerId: ${owner.workerId}\n`);
  const local = openLocalBotStores({ owner, stateDirectory: f.paths.stateDirectory, legacyDatabaseFile: f.paths.databaseFile });
  try {
    const record = local.store.get(f.owner, id(3))!, stop = stoppedProof(record);
    const recovery = openBotRecoveryStore({ owner, stateDirectory: f.paths.stateDirectory, assertLocked: local.assertLocked });
    const identity = { botRecoveryVersion: 1 as const, serviceOrigin: owner.serverOrigin, recoveryIdentity: recovery.ensureIdentity(record).recoveryIdentity };
    const binding = { sessionId: stop.sessionId, testExecutionId: stop.testExecutionId, nativeSessionId: null };
    recovery.prepare(record, { kind: "register", workerId: id(2), body: { ...identity, ...binding, operationId: id(90), botVersion: "2" } });
    const receipt = { botRecoveryVersion: 1 as const, operationId: id(90), kind: "register" as const, workerId: id(2), hostingGeneration: "1", botVersion: "3",
      ...binding, executionGeneration: stop.executionGeneration, controllerId: stop.controllerId, controllerInstanceId: stop.controllerInstanceId, grantExpiresAt: null, controllerTokenHash: null };
    recovery.recordResult(record, id(90), { current: true, receipt }); recovery.finishOperation(record, id(90));
    const token = `dncontroller_${Buffer.alloc(32, 1).toString("base64url")}`;
    recovery.prepare(record, { kind: "takeover", workerId: owner.workerId, body: { ...identity, ...binding, operationId: id(91), expectedHostingGeneration: "1", controllerToken: token,
      grant: { protocol: "daynight.session.v1", testExecutionId: stop.testExecutionId, controllerId: stop.controllerId, controllerInstanceId: stop.controllerInstanceId,
        executionGeneration: stop.executionGeneration, kind: "reconnect", previousGeneration: null, stopProof: null } } });
    recovery.recordResult(record, id(91), { current: true, receipt: { ...receipt, operationId: id(91), kind: "takeover", workerId: owner.workerId, hostingGeneration: "2",
      grantExpiresAt: "2099-01-01T00:00:00Z", controllerTokenHash: createHash("sha256").update(token).digest("hex") } }); recovery.finishOperation(record, id(91));
    mkdirSync(paths.codexRecoveryDirectory, { recursive: true, mode: 0o700 }); writeFileSync(path.join(paths.codexRecoveryDirectory, "private"), "private recovery data");
    mkdirSync(path.dirname(record.intent!.journalPath), { recursive: true, mode: 0o700 }); writeFileSync(record.intent!.journalPath, "original stopped journal");
    const targets = await deletionFiles.captureBotDeletionFiles(f.input.homeDirectory, record, local.executions.get(record), f.input.signal);
    local.store.prepareDeletion(record, stop, targets);
    return { owner, stop, paths, recoveryFile: path.join(paths.directory, "recovery.json") };
  } finally { local.close(); }
};

test("missing records cannot become local stop evidence or create replacement storage", async () => {
  const missing = fixture("missing");
  const file = resolveBotPaths(missing.paths.stateDirectory, id(3)).databaseFile, before = readFileSync(file);
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  await expect(recoverLocalBotDeletion(missing.input)).rejects.toMatchObject({ code: "evidence_missing" });
  expect(fetch).not.toHaveBeenCalled(); expect(readFileSync(file)).toEqual(before); expect(existsSync(missing.paths.lockFile)).toBe(false);
});

test("a different machine needs its original confirmed hosting receipt before process control", async () => {
  const f = fixture();
  writeFileSync(f.paths.configFile, `workerId: ${id(20)}\n`);
  const create = vi.spyOn(botProcess, "createBotProcess");
  const fetch = vi.fn(async () => new Response(JSON.stringify(f.bot), { headers: { "Content-Type": "application/json", "Daynight-User-ID": id(1) } })); vi.stubGlobal("fetch", fetch);
  await expect(recoverLocalBotDeletion(f.input)).rejects.toMatchObject({ code: "wrong_worker" });
  expect(create).not.toHaveBeenCalled(); expect(fetch).toHaveBeenCalledOnce(); expect(existsSync(f.paths.lockFile)).toBe(false);
});

test.each([["pending", false], ["stale", false], ["pending", true], ["stale", true]] as const)("retained %s hosting authority prevents local process control with never-started=%s", async (status, neverStarted) => {
  const f = fixture(), local = openLocalBotStores({ owner: f.owner, stateDirectory: f.paths.stateDirectory, legacyDatabaseFile: f.paths.databaseFile });
  try {
    const record = local.store.get(f.owner, id(3))!;
    const recovery = openBotRecoveryStore({ owner: f.owner, stateDirectory: f.paths.stateDirectory, assertLocked: local.assertLocked });
    const identity = recovery.ensureIdentity(record);
    recovery.prepare(record, { kind: "register", workerId: id(2), body: { botRecoveryVersion: 1, serviceOrigin: f.owner.serverOrigin,
      recoveryIdentity: identity.recoveryIdentity, operationId: id(90), botVersion: "2", sessionId: f.binding.sessionId,
      testExecutionId: f.binding.testExecutionId, nativeSessionId: null } });
    if (status === "stale") {
      recovery.recordResult(record, id(90), { current: false, receipt: { botRecoveryVersion: 1, operationId: id(90), kind: "register", workerId: id(2),
        hostingGeneration: "1", botVersion: "3", ...f.binding, nativeSessionId: null, grantExpiresAt: null, controllerTokenHash: null } });
      recovery.finishOperation(record, id(90));
    }
    const stop = stoppedProof(record);
    if (neverStarted) stop.stopProof.kind = "never_started";
    const cleanup = local.store.prepareDeletion(record, stop, []);
    local.store.bindDeletionWorker(cleanup, f.owner.workerId);
  } finally { local.close(); }
  const create = vi.spyOn(botProcess, "createBotProcess");
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(f.bot), { headers: { "Content-Type": "application/json", "Daynight-User-ID": id(1) } })));
  await expect(recoverLocalBotDeletion(f.input)).rejects.toMatchObject({ code: "wrong_worker" });
  expect(create).not.toHaveBeenCalled(); expect(existsSync(f.paths.lockFile)).toBe(false);
}, 15_000);

test.each(["private removal", "completion transport"])("a takeover resumes its stamped stopped cleanup after %s failure removes hosting evidence", async failure => {
  const f = fixture(), hosted = await hostedCleanup(f), remove = deletionFiles.removeBotDeletionFile;
  const receipts: unknown[] = [];
  let fail = true, current = f.bot;
  const readSaved = () => {
    const db = new Database(hosted.paths.databaseFile, { readonly: true });
    try { return JSON.parse((db.prepare("SELECT record FROM bots").get() as { record: string }).record) as BotRecord; }
    finally { db.close(); }
  };
  vi.spyOn(deletionFiles, "removeBotDeletionFile").mockImplementation(async (target, signal) => {
    expect(readSaved().cleanup).toMatchObject({ workerId: hosted.owner.workerId, stop: hosted.stop });
    if (failure === "private removal" && target.path === hosted.paths.codexRecoveryDirectory && fail) {
      fail = false; expect(existsSync(hosted.recoveryFile)).toBe(false); throw new Error("controlled private removal failure");
    }
    await remove(target, signal);
  });
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    if (init.method === "POST") {
      expect(url).toBe(`${f.owner.serverOrigin}/api/v1/me/workers/${hosted.owner.workerId}/bots/${id(3)}/deletion-complete`);
      const receipt = JSON.parse(init.body as string); receipts.push(receipt);
      expect(existsSync(hosted.recoveryFile)).toBe(false);
      if (failure === "completion transport" && fail) { fail = false; throw new TypeError("controlled completion transport loss"); }
      current = { ...current, version: "5", deletion: { ...current.deletion, workerCleanup: receipt.result, serverCleanup: { state: "completed", code: null } } };
    }
    return new Response(JSON.stringify(current), { headers: { "Content-Type": "application/json", "Daynight-User-ID": id(1) } });
  }));
  const firstFailure = await recoverLocalBotDeletion(f.input).catch((cause: unknown) => cause);
  if (failure === "completion transport") {
    expect(firstFailure).toBeInstanceOf(ApiError);
    expect(firstFailure).toMatchObject({ outcomeUnconfirmed: true, phase: "request" });
    expect(firstFailure).not.toHaveProperty("code", "stop_unproven");
  } else expect(firstFailure).toMatchObject({ code: "stop_unproven", receiptConfirmed: false });
  expect(existsSync(hosted.recoveryFile)).toBe(false); expect(existsSync(f.paths.lockFile)).toBe(false);
  expect(readSaved().cleanup).toMatchObject({ workerId: hosted.owner.workerId, stop: hosted.stop, localCompleted: failure === "completion transport" });
  writeFileSync(f.paths.configFile, `workerId: ${id(21)}\n`);
  await expect(recoverLocalBotDeletion(f.input)).rejects.toMatchObject({ code: "wrong_worker" });
  writeFileSync(f.paths.configFile, `workerId: ${hosted.owner.workerId}\n`);
  await expect(recoverLocalBotDeletion(f.input)).resolves.toEqual({ receiptConfirmed: true });
  expect(readSaved()).toMatchObject({ intent: null, definition: null, cleanup: { workerId: hosted.owner.workerId, stop: hosted.stop, localCompleted: true, targets: [] } });
  expect(receipts).toHaveLength(failure === "completion transport" ? 2 : 1);
  for (const receipt of receipts) expect(receipt).toEqual({ deletionId: id(8), stop: hosted.stop, result: { state: "completed", code: null } });
  expect(existsSync(hosted.paths.codexRecoveryDirectory)).toBe(false); expect(existsSync(f.paths.lockFile)).toBe(false);
}, 15_000);

test.each(["unstamped", "foreign hosting", "corrupt hosting"])("a retained cleanup cannot override %s authority", async invalid => {
  const f = fixture(), hosted = await hostedCleanup(f);
  if (invalid !== "unstamped") {
    const local = openLocalBotStores({ owner: hosted.owner, stateDirectory: f.paths.stateDirectory, legacyDatabaseFile: f.paths.databaseFile });
    try { local.store.bindDeletionWorker(local.store.get(f.owner, id(3))!, invalid === "foreign hosting" ? id(21) : hosted.owner.workerId); }
    finally { local.close(); }
  }
  if (invalid === "unstamped") rmSync(hosted.recoveryFile);
  else if (invalid === "corrupt hosting") writeFileSync(hosted.recoveryFile, "incomplete recovery identity");
  else writeFileSync(f.paths.configFile, `workerId: ${id(21)}\n`);
  const create = vi.spyOn(botProcess, "createBotProcess"), requests: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    requests.push(init.method!);
    return new Response(JSON.stringify(f.bot), { headers: { "Content-Type": "application/json", "Daynight-User-ID": id(1) } });
  }));
  await expect(recoverLocalBotDeletion(f.input)).rejects.toMatchObject({ code: invalid === "corrupt hosting" ? "stop_unproven" : "wrong_worker" });
  expect(create).not.toHaveBeenCalled(); expect(requests).toEqual(["GET"]);
  expect(existsSync(hosted.paths.codexRecoveryDirectory)).toBe(true); expect(existsSync(f.paths.lockFile)).toBe(false);
});

test.each(["pending", "completed", "private_cleanup_failed"])("recovery rejects an unrelated server state %s before acquiring a lock", async state => {
  const f = fixture(), fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  const bot = { ...f.bot, deletion: { ...f.bot.deletion, workerCleanup: { state: state === "private_cleanup_failed" ? "failed" : state, code: state === "private_cleanup_failed" ? state : null } } };
  await expect(recoverLocalBotDeletion({ ...f.input, bot })).rejects.toMatchObject({ code: "deletion_changed" });
  expect(fetch).not.toHaveBeenCalled(); expect(existsSync(f.paths.lockFile)).toBe(false);
});

test.each(["identity", "state"])("recovery checks fresh server %s after acquiring the Worker lock", async changed => {
  const f = fixture(), create = vi.spyOn(botProcess, "createBotProcess");
  const bot = { ...f.bot, version: "5", deletion: { ...f.bot.deletion,
    ...(changed === "identity" ? { deletionId: id(99) } : { workerCleanup: { state: "pending", code: null } }) } };
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(bot), { headers: { "Content-Type": "application/json", "Daynight-User-ID": id(1) } })));
  await expect(recoverLocalBotDeletion(f.input)).rejects.toMatchObject({ code: "deletion_changed" });
  expect(create).not.toHaveBeenCalled(); expect(existsSync(f.paths.lockFile)).toBe(false);
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
    } else { expect(url).toBe(`${f.owner.serverOrigin}/api/v1/me/bots/${id(3)}`); body = current; }
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json", "Daynight-User-ID": id(1) } });
  }));
  await expect(recoverLocalBotDeletion(f.input)).resolves.toEqual({ receiptConfirmed: true });
  expect(receipts).toEqual([expect.objectContaining({ deletionId: id(8), result: { state: "completed", code: null },
    stop: expect.objectContaining({ ...f.binding, stopProof: expect.objectContaining({ kind: "never_started" }) }) })]);
  expect(existsSync(f.paths.lockFile)).toBe(false);
  const local = openLocalBotStores({ owner: f.owner, stateDirectory: f.paths.stateDirectory, legacyDatabaseFile: f.paths.databaseFile });
  try { expect(local.store.get(f.owner, id(3))).toMatchObject({ intent: null, definition: null, cleanup: { localCompleted: true, stop: expect.objectContaining(f.binding) } }); }
  finally { local.close(); }
});

test.each(["private removal", "completion transport"])("never-started recovery resumes its exact receipt after %s failure", async failure => {
  const f = fixture(), remove = deletionFiles.removeBotDeletionFile, receipts: unknown[] = [];
  const file = resolveBotPaths(f.paths.stateDirectory, id(3)).databaseFile;
  const readSaved = () => {
    const db = new Database(file, { readonly: true });
    try { return JSON.parse((db.prepare("SELECT record FROM bots").get() as { record: string }).record) as BotRecord; }
    finally { db.close(); }
  };
  let fail = true, current = f.bot;
  const journal = readSaved().intent!.journalPath;
  mkdirSync(path.dirname(journal), { recursive: true }); writeFileSync(journal, "original private journal");
  vi.spyOn(deletionFiles, "removeBotDeletionFile").mockImplementation(async (target, signal) => {
    if (failure === "private removal" && fail) { fail = false; throw new Error("controlled private removal failure"); }
    await remove(target, signal);
  });
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    if (init.method === "POST") {
      const receipt = JSON.parse(init.body as string); receipts.push(receipt);
      if (failure === "completion transport" && fail) { fail = false; throw new TypeError("controlled completion transport loss"); }
      current = { ...current, version: "5", deletion: { ...current.deletion, workerCleanup: receipt.result, serverCleanup: { state: "completed", code: null } } };
    }
    return new Response(JSON.stringify(current), { headers: { "Content-Type": "application/json", "Daynight-User-ID": id(1) } });
  }));
  await expect(recoverLocalBotDeletion(f.input)).rejects.toThrow();
  const original = readSaved().cleanup!;
  expect(original.localCompleted).toBe(failure === "completion transport");
  expect(original.stop).toMatchObject({ ...f.binding, stopProof: { kind: "never_started" } });
  expect(original.workerId).toBe(f.owner.workerId);
  expect(current).toEqual(f.bot); expect(existsSync(f.paths.lockFile)).toBe(false);
  writeFileSync(f.paths.configFile, `workerId: ${id(21)}\n`);
  await expect(recoverLocalBotDeletion(f.input)).rejects.toMatchObject({ code: "wrong_worker" });
  writeFileSync(f.paths.configFile, `workerId: ${f.owner.workerId}\n`);
  await expect(recoverLocalBotDeletion(f.input)).resolves.toEqual({ receiptConfirmed: true });
  expect(readSaved()).toMatchObject({ intent: null, definition: null, cleanup: { localCompleted: true, targets: [], stop: original.stop } });
  expect(receipts).toHaveLength(failure === "private removal" ? 1 : 2);
  for (const receipt of receipts) expect(receipt).toEqual({ deletionId: id(8), stop: original.stop, result: { state: "completed", code: null } });
  expect(existsSync(journal)).toBe(false); expect(existsSync(f.paths.lockFile)).toBe(false);
});

test("a definitive never-started recovery rejection revokes replay across a real store reopen", async () => {
  const f = fixture(), receipts: unknown[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    if (init.method === "POST") {
      receipts.push(JSON.parse(init.body as string));
      return new Response(JSON.stringify({ error: { code: "session_conflict", message: "Original execution consumed its grant.", requestId: "fixture" } }), {
        status: 409, headers: { "Content-Type": "application/json", "Daynight-User-ID": id(1) },
      });
    }
    return new Response(JSON.stringify(f.bot), { headers: { "Content-Type": "application/json", "Daynight-User-ID": id(1) } });
  }));
  await expect(recoverLocalBotDeletion(f.input)).rejects.toMatchObject({ code: "stop_unproven" });
  const local = openLocalBotStores({ owner: f.owner, stateDirectory: f.paths.stateDirectory, legacyDatabaseFile: f.paths.databaseFile });
  try {
    const record = local.store.get(f.owner, id(3))!;
    expect(record).toMatchObject({ intent: null, definition: null, cleanup: { localCompleted: true, stop: { stopProof: { kind: "never_started" } } } });
    expect(record.cleanup).not.toHaveProperty("workerId");
  } finally { local.close(); }
  await expect(recoverLocalBotDeletion(f.input)).rejects.toMatchObject({ code: "evidence_missing" });
  expect(receipts).toHaveLength(1); expect(existsSync(f.paths.lockFile)).toBe(false);
});

test("a missing execution row permits only journal stop compensation and never completes deletion", async () => {
  const f = fixture(), file = resolveBotPaths(f.paths.stateDirectory, id(3)).databaseFile;
  const db = new Database(file);
  const record = JSON.parse((db.prepare("SELECT record FROM bots").get() as { record: string }).record);
  db.prepare("DELETE FROM bot_executions").run(); db.close();
  for (const file of [record.intent.ticketPath, record.intent.journalPath]) {
    mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, "original evidence");
  }
  const stop = vi.fn(async () => ({ stopProof: { stoppedAt: "2026-11-23T00:00:00Z" } })), close = vi.fn(async () => {});
  vi.spyOn(botProcess, "createBotProcess").mockReturnValue({ withDeletion: async (_record: unknown, _signal: unknown, action: (stop: unknown) => unknown) => action(stop), close } as never);
  const requests: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    requests.push(init.method!);
    expect(url).toBe(`${f.owner.serverOrigin}/api/v1/me/bots/${id(3)}`);
    return new Response(JSON.stringify(f.bot),
      { headers: { "Content-Type": "application/json", "Daynight-User-ID": id(1) } });
  }));
  await expect(recoverLocalBotDeletion(f.input)).rejects.toMatchObject({ code: "evidence_missing", generationStopped: true, receiptConfirmed: false });
  expect(stop).toHaveBeenCalledWith({ recoverMissingExecution: true }); expect(close).toHaveBeenCalledOnce();
  expect(requests).toEqual(["GET"]); expect(existsSync(f.paths.lockFile)).toBe(false);
  const saved = new Database(file, { readonly: true });
  try {
    expect(saved.prepare("SELECT count(*) AS count FROM bot_executions").get()).toEqual({ count: 0 });
    expect(JSON.parse((saved.prepare("SELECT record FROM bots").get() as { record: string }).record)).toMatchObject({ intent: record.intent, observed: f.bot });
    expect(JSON.parse((saved.prepare("SELECT record FROM bots").get() as { record: string }).record).cleanup).toBeUndefined();
  } finally { saved.close(); }
  expect(readFileSync(record.intent.ticketPath, "utf8")).toBe("original evidence");
  expect(readFileSync(record.intent.journalPath, "utf8")).toBe("original evidence");
});
