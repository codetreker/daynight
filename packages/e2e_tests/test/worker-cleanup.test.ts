import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { startCommand } from "../src/command.ts";
import { DatabaseSync } from "node:sqlite";
import { FixtureWorkerStopError, finalizeFixtureRoot, loadFixtureStopProofs, readFixtureBot, readFixtureExecutions, stopAndRecordFixtureWorker, stopFixtureWorker, stopRecordedFixtureBot, stopRecordedFixtureExecutions, type FixtureStopProofs } from "../src/worker-cleanup.ts";

const base = path.resolve(import.meta.dirname, "../../../.tmp/e2e-worker-cleanup-test");
const scratch = async () => { await mkdir(base, { recursive: true }); return mkdtemp(path.join(base, "case-")); };
const proof = { pid: 123, parentPid: 1, processGroupId: 123, startedAt: "original", commandHash: "a".repeat(64) };
const id = "11111111-1111-4111-8111-111111111111";

for (const code of [0, 3]) test(`Worker SIGINT exit ${code} ${code === 0 ? "confirms" : "does not confirm"} shutdown`, async () => {
  const root = await scratch();
  try {
    let ready!: () => void;
    const started = new Promise<void>(resolve => { ready = resolve; });
    const worker = startCommand(process.execPath, ["-e", `process.on('SIGINT',()=>process.exit(${code}));console.log('READY');setInterval(()=>{},1000);`],
      { cwd: root, timeoutMs: 5_000, onOutput: (_channel, chunk) => { if (chunk.includes("READY")) ready(); } });
    await started;
    if (code === 0) await stopFixtureWorker(worker, false);
    else await assert.rejects(stopFixtureWorker(worker, false), error => error instanceof FixtureWorkerStopError && error.groupStopped && /code: 3/.test(error.message));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("timeout confirms only the Worker process group, not clean shutdown", async () => {
  const root = await scratch();
  try {
    const worker = startCommand(process.execPath, ["-e", "setInterval(()=>{},1000)"], { cwd: root, timeoutMs: 200, onOutput: () => {} });
    await assert.rejects(worker.finished, /timed out/);
    await assert.rejects(stopFixtureWorker(worker, true), error => error instanceof FixtureWorkerStopError && error.groupStopped && /timed out/.test(error.message));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a failed group observation retains its original rejection and observed exit", async () => {
  const root = await scratch();
  const failure = new Error("controlled group observation failure");
  try {
    let ready!: () => void;
    const started = new Promise<void>(resolve => { ready = resolve; });
    const worker = startCommand(process.execPath, ["-e", "process.on('SIGINT',()=>process.exit(0));process.stdout.write('READY');process.stderr.write('worker evidence');setInterval(()=>{},1000)"], {
      cwd: root, timeoutMs: 5_000, onOutput: (_channel, chunk) => { if (chunk.includes("READY")) ready(); },
      stopOwnedGroup: async () => { throw failure; },
    });
    await started;
    await assert.rejects(stopFixtureWorker(worker, false), error => {
      assert.ok(error instanceof FixtureWorkerStopError);
      assert.equal(error.groupStopped, false);
      assert.match(error.message, /controlled group observation failure/);
      assert.match(error.message, /worker evidence/);
      assert.match(error.message, /code: 0/);
      assert.ok(error.cause instanceof AggregateError);
      assert.equal(error.cause.errors.length, 1);
      assert.equal(error.cause.errors[0].cause, failure);
      return true;
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("an unconfirmed group stop surfaces even when the Worker is still alive", async () => {
  const root = await scratch();
  let pid: number | undefined;
  try {
    let ready!: () => void;
    const started = new Promise<void>(resolve => { ready = resolve; });
    const worker = startCommand(process.execPath, ["-e", "process.on('SIGINT',()=>{});process.stdout.write('READY');setInterval(()=>{},1000)"], {
      cwd: root, timeoutMs: 200, onOutput: (_channel, chunk) => { if (chunk.includes("READY")) ready(); },
      stopOwnedGroup: async () => { throw new Error("controlled live group failure"); },
    });
    pid = worker.pid; await started;
    await assert.rejects(stopFixtureWorker(worker, false), error => {
      assert.ok(error instanceof FixtureWorkerStopError);
      assert.equal(error.groupStopped, false);
      assert.equal(error.diagnostics.exit, null);
      assert.match(error.message, /controlled live group failure/);
      assert.match(error.message, /timed out/);
      return true;
    });
  } finally {
    if (pid !== undefined) { try { process.kill(pid, "SIGKILL"); } catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error; } }
    await rm(root, { recursive: true, force: true });
  }
});

test("each Worker stop records readable exit and output evidence before ownership can be marked", async () => {
  const root = await scratch();
  try {
    await mkdir(path.join(root, "logs"));
    for (const code of [0, 3]) {
      let ready!: () => void;
      const started = new Promise<void>(resolve => { ready = resolve; });
      const worker = startCommand(process.execPath, ["-e", `process.on('SIGINT',()=>process.exit(${code}));process.stdout.write('READY');process.stderr.write('evidence-${code}');setInterval(()=>{},1000)`], {
        cwd: root, timeoutMs: 5_000, onOutput: (_channel, chunk) => { if (chunk.includes("READY")) ready(); },
      });
      await started;
      const stop = stopAndRecordFixtureWorker({ worker, exited: false, runDirectory: root, workerId: id, launchNumber: code + 1 });
      if (code === 0) await stop; else await assert.rejects(stop, FixtureWorkerStopError);
      const receipt = JSON.parse(await readFile(path.join(root, "logs", `worker-patrol-${code + 1}.json`), "utf8"));
      assert.equal(receipt.workerId, id); assert.equal(receipt.groupStopped, true);
      assert.deepEqual(receipt.diagnostics.exit, { code, signal: null });
      assert.match(receipt.diagnostics.stderr, new RegExp(`evidence-${code}`));
      assert.equal(receipt.failure === null, code === 0);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("unconfirmed Worker or Controller stop retains original private state", async () => {
  const root = await scratch();
  try {
    const config = path.join(root, "config.yml"); await writeFile(config, "private fixture credential", { mode: 0o600 });
    let called = false;
    await assert.rejects(finalizeFixtureRoot({ root, stopConfirmed: false, workerGroupStopped: false, recover: async () => { called = true; } }), /retained/);
    assert.equal(called, false); assert.equal(await readFile(config, "utf8"), "private fixture credential");
    await assert.rejects(finalizeFixtureRoot({ root, stopConfirmed: false, workerGroupStopped: true, recover: async () => { throw new Error("proof conflict"); } }), /retained/);
    assert.equal((await stat(config)).mode & 0o777, 0o600);
    await finalizeFixtureRoot({ root, stopConfirmed: false, workerGroupStopped: true, recover: async () => {} });
    await assert.rejects(stat(root), { code: "ENOENT" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("missing original records do not become proof of a stopped execution", async () => {
  const root = await scratch();
  try {
    const expected = { projectId: "project", taskId: "task", workerId: "worker", userId: "user", serverOrigin: "https://daynight.example", repository: root };
    await assert.rejects(readFixtureExecutions(root), { code: "ENOENT" });
    await assert.rejects(stopRecordedFixtureExecutions([], expected, root, {} as FixtureStopProofs, Date.now() + 5_000), /missing or ambiguous/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("fallback uses the original ticket and refreshed append-only journal proofs", async () => {
  const root = await scratch();
  try {
    const directory = path.join(root, "worker-config"), repository = path.join(root, "repository"), worktree = path.join(repository, ".worktrees", "daynight", id);
    const expected = { projectId: "project", taskId: "task", workerId: "worker", userId: "user", serverOrigin: "https://daynight.example", repository, claimId: "claim" };
    const ticket = { executionId: id, launchId: id, sessionId: "session", controllerId: "controller", controllerInstanceId: "instance", executionGeneration: "1",
      initialOperationId: "initial", initialPrompt: "private fixture prompt", claimId: "claim", projectId: "project", taskId: "task", workerId: "worker", worktreeId: id,
      userId: "user", serverOrigin: expected.serverOrigin, cwd: worktree };
    const ticketPath = path.join(directory, "controller", "launches", `${id}.json`);
    await mkdir(path.dirname(ticketPath), { recursive: true }); await writeFile(ticketPath, JSON.stringify(ticket), { mode: 0o600 });
    const execution = { ...ticket, ticketPath, launchSubmission: "acknowledged", controllerProcess: proof, nativeProcesses: [] };
    const record = { projectId: "project", taskId: "task", claimId: "claim", workerId: "worker", worktreeId: id, userId: "user", serverOrigin: expected.serverOrigin,
      resources: { worktree: { worktreePath: worktree, branch: "daynight/task" }, nativeSession: { sessionId: "native" } }, webExecution: execution };
    const nativeA = { ...proof, pid: 124 }, nativeB = { ...proof, pid: 125 };
    const snapshots = [
      { controllerProcess: proof, nativeProcesses: [nativeA], nativeSessionId: "native" },
      { controllerProcess: proof, nativeProcesses: [nativeA, nativeB], nativeSessionId: "native" },
      { controllerProcess: proof, nativeProcesses: [nativeA, nativeB], nativeSessionId: "native" },
    ];
    let read = 0, stopped = 0; const stopLists: number[][] = [];
    const proofs: FixtureStopProofs = {
      parseLaunchTicket: value => value as typeof ticket,
      readCurrentControllerSnapshot: () => snapshots[Math.min(read++, 2)]!,
      preservesControllerProcessProof: (before, after) => JSON.stringify(before) === JSON.stringify(after),
      preservesNativeProcessPrefix: (before, after) => before.every((item, index) => JSON.stringify(item) === JSON.stringify(after[index])),
      preservesControllerEvidence: (before, after) => before.nativeProcesses.every((item, index) => JSON.stringify(item) === JSON.stringify(after.nativeProcesses[index])),
      reconcileSubmittedControllerLaunch: async () => { throw new Error("unexpected launch reconciliation"); },
      stopControllerBootstrap: async () => { throw new Error("unexpected bootstrap stop"); },
      ControllerBootstrapReplacedError: class extends Error {},
      confirmControllerProcessesStopped: async (_controller, native) => native.length <= stopped,
      stopControllerProcesses: async (_controller, native) => { stopLists.push(native.map(item => item.pid)); stopped = native.length; },
    };
    await stopRecordedFixtureExecutions([record], expected, directory, proofs, Date.now() + 5_000);
    assert.deepEqual(stopLists, [[124], [124, 125]]);
    assert.equal(read, 3);
    const wrongTicket = { ...ticket, workerId: "other" }; await writeFile(ticketPath, JSON.stringify(wrongTicket));
    await assert.rejects(stopRecordedFixtureExecutions([record], expected, directory, proofs, Date.now() + 5_000), /ticket conflicts/);
    assert.deepEqual(stopLists, [[124], [124, 125]]);
    const unsubmitted = { ...record, webExecution: { ...execution, launchSubmission: "not-submitted", controllerProcess: null, nativeProcesses: [] } };
    await assert.rejects(stopRecordedFixtureExecutions([unsubmitted], expected, directory, proofs, Date.now() + 5_000), /preceding generation/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Bot fallback stops the recorded Controller tree from its own store, ticket and journal", async () => {
  const root = await scratch();
  try {
    const directory = path.join(root, "worker-config"), botId = "22222222-2222-4222-8222-222222222222";
    const expected = { projectId: "project", taskId: "task", workerId: "worker", userId: "user", serverOrigin: "https://daynight.example", repository: root, botId };
    assert.equal(await readFixtureBot(directory, botId), null);
    await stopRecordedFixtureBot(null, expected, directory, {} as FixtureStopProofs, Date.now() + 5_000);
    const storage = path.join(directory, "bots", botId, "controller");
    const ticketPath = path.join(storage, "launches", `${id}.json`), journalPath = path.join(storage, "executions", id, "journal.sqlite");
    const intent = { launchId: id, executionId: id, controllerInstanceId: "instance", sessionId: "session", executionGeneration: "1", ticketPath, journalPath,
      registration: { testExecutionId: id, controllerId: "controller" } };
    const ticket = { executionId: id, launchId: id, sessionId: "session", controllerId: "controller", controllerInstanceId: "instance", executionGeneration: "1",
      testExecutionId: id, ownerUserId: "user", serverOrigin: expected.serverOrigin, codexBotRecovery: { botId } };
    await mkdir(path.dirname(ticketPath), { recursive: true }); await writeFile(ticketPath, JSON.stringify(ticket), { mode: 0o600 });
    const execution = { launchId: id, executionId: id, executionGeneration: "1", launchSubmission: "acknowledged", controllerProcess: proof,
      snapshot: { nativeSessionId: "native", nativeProcesses: [{ ...proof, pid: 124 }] } };
    const db = new DatabaseSync(path.join(directory, "bots", botId, "store.sqlite"));
    for (const table of ["bots", "bot_executions"]) db.exec(`CREATE TABLE ${table} (server_origin TEXT, owner_user_id TEXT, worker_id TEXT, bot_id TEXT, record TEXT)`);
    const insert = (table: string, record: unknown) => db.prepare(`INSERT INTO ${table} VALUES (?, ?, ?, ?, ?)`).run(expected.serverOrigin, "user", "worker", botId, JSON.stringify(record));
    insert("bots", { botId, intent }); insert("bot_executions", execution); db.close();
    const record = await readFixtureBot(directory, botId);
    assert.deepEqual(record, { serverOrigin: expected.serverOrigin, ownerUserId: "user", workerId: "worker", botId, intent, execution });
    const nativeA = { ...proof, pid: 124 }, nativeB = { ...proof, pid: 125 };
    let stopped = 0; const stopLists: number[][] = [], journals: string[] = [];
    const proofs: FixtureStopProofs = {
      parseLaunchTicket: value => value as never,
      readCurrentControllerSnapshot: filename => { journals.push(filename); return { controllerProcess: proof, nativeProcesses: [nativeA, nativeB], nativeSessionId: "native" }; },
      preservesControllerProcessProof: (before, after) => JSON.stringify(before) === JSON.stringify(after),
      preservesNativeProcessPrefix: (before, after) => before.every((item, index) => JSON.stringify(item) === JSON.stringify(after[index])),
      preservesControllerEvidence: () => true,
      reconcileSubmittedControllerLaunch: async () => { throw new Error("unexpected launch reconciliation"); },
      stopControllerBootstrap: async () => { throw new Error("unexpected bootstrap stop"); },
      ControllerBootstrapReplacedError: class extends Error {},
      confirmControllerProcessesStopped: async (_controller, native) => native.length <= stopped,
      stopControllerProcesses: async (_controller, native) => { stopLists.push(native.map(item => item.pid)); stopped = native.length; },
    };
    await stopRecordedFixtureBot(record, expected, directory, proofs, Date.now() + 5_000);
    assert.deepEqual(stopLists, [[124, 125]]);
    assert.deepEqual(new Set(journals), new Set([journalPath]));
    await assert.rejects(stopRecordedFixtureBot({ ...record!, workerId: "other" }, expected, directory, proofs, Date.now() + 5_000), /identity conflicts/);
    await writeFile(ticketPath, JSON.stringify({ ...ticket, codexBotRecovery: { botId: id } }));
    await assert.rejects(stopRecordedFixtureBot(record, expected, directory, proofs, Date.now() + 5_000), /ticket conflicts/);
    const replaced = { ...record!, execution: { ...execution, snapshot: { nativeSessionId: "other", nativeProcesses: [] } } };
    await writeFile(ticketPath, JSON.stringify(ticket));
    await assert.rejects(stopRecordedFixtureBot(replaced, expected, directory, proofs, Date.now() + 5_000), /journal conflicts/);
    const unsubmitted = { ...record!, execution: { ...execution, launchSubmission: "not-submitted", controllerProcess: null, snapshot: null } };
    await stopRecordedFixtureBot(unsubmitted, expected, directory, proofs, Date.now() + 5_000);
    assert.deepEqual(stopLists, [[124, 125]]);

    // The Worker died after saving the spawn proof but before the Controller wrote its first snapshot.
    const preJournal = { ...record!, execution: { ...execution, snapshot: null } };
    for (const exit of ["controller-exited", "pre-writer-exited"] as const) {
      let journalWritten = false; const steps: string[] = []; stopped = 0; stopLists.length = 0;
      const recovering: FixtureStopProofs = { ...proofs,
        readCurrentControllerSnapshot: filename => {
          if (!journalWritten) throw new Error("journal is missing");
          return proofs.readCurrentControllerSnapshot(filename, ticket as never, 0);
        },
        reconcileSubmittedControllerLaunch: async input => {
          assert.equal(input.journalFile, journalPath); assert.deepEqual(input.spawnProof, proof);
          if (!steps.includes("bootstrap")) { steps.push("running"); return { kind: "running-unobserved" }; }
          steps.push(exit); journalWritten = exit === "controller-exited"; return { kind: exit };
        },
        stopControllerBootstrap: async controller => { assert.deepEqual(controller, proof); steps.push("bootstrap"); },
      };
      if (exit === "controller-exited") {
        await stopRecordedFixtureBot(preJournal, expected, directory, recovering, Date.now() + 5_000);
        assert.deepEqual(stopLists, [[124, 125]]);
      } else {
        await assert.rejects(stopRecordedFixtureBot(preJournal, expected, directory, recovering, Date.now() + 5_000),
          (error: AggregateError) => /bootstrap recovery/.test(error.message) && /native process stop remains unconfirmed/.test((error.errors[1] as Error).message));
        assert.deepEqual(stopLists, []);
      }
      assert.deepEqual(steps, ["running", "bootstrap", exit]);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("fallback loads all five production proof owners and refuses an incomplete set", async () => {
  const noop = () => {};
  const sources: Record<string, Record<string, unknown>> = {
    "commands/controller/process-proof.js": { stopControllerProcesses: noop, confirmControllerProcessesStopped: noop },
    "commands/controller/launch-ticket.js": { parseLaunchTicket: noop },
    "commands/controller/lifecycle-store.js": { readCurrentControllerSnapshot: noop },
    "commands/worker/backends/orchestration.js": { preservesControllerProcessProof: noop, preservesNativeProcessPrefix: noop, preservesControllerEvidence: noop },
    "commands/controller/launch-observation.js": { reconcileSubmittedControllerLaunch: noop, stopControllerBootstrap: noop, ControllerBootstrapReplacedError: class extends Error {} },
  };
  const loaded = await loadFixtureStopProofs(async name => sources[name]!);
  assert.equal(loaded.parseLaunchTicket, noop);
  assert.equal(loaded.readCurrentControllerSnapshot, noop);
  assert.equal(loaded.preservesControllerEvidence, noop);
  assert.equal(loaded.stopControllerBootstrap, noop);
  delete sources["commands/controller/lifecycle-store.js"]!.readCurrentControllerSnapshot;
  await assert.rejects(loadFixtureStopProofs(async name => sources[name]!), /proof implementation is unavailable/);
});
