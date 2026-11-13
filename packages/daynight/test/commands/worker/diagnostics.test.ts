import { appendFile, mkdir, mkdtemp, open, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createWorkerDiagnostics, workerSqliteMigrationEvent, type WorkerDiagnosticFiles, type WorkerDiagnosticSinkEvent } from "../../../src/commands/worker/diagnostics.js";
import { SqliteAccessError } from "../../../src/platform/sqlite-error.js";
import { resolveWorkerPaths } from "../../../src/commands/worker/paths.js";
import type { WorkerConfigurationDiagnosticMetadata } from "../../../src/commands/worker/configuration-diagnostics.js";

const directories: string[] = [];
const sinks: Awaited<ReturnType<typeof createWorkerDiagnostics>>[] = [];
const expectedCloseErrors = new Set<unknown>();
const releaseGates: (() => void)[] = [];
afterEach(async () => {
  for (const release of releaseGates.splice(0)) release();
  const results = await Promise.allSettled(sinks.splice(0).map(sink => sink.close()));
  try {
    for (const result of results) if (result.status === "rejected" && !expectedCloseErrors.has(result.reason)) throw result.reason;
  } finally {
    expectedCloseErrors.clear(); vi.restoreAllMocks(); vi.useRealTimers();
    for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
  }
});

it("writes ordered JSONL and foreground errors without leaking credentials through cause chains", async () => {
  const root = path.resolve("../../.tmp/worker-diagnostic-tests");
  await mkdir(root, { recursive: true });
  const home = await mkdtemp(path.join(root, "d-"));
  directories.push(home);
  const output: string[] = [];
  const token = 'service-secret-"\\should-stay-private';
  const guidToken = "11223344-5566-7788-99aa-bbccddeeff00";
  const logger = await createWorkerDiagnostics({ paths: resolveWorkerPaths(home), workerId: "00000000-0000-4000-8000-000000000001", platform: "linux", secrets: [token, guidToken], log: (text) => { output.push(text); } });
  logger.emit({ kind: "start", message: "Started.", task: { projectId: "project", taskId: "task", claimId: "claim", status: "active", agent: "codex", sessionId: "native-session" } });
  logger.emit({ kind: "error", message: `Request failed: ${token}; ${guidToken}.`, task: { projectId: guidToken, taskId: "task", claimId: "claim", status: "active", agent: "codex", sessionId: null }, error: new Error("Connection failed.", { cause: new Error(`Bearer ${token} https://name:password@example.test ${guidToken}`) }) });
  await logger.flush();
  const text = await readFile(logger.filename, "utf8");
  expect(text).not.toContain(token);
  expect(text).not.toContain("password");
  expect(output.join("")).not.toContain(token);
  expect(output.join("")).not.toContain("password");
  expect(text).not.toContain(guidToken);
  expect(output.join("")).not.toContain("11223344");
  const records = text.trim().split("\n").map((line) => JSON.parse(line));
  expect(records.map((record) => record.kind)).toEqual(["start", "error"]);
  expect(records[0]).toMatchObject({ projectId: "project", taskId: "task", claimId: "claim", agent: "codex", sessionId: "native-session", status: "active" });
  expect(records[0]).not.toHaveProperty("cleanup");
  expect(records[1].error.cause.message).toContain("[redacted]");
  expect(JSON.stringify(records)).not.toContain("should-stay-private");
  expect(records.every((record) => record.workerId === "00000000-0000-4000-8000-000000000001" && record.platform === "linux")).toBe(true);
});

it("abbreviates foreground GUIDs while preserving complete JSONL identities and errors", async () => {
  const root = path.resolve("../../.tmp/worker-diagnostic-tests");
  await mkdir(root, { recursive: true });
  const home = await mkdtemp(path.join(root, "d-"));
  directories.push(home);
  const output: string[] = [];
  const workerId = "00112233-4455-6677-8899-aabbccddeeff";
  const task = { projectId: "FB1A3E30-f945-4c48-ab0f-55be117e098e", taskId: "49bc3068-2633-4949-8f7d-3600ffea4351", claimId: "fb0484fe-e27a-4573-8d54-3fe00c232f4e", status: "active", agent: "codex", sessionId: "aabbccdd-eeff-0011-2233-445566778899" } as const;
  const message = `Worker ${workerId} stopped; native-session and native-session-with-hyphens remain available.`;
  const cause = new Error(`Session ${task.sessionId} failed.`);
  const error = new AggregateError([new Error(`Claim ${task.claimId} failed.`, { cause })], `Project ${task.projectId} failed.`);
  const logger = await createWorkerDiagnostics({ paths: resolveWorkerPaths(home), workerId, platform: "linux", log: (text) => { output.push(text); } });
  logger.emit({ kind: "error", message, task, error });
  await logger.flush();
  expect(output).toHaveLength(1);
  expect(output[0]).toContain(" error FB1A3E30/49bc3068/fb0484fe active Worker 00112233 stopped; native-session and native-session-with-hyphens remain available.");
  expect(output[0]).toContain('"message":"Project FB1A3E30 failed."');
  expect(output[0]).toContain('"message":"Claim fb0484fe failed."');
  expect(output[0]).toContain('"message":"Session aabbccdd failed."');
  for (const id of [workerId, task.projectId, task.taskId, task.claimId, task.sessionId]) expect(output[0]).not.toContain(id);
  const record = JSON.parse(await readFile(logger.filename, "utf8"));
  expect(record).toMatchObject({ workerId, ...task, message, error: { name: "AggregateError", message: error.message, errors: [{ name: "Error", message: `Claim ${task.claimId} failed.`, cause: { name: "Error", message: cause.message } }] } });
});

it("reports an output failure at flush without letting diagnostics prevent shutdown work", async () => {
  const root = path.resolve("../../.tmp/worker-diagnostic-tests");
  await mkdir(root, { recursive: true });
  const home = await mkdtemp(path.join(root, "d-"));
  directories.push(home);
  const failure = new Error("Foreground output is unavailable.");
  const logger = await createWorkerDiagnostics({ paths: resolveWorkerPaths(home), workerId: "00000000-0000-4000-8000-000000000001", platform: "linux", log: () => { throw failure; } });
  expect(() => logger.emit({ kind: "start", message: "Starting." })).not.toThrow();
  await expect(logger.flush()).rejects.toBe(failure);
  expect(() => logger.emit({ kind: "shutdown", message: "Cleanup must still run." })).not.toThrow();
  await expect(logger.flush()).rejects.toBe(failure);
});

it("retains queryable SQLite migration metadata while rejecting extra payload and unsafe cause text", async () => {
  const root = path.resolve("../../.tmp/worker-diagnostic-tests");
  await mkdir(root, { recursive: true });
  const home = await mkdtemp(path.join(root, "d-"));
  directories.push(home);
  const output: string[] = [];
  const logger = await createWorkerDiagnostics({ paths: resolveWorkerPaths(home), workerId: "00000000-0000-4000-8000-000000000001", platform: "linux", log: text => { output.push(text); } });
  const migration = { migrationId: "00112233-4455-6677-8899-aabbccddeeff", database: "web", file: path.join(home, "state.sqlite"), kind: "completed", phase: "commit", fromVersion: 0, toVersion: 1, durationMs: 8, outcome: "committed", prompt: "private-extra-payload" } as const;
  const cause = Object.assign(new Error("SQL parameter private-raw-value"), { code: "SQLITE_FULL" });
  const error = new SqliteAccessError("cleanup-failed", { database: "web", phase: "close", fromVersion: 0, toVersion: 1 }, { cause, outcome: "committed" });
  logger.emit(workerSqliteMigrationEvent(migration));
  logger.emit({ kind: "sqlite-migration-failed", message: "SQLite close failed after commit.", sqlite: { ...migration, kind: "failed", phase: "close" }, error });
  await logger.flush();
  const text = await readFile(logger.filename, "utf8");
  const records = text.trim().split("\n").map(line => JSON.parse(line));
  expect(records[0].sqlite).toMatchObject({ migrationId: migration.migrationId, database: "web", phase: "commit", fromVersion: 0, toVersion: 1, durationMs: 8, outcome: "committed" });
  expect(records[0].sqlite).not.toHaveProperty("prompt");
  expect(records[1].error).toMatchObject({ database: "web", phase: "close", fromVersion: 0, toVersion: 1, outcome: "committed", cause: { name: "Error", sqliteCode: "SQLITE_FULL" } });
  expect(text).not.toContain("private-raw-value");
  expect(text).not.toContain("private-extra-payload");
  expect(output.join("\n")).not.toContain("private-raw-value");
  expect(error.cause).toBe(cause);
});

it("retains a claim-scoped cause without inventing a missing local task", async () => {
  const root = path.resolve("../../.tmp/worker-diagnostic-tests");
  await mkdir(root, { recursive: true });
  const home = await mkdtemp(path.join(root, "d-")); directories.push(home);
  const logger = await createWorkerDiagnostics({ paths: resolveWorkerPaths(home), workerId: "worker", platform: "linux" });
  const identity = { projectId: "project", taskId: "task", claimId: "claim", worktreeId: "worktree" };
  const metadata = { component: "cleanup", phase: "agent-stop", attemptId: "attempt", runKey: "run" };
  logger.emit({ kind: "execution-stop-observation-error", message: "unknown", identity, ...metadata, error: new Error("observation", { cause: new Error("original") }) });
  await logger.flush();
  const record = JSON.parse(await readFile(logger.filename, "utf8"));
  expect(record).toMatchObject({ ...identity, ...metadata, error: { message: "observation", cause: { message: "original" } } });
  expect(record).not.toHaveProperty("agent");
});


const realFiles: WorkerDiagnosticFiles = {
  ensureDirectory: async directory => { await mkdir(directory, { recursive: true, mode: 0o700 }); },
  createSegment: async filename => { await appendFile(filename, "", { flag: "ax", mode: 0o600 }); },
  appendRecord: async (filename, record) => { await appendFile(filename, record, { mode: 0o600 }); },
};
const sinkFixture = async (options: Omit<Parameters<typeof createWorkerDiagnostics>[0], "paths" | "workerId" | "platform"> & { useDefaultStderr?: boolean } = {}, setup?: (logsDirectory: string) => Promise<void>) => {
  const root = path.resolve("../../.tmp/worker-diagnostic-tests");
  await mkdir(root, { recursive: true });
  const home = await mkdtemp(path.join(root, "sink-")); directories.push(home);
  const paths = resolveWorkerPaths(home), stderr: string[] = [], events: WorkerDiagnosticSinkEvent[] = [], output: string[] = [];
  await setup?.(paths.logsDirectory);
  const { useDefaultStderr = false, ...diagnosticOptions } = options;
  const sink = await createWorkerDiagnostics({
    paths, workerId: "00112233-4455-4677-8899-aabbccddeeff", platform: "linux",
    log: text => { output.push(text); }, ...(useDefaultStderr ? {} : { stderr: (text: string) => { stderr.push(text); } }),
    ...diagnosticOptions, onSinkState: event => { events.push(event); options.onSinkState?.(event); },
  });
  sinks.push(sink);
  return { sink, paths, stderr, events, output };
};
const records = async (filename: string): Promise<Record<string, any>[]> => (await readFile(filename, "utf8")).trim().split("\n").map(line => JSON.parse(line));
const gate = () => {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  releaseGates.push(release);
  return { promise, release };
};

it("projects configuration source and result facts into redacted JSONL without extra payload", async () => {
  const token = "configuration-diagnostic-secret", projectId = "fb1a3e30-f945-4c48-ab0f-55be117e098e";
  const f = await sinkFixture({ secrets: [token] });
  const metadata = {
    phase: "cache-persist", status: "failed", reason: "permission_denied",
    key: { kind: "projectRemoval", projectId, command: "private-native-command" },
    source: { state: "initialized", generation: "current-generation", desiredRevision: "10", observationRevision: "0", prompt: "private-source-prompt" },
    previousSource: { state: "unread", generation: null, desiredRevision: null, observationRevision: null, credential: "private-previous-credential" },
    received: { desiredRevision: "5", observationRevision: "1", command: "private-received-command" },
    observationAccepted: false, storagePhase: "persist",
    reportId: "report-id", targetRevision: "20", generation: "original-generation", recordId: "original-stop-record", recordIds: ["original-stop-record"],
    syncId: "sync-id", requestId: token, remote: "confirmed", local: "pending", occurrences: 7, backoffStep: 5,
    nextAttemptAt: "2030-01-01T00:01:00.000Z",
    details: { tool: "codex", context: "web", stage: "probe", systemCode: "EACCES", operationKind: "request_timeout", stdout: "private-output" },
    nativeArgs: ["private-native-argument"],
  } as const;
  const configuration: WorkerConfigurationDiagnosticMetadata = metadata;
  f.sink.emit({ kind: "worker-configuration-failed", component: "configuration", phase: "cache-persist", message: "A confirmed receipt is waiting for its local checkpoint.", configuration,
    error: new Error("Checkpoint failed.", { cause: new Error("Bearer " + token) }) });
  await f.sink.flush();
  const record = (await records(f.sink.filename))[0]!;
  expect(record.configuration).toEqual({
    phase: "cache-persist", status: "failed", reason: "permission_denied", key: { kind: "projectRemoval", projectId },
    source: { state: "initialized", generation: "current-generation", desiredRevision: "10", observationRevision: "0" },
    previousSource: { state: "unread", generation: null, desiredRevision: null, observationRevision: null },
    received: { desiredRevision: "5", observationRevision: "1" },
    observationAccepted: false, storagePhase: "persist",
    reportId: "report-id", targetRevision: "20", generation: "original-generation", recordId: "original-stop-record", recordIds: ["original-stop-record"],
    syncId: "sync-id", requestId: "[redacted]", remote: "confirmed", local: "pending", occurrences: 7, backoffStep: 5,
    nextAttemptAt: "2030-01-01T00:01:00.000Z",
    details: { tool: "codex", context: "web", stage: "probe", systemCode: "EACCES", operationKind: "request_timeout" },
  });
  expect(record).toMatchObject({ workerId: "00112233-4455-4677-8899-aabbccddeeff", error: { cause: { message: "Bearer [redacted]" } } });
  const text = await readFile(f.sink.filename, "utf8");
  expect(text).not.toContain(token);
  expect(text).not.toContain("private-");
  expect(f.output.join("")).not.toContain(token);
  expect(f.output[0]).toContain('"key":{"kind":"projectRemoval","projectId":"fb1a3e30"}');
  expect(f.output[0]).toContain('"targetRevision":"20"');
  expect(f.output[0]).toContain('"received":{"desiredRevision":"5","observationRevision":"1"}');
  expect(f.output[0]).toContain('"observationAccepted":false,"storagePhase":"persist"');
  expect(f.output[0]).toContain('"generation":"original-generation"');
  expect(f.output[0]).toContain('"remote":"confirmed","local":"pending","occurrences":7');
  expect(f.output[0]).not.toContain('"recordIds"');
  expect(f.output[0]).not.toContain('"details"');
});

it("recovers a failed log directory without treating an undispatched record as an unknown append", async () => {
  let clock = Date.UTC(2030, 0, 1);
  const f = await sinkFixture({ now: () => clock }, async directory => {
    await mkdir(path.dirname(directory), { recursive: true });
    await writeFile(directory, "A file occupies the log directory.");
  });
  const original = f.sink.filename;
  expect(f.events).toHaveLength(1);
  expect(f.events[0]).toMatchObject({ state: "blocked", phase: "directory", unknownAppends: 0, omittedRecords: 0 });
  f.sink.emit({ kind: "before-recovery", message: "Not dispatched." });
  await f.sink.flush();
  await rm(f.paths.logsDirectory);
  clock += 4_999; await f.sink.flush();
  expect(f.events).toHaveLength(1);
  clock++;
  await f.sink.flush();
  expect(f.events[1]).toMatchObject({ state: "recovered", omittedRecords: 1, unknownAppends: 0, previousFilename: original });
  const recovered = await records(f.sink.filename);
  expect(recovered).toHaveLength(1);
  expect(recovered[0]).toMatchObject({ kind: "diagnostic-sink-recovered", sink: { omittedRecords: 1, unknownAppends: 0, previousFilename: original, filename: f.sink.filename } });
  expect(f.stderr.join("")).toContain("diagnostic-sink-blocked");
  expect(await readdir(f.paths.logsDirectory)).toEqual([path.basename(f.sink.filename)]);
});

it("retains a partial append and recovers automatically in an independent valid JSONL segment", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.UTC(2030, 0, 1));
  const secret = "sink-secret-credential", failure = Object.assign(new Error("EIO " + secret), { code: "EIO" });
  const configuration: WorkerConfigurationDiagnosticMetadata = { phase: "report-send", status: "failed", reason: "unavailable",
    source: { state: "uninitialized", generation: "original-generation", desiredRevision: null, observationRevision: "0" },
    syncId: "original-sync", reportId: "original-report", remote: "unknown", local: "not_attempted", occurrences: 1, nextAttemptAt: null };
  const recovered = gate();
  let appends = 0;
  const f = await sinkFixture({ secrets: [secret], files: {
    ...realFiles,
    appendRecord: async (filename, line) => {
      appends++;
      if (appends === 1) { await appendFile(filename, Buffer.from(line).subarray(0, 23)); throw failure; }
      await realFiles.appendRecord(filename, line);
    },
  }, onSinkState: event => { if (event.state === "recovered") recovered.release(); } });
  const original = f.sink.filename;
  f.sink.emit({ kind: "unknown-record", message: "This record must not be replayed.", configuration });
  f.sink.emit({ kind: "queued-record", message: "Not dispatched after the append failed." });
  await f.sink.flush();
  f.sink.emit({ kind: "blocked-record", message: "Omitted while blocked." });
  const partial = await readFile(original);
  expect(partial.byteLength).toBe(23);
  expect(partial.at(-1)).not.toBe(10);
  expect(f.events[0]?.error).toBe(failure);
  expect(f.events[0]).toMatchObject({ state: "blocked", phase: "append", unknownAppends: 1 });
  await vi.advanceTimersByTimeAsync(4_999);
  expect(appends).toBe(1);
  await vi.advanceTimersByTimeAsync(1);
  await recovered.promise;
  await f.sink.flush();
  expect(f.sink.filename).not.toBe(original);
  const values = await records(f.sink.filename);
  expect(values).toHaveLength(1);
  expect(values[0]).toMatchObject({ kind: "diagnostic-sink-recovered", sink: { previousFilename: original, unknownAppends: 1, omittedRecords: 2 } });
  expect(f.stderr.join("")).not.toContain(secret);
  expect(f.stderr.join("")).toContain("[redacted]");
  f.sink.emit({ kind: "after-recovery", message: "Log path=" + f.sink.filename, configuration: { ...configuration, phase: "receipt-accept", status: "succeeded", remote: "confirmed", local: "persisted" } });
  await f.sink.flush();
  const recoveredRecords = await records(f.sink.filename);
  expect(recoveredRecords.map(record => record.kind)).toEqual(["diagnostic-sink-recovered", "after-recovery"]);
  expect(recoveredRecords[1]).toMatchObject({ configuration: { source: configuration.source, syncId: "original-sync", reportId: "original-report", remote: "confirmed", local: "persisted" } });
  expect(f.output.at(-1)).toContain(f.sink.filename);
  expect(await readFile(original)).toEqual(partial);
});

it("does not replay an unknown recovery summary and caps repeated retries at sixty seconds", async () => {
  let clock = Date.UTC(2030, 0, 1), appends = 0;
  const failure = Object.assign(new Error("Append outcome is unknown."), { code: "EIO" });
  const f = await sinkFixture({ now: () => clock, files: {
    ...realFiles, appendRecord: async (filename, line) => {
      appends++;
      await appendFile(filename, Buffer.from(line).subarray(0, 17));
      throw failure;
    },
  } });
  const original = f.sink.filename;
  f.sink.emit({ kind: "first", message: "May be partial." });
  await f.sink.flush();
  const delays = [5_000, 10_000, 20_000, 40_000, 60_000, 60_000];
  for (const [index, delay] of delays.entries()) {
    expect(f.events.at(-1)?.nextAttemptAt).toBe(new Date(clock + delay).toISOString());
    clock += delay - 1;
    await f.sink.flush(); expect(appends).toBe(index + 1);
    clock++;
    await f.sink.flush(); expect(appends).toBe(index + 2);
  }
  expect(f.events.at(-1)).toMatchObject({ state: "blocked", phase: "append", previousFilename: original, unknownAppends: 7, omittedRecords: 0 });
  const filenames = await readdir(f.paths.logsDirectory);
  expect(filenames).toHaveLength(7);
  for (const filename of filenames) expect((await readFile(path.join(f.paths.logsDirectory, filename))).byteLength).toBe(17);
  const before = appends;
  await f.sink.close();
  clock += 1_000_000; await f.sink.flush();
  expect(appends).toBe(before);
  expect(f.stderr.at(-1)).toContain("diagnostic-sink-unavailable-at-close");
});

it("bounds queued records, accounts for omissions, and joins an outstanding append during close", async () => {
  const blocked = gate();
  let active = 0, maximum = 0, appends = 0;
  const submitted: string[] = [];
  const f = await sinkFixture({ files: {
    ...realFiles, appendRecord: async (_filename, line) => {
      active++; maximum = Math.max(maximum, active);
      try {
        if (++appends === 1) await blocked.promise;
        submitted.push(line);
      } finally { active--; }
    },
  } });
  const total = 1_000;
  for (let index = 0; index < total; index++) f.sink.emit({ kind: "record", message: String(index) });
  let closed = false;
  const closing = f.sink.close().then(() => { closed = true; });
  await Promise.resolve();
  expect(closed).toBe(false);
  expect(active).toBe(1);
  blocked.release();
  await closing;
  expect(maximum).toBe(1);
  const values = submitted.map(line => JSON.parse(line)), written = values.filter(record => record.kind === "record");
  expect(written.length).toBeGreaterThan(0);
  expect(written.length).toBeLessThan(total);
  expect(values.at(-1)).toMatchObject({ kind: "diagnostic-sink-records-omitted", sink: { unknownAppends: 0, omittedRecords: total - written.length } });
  expect(() => f.sink.emit({ kind: "late", message: "Closed." })).toThrow("closed");
});

it("starts each run in a new segment without appending after an earlier partial tail", async () => {
  const first = await sinkFixture();
  first.sink.emit({ kind: "first", message: "Complete." });
  await first.sink.close();
  await appendFile(first.sink.filename, '{"unfinished"');
  const previous = await readFile(first.sink.filename);
  const next = await createWorkerDiagnostics({ paths: first.paths, workerId: "worker", platform: "linux" });
  sinks.push(next);
  next.emit({ kind: "next-run", message: "Independent." });
  await next.flush();
  expect(next.filename).not.toBe(first.sink.filename);
  expect(await readFile(first.sink.filename)).toEqual(previous);
  expect((await records(next.filename)).map(record => record.kind)).toEqual(["next-run"]);
});

it("retains formatter failures as independent fatal errors without retrying file IO", async () => {
  const f = await sinkFixture();
  const failure = new RangeError("Diagnostic serialization exhausted its text budget.");
  const stringify = vi.spyOn(JSON, "stringify").mockImplementationOnce(() => { throw failure; });
  try { expect(() => f.sink.emit({ kind: "format", message: "Valid input." })).not.toThrow(); }
  finally { stringify.mockRestore(); }
  expectedCloseErrors.add(failure);
  await expect(f.sink.flush()).rejects.toBe(failure);
  expect(f.events).toEqual([]);
  expect(f.stderr).toEqual([]);
  expect(await readFile(f.sink.filename, "utf8")).toBe("");
});

it("retains a stderr failure and the original file error instead of retrying them as storage", async () => {
  let clock = Date.UTC(2030, 0, 1), appends = 0;
  const original = Object.assign(new Error("File unavailable."), { code: "EIO" }), stderrFailure = new Error("stderr unavailable.");
  const f = await sinkFixture({ now: () => clock, stderr: async () => { throw stderrFailure; }, files: {
    ...realFiles, appendRecord: async () => { appends++; throw original; },
  } });
  f.sink.emit({ kind: "first", message: "Unconfirmed." });
  const failure = await f.sink.flush().then(() => { throw new Error("Expected a fatal stderr failure."); }, error => error);
  expectedCloseErrors.add(failure);
  expect(failure).toBeInstanceOf(AggregateError);
  expect(failure.cause).toBe(original);
  expect(failure.errors).toEqual([original, stderrFailure]);
  clock += 100_000;
  await expect(f.sink.flush()).rejects.toBe(failure);
  expect(appends).toBe(1);
  expect(f.events).toHaveLength(1);
});


it("recovers after an unknown recovery-summary append without reusing its bytes or corrupting older segments", async () => {
  let clock = Date.UTC(2030, 0, 1), appends = 0;
  const f = await sinkFixture({ now: () => clock, files: {
    ...realFiles, appendRecord: async (filename, line) => {
      if (++appends <= 2) {
        await appendFile(filename, Buffer.from(line).subarray(0, 19));
        throw Object.assign(new Error("Unknown append."), { code: "EIO" });
      }
      await realFiles.appendRecord(filename, line);
    },
  } });
  const first = f.sink.filename;
  f.sink.emit({ kind: "original-record", message: "Never replay." });
  await f.sink.flush();
  clock += 5_000; await f.sink.flush();
  const failedRecovery = f.sink.filename;
  const firstBytes = await readFile(first), recoveryBytes = await readFile(failedRecovery);
  expect(f.events.at(-1)).toMatchObject({ state: "blocked", unknownAppends: 2 });
  clock += 10_000; await f.sink.flush();
  expect(f.sink.filename).not.toBe(first);
  expect(f.sink.filename).not.toBe(failedRecovery);
  const complete = await records(f.sink.filename);
  expect(complete).toHaveLength(1);
  expect(complete[0]).toMatchObject({ kind: "diagnostic-sink-recovered", sink: { previousFilename: first, filename: f.sink.filename, unknownAppends: 2, omittedRecords: 0 } });
  expect(await readFile(first)).toEqual(firstBytes);
  expect(await readFile(failedRecovery)).toEqual(recoveryBytes);
  expect(firstBytes.byteLength).toBe(19);
  expect(recoveryBytes.byteLength).toBe(19);
});

it("joins the default stderr callback and later error event before closing its listener", async () => {
  const original = Object.assign(new Error("File unavailable."), { code: "EIO" }), outputFailure = Object.assign(new Error("Pipe closed."), { code: "EPIPE" });
  let callback!: (error?: Error | null) => void, reported = "";
  const listenersBefore = process.stderr.listenerCount("error");
  const write = vi.spyOn(process.stderr, "write").mockImplementation(((...args: unknown[]): boolean => {
    reported = String(args[0]);
    callback = args[1] as (error?: Error | null) => void;
    return false;
  }) as typeof process.stderr.write);
  const f = await sinkFixture({ useDefaultStderr: true, files: {
    ...realFiles, appendRecord: async () => { throw original; },
  } });
  try {
    f.sink.emit({ kind: "record", message: "Unknown." });
    await vi.waitFor(() => { expect(callback).toBeTypeOf("function"); });
    let completed = false;
    const flush = f.sink.flush().then(() => { completed = true; return undefined; }, error => { completed = true; return error; });
    callback(outputFailure);
    await Promise.resolve(); expect(completed).toBe(false);
    expect(process.stderr.listenerCount("error")).toBe(listenersBefore + 1);
    process.stderr.emit("error", outputFailure);
    const failure = await flush;
    expectedCloseErrors.add(failure);
    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure.cause).toBe(original);
    expect(failure.errors).toEqual([original, outputFailure]);
    expect(reported).toContain("diagnostic-sink-blocked");
    await expect(f.sink.close()).rejects.toBe(failure);
    expect(process.stderr.listenerCount("error")).toBe(listenersBefore);
  } finally {
    write.mockRestore();
    if (callback !== undefined && process.stderr.listenerCount("error") > listenersBefore) process.stderr.emit("error", outputFailure);
  }
});


it("keeps a real append handle owned until its delayed write and close complete", async () => {
  vi.useFakeTimers();
  const entered = gate(), release = gate();
  let released = false;
  const f = await sinkFixture({ files: {
    ...realFiles, appendRecord: async (filename, line) => {
      const handle = await open(filename, "a", 0o600);
      entered.release();
      try { await release.promise; await handle.writeFile(line); }
      finally { await handle.close(); released = true; }
    },
  } });
  f.sink.emit({ kind: "held-write", message: "Written once." });
  await entered.promise;
  let completed = false;
  const closing = f.sink.close().then(() => { completed = true; });
  await vi.advanceTimersByTimeAsync(60_000);
  expect(completed).toBe(false);
  expect(released).toBe(false);
  expect(await readFile(f.sink.filename, "utf8")).toBe("");
  release.release();
  await closing;
  expect(released).toBe(true);
  expect((await records(f.sink.filename)).map(record => record.kind)).toEqual(["held-write"]);
});


it("rejects invalid filesystem arguments instead of classifying them as a recoverable directory outage", async () => {
  const failure = new TypeError("Invalid diagnostic directory.");
  await expect(sinkFixture({ files: {
    ...realFiles, ensureDirectory: async () => { throw failure; },
  } })).rejects.toBe(failure);
});

it("propagates an unexpected append implementation error without disguising it as failed file IO", async () => {
  const failure = new Error("The append implementation failed before dispatch.");
  const f = await sinkFixture({ files: {
    ...realFiles, appendRecord: async () => { throw failure; },
  } });
  f.sink.emit({ kind: "record", message: "Not written." });
  expectedCloseErrors.add(failure);
  await expect(f.sink.flush()).rejects.toBe(failure);
  expect(f.events).toEqual([]);
  expect(f.stderr).toEqual([]);
});


it("retains the known file failure when formatting its diagnostic also fails", async () => {
  const ioFailure = Object.assign(new Error("File unavailable."), { code: "EIO" }), formatFailure = new RangeError("Diagnostic formatting failed.");
  const f = await sinkFixture({ files: {
    ...realFiles, appendRecord: async () => { throw ioFailure; },
  } });
  f.sink.emit({ kind: "record", message: "Unknown append." });
  const stringify = vi.spyOn(JSON, "stringify").mockImplementationOnce(() => { throw formatFailure; });
  let failure: unknown;
  try { failure = await f.sink.flush().then(() => { throw new Error("Expected a formatting failure."); }, error => error); }
  finally { stringify.mockRestore(); }
  expectedCloseErrors.add(failure);
  expect(failure).toBeInstanceOf(AggregateError);
  expect(failure).toMatchObject({ cause: ioFailure, errors: [ioFailure, formatFailure] });
  expect(f.events[0]).toMatchObject({ state: "blocked", unknownAppends: 1, error: ioFailure });
  expect(f.stderr).toEqual([]);
});
