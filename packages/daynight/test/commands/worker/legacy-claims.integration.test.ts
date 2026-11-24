import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { expect, it, vi } from "vitest";
import { importInterruptedWorkerClaims } from "../../../src/commands/worker/legacy-claims.js";
import { resolveWorkerPaths } from "../../../src/commands/worker/paths.js";
import { openWorkerStore } from "../../../src/commands/worker/store.js";

it("imports a legacy unknown claim using its original operation ID and frozen configuration", () => {
  const temporary = path.resolve(import.meta.dirname, "../../../../../.tmp");
  mkdirSync(temporary, { recursive: true });
  const home = mkdtempSync(path.join(temporary, "legacy-claim-"));
  vi.stubEnv("DN_CONFIG_DIR", path.join(home, "config"));
  try {
    const { workerDirectory, databaseFile } = resolveWorkerPaths(home);
    mkdirSync(workerDirectory, { recursive: true, mode: 0o700 });
    const owner = { serverOrigin: "https://example.test", userId: randomUUID(), workerId: randomUUID() };
    const projectId = randomUUID(), taskId = randomUUID(), claimId = randomUUID(), worktreeId = randomUUID();
    const candidateVersion = "9007199254740993";
    const frozenConfiguration = { agent: "codex", args: ["--fixture"], model: "original" };
    const evidence = new Database(path.join(workerDirectory, "lifecycle.sqlite"));
    try {
      evidence.exec(`
        PRAGMA user_version=1;
        CREATE TABLE lifecycle_state(singleton INTEGER, server_origin TEXT, user_id TEXT, worker_id TEXT, format_version INTEGER);
        CREATE TABLE resource_owners(resource_id TEXT PRIMARY KEY, owner_kind TEXT, identity_json TEXT, instance_id TEXT,
          instance_epoch INTEGER, scope_generation INTEGER, admission_operation_id TEXT, stage TEXT,
          process_proof_json TEXT, stop_proof_json TEXT, save_state TEXT, last_error TEXT);
        CREATE TABLE resource_history(resource_id TEXT PRIMARY KEY, content_hash TEXT, payload BLOB);
      `);
      evidence.prepare("INSERT INTO lifecycle_state VALUES(1, ?, ?, ?, 1)").run(owner.serverOrigin, owner.userId, owner.workerId);
      const identity = JSON.stringify({ candidateVersion, claimId, frozenConfiguration, kind: "task_claim", projectId, taskId, worktreeId });
      evidence.prepare("INSERT INTO resource_owners VALUES(?, 'task', ?, ?, 1, 1, ?, 'unknown', NULL, NULL, 'durable', NULL)")
        .run(randomUUID(), identity, randomUUID(), claimId);
    } finally { evidence.close(); }
    const store = openWorkerStore(databaseFile, { onMigration: () => {} });
    try {
      store.registerProject({ projectId, repoUrl: "https://example.test/original/repo.git", localPath: home });
      importInterruptedWorkerClaims(home, owner, store);
      importInterruptedWorkerClaims(home, owner, store);
      expect(store.listClaimToolReservations()).toEqual([{
        projectId, taskId, claimId, worktreeId, workerId: owner.workerId, version: BigInt(candidateVersion),
        agentControlMode: "web", nativeConfiguration: frozenConfiguration,
      }]);
      expect(store.listTasks()).toEqual([]);
    } finally { store.close(); }
  } finally {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  }
});
