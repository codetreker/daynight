import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach } from "vitest";
import { openHerdrLifecycleStore, type HerdrLifecycleStore } from "../../../src/commands/worker/herdr/lifecycle-store.js";
import type { HerdrLifecycleRecord, HerdrLocalRun, MacProcessIdentity } from "../../../src/commands/worker/herdr/lifecycle-types.js";
import { createMemoryDatabase } from "../../helpers/sqlite.js";

export const createHerdrLifecycleStoreFixtures = (storage: "memory" | "file") => {
  const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

  const owner = { projectId: uuid(1), taskId: uuid(2), workerId: uuid(3), worktreeId: uuid(4), ownerUserId: uuid(5), serverOrigin: "https://daynight.example", provider: "codex" as const };

  const identity = { projectId: owner.projectId, taskId: owner.taskId, claimId: uuid(6) };

  const start = "2026-11-04T00:00:00.000Z";

  const finish = "2026-11-04T00:01:00.000Z";

  const root = fileURLToPath(new URL("../../../../../.tmp/herdr-lifecycle-store/", import.meta.url));

  const stores = new Set<HerdrLifecycleStore>();

  const directories: string[] = [];

  const memoryDatabases = new Map<string, Database.Database>();
  const connect = (file: string) => { const existing = memoryDatabases.get(file); if (existing !== undefined) return existing; const db = createMemoryDatabase(); memoryDatabases.set(file, db); return db; };
  const open = (file: string) => { const store = openHerdrLifecycleStore(storage === "memory" ? connect(file) : file, { onMigration: () => {} }); stores.add(store); return store; };

  const close = (store: HerdrLifecycleStore) => { store.close(); stores.delete(store); };

  const fixture = () => {
    mkdirSync(root, { recursive: true });
    const directory = mkdtempSync(path.join(root, "run-")); directories.push(directory);
    const file = path.join(directory, "herdr.sqlite"), store = open(file);
    const record = store.create({ owner, claimId: identity.claimId, cwd: directory }, start);
    return { directory, file, store, record };
  };

  const processIdentity = (role: MacProcessIdentity["role"], pid: number): MacProcessIdentity => ({ role, pid, birthToken: `1700000000:${pid}`, bootId: "boot-one", auditToken: [501, 501, 20, 501, 20, pid, 100000, pid + 100], ppid: 1, pgid: pid, sid: pid });

  const prepared = (directory: string): HerdrLocalRun => ({
    run: { executionGeneration: "1", owner, binding: { instanceId: "daemon-one", sessionId: "w", workspaceId: "workspace-one", paneId: "pane-one", terminalId: "terminal-one", nativeSessionId: null }, startedAt: start, stoppedAt: null, stopProof: null, segmentIds: [] },
    phase: "prepared", nativeLaunch: "not_submitted", instanceDirectory: directory, daemon: null, processes: [], stopOperationId: null, stopReason: null, error: null, admission: null,
  });

  const active = (f: ReturnType<typeof fixture>): HerdrLifecycleRecord => {
    let record = f.store.update(f.record, draft => { draft.runs.push(prepared(f.directory)); });
    record = f.store.update(record, draft => { const run = draft.runs[0]!; run.phase = "launch_requested"; run.nativeLaunch = "requested"; run.daemon = processIdentity("daemon", 101); });
    return f.store.update(record, draft => { const run = draft.runs[0]!; run.phase = "active"; run.nativeLaunch = "observed"; run.processes = [processIdentity("shell", 102), processIdentity("agent", 103)]; run.admission = uuid(7); });
  };

  const stopped = (f: ReturnType<typeof fixture>, record: HerdrLifecycleRecord) => {
    record = f.store.update(record, draft => { const run = draft.runs[0]!; run.phase = "stop_intent"; run.stopOperationId = uuid(8); run.stopReason = "shutdown"; run.admission = null; });
    record = f.store.update(record, draft => { draft.runs[0]!.phase = "close_requested"; });
    return f.store.update(record, draft => {
      const local = draft.runs[0]!; local.phase = "stopped_confirmed"; local.run.stoppedAt = finish;
      local.run.stopProof = { recordId: uuid(8), executionGeneration: "1", binding: local.run.binding, bootId: "boot-one", stoppedAt: finish, method: "instances_exited", terminalStopped: true, processes: local.processes.map(({ role, pid, birthToken, bootId }) => ({ role: role as "shell" | "agent", pid, birthToken, bootId })) };
    });
  };

  afterEach(() => { memoryDatabases.clear(); for (const store of stores) store.close(); stores.clear(); for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
  return { uuid, owner, identity, start, finish, open, close, fixture, processIdentity, prepared, active, stopped };
};
