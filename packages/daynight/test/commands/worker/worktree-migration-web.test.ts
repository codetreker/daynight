import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { createOperation } from "../../../src/api/operation.js";
import type { LocalTask } from "../../../src/commands/worker/backends/web-types.js";
import type { ResourceOwner } from "../../../src/commands/worker/types.js";
import { migrateLegacyWorktrees } from "../../../src/commands/worker/worktrees/migration.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", timeout: 15_000 }).trim();
const identity = (): ResourceOwner => ({ projectId: randomUUID(), taskId: randomUUID(), claimId: randomUUID(), worktreeId: randomUUID() });

test("migration publishes and unlocks only the Web journal owner", async () => {
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp/worktree-web-migration"); mkdirSync(base, { recursive: true });
  const root = mkdtempSync(path.join(base, "case-")); roots.push(root);
  git(root, "init", "-b", "main"); git(root, "config", "user.name", "Fixture"); git(root, "config", "user.email", "fixture@example.test");
  writeFileSync(path.join(root, "tracked"), "data"); git(root, "add", "tracked"); git(root, "commit", "-m", "fixture");
  const commonDirectory = git(root, "rev-parse", "--absolute-git-dir"), namespace = path.join(root, ".worktrees", "daynight"); mkdirSync(namespace, { recursive: true });
  const add = (owner: ResourceOwner) => {
    const cwd = path.join(namespace, owner.taskId), marker = `daynight-worker:${JSON.stringify(owner)}`;
    git(root, "worktree", "add", "--lock", "--reason", marker, "-b", `daynight/${owner.taskId}`, "--", cwd);
    return { cwd, marker, admin: git(cwd, "rev-parse", "--absolute-git-dir") };
  };
  const web = identity(), other = identity(), known = add(web), unknown = add(other);
  const binding = { repositoryPath: root, commonDirectory, worktreePath: known.cwd, branch: `daynight/${web.taskId}` };
  const record: LocalTask = { ...web, serverOrigin: "https://example.test", workerId: randomUUID(), userId: randomUUID(), status: "active", repoUrl: "https://example.test/repo.git", repositoryPath: root,
    configuration: { agent: "codex", agentControlMode: "web", model: null, args: [], recoveryLimit: 2 }, resources: { mode: "web", worktree: binding, herdr: null, nativeSession: null },
    recovery: { count: 0, pauseReason: null, retryAuthorized: false }, cleanup: null, control: null, webExecution: null, nativeExecution: null, createdAt: 1, updatedAt: 1 };
  const operation = createOperation({ limits: { totalMs: 60_000 } });
  try {
    const result = await migrateLegacyWorktrees({ repositoryPath: root, commonDirectory, operation, sources: { listSchedules: () => [], listWebTasks: () => [record] } });
    expect(result).toHaveLength(1); expect(result[0]).toMatchObject(web);
    expect(existsSync(path.join(known.admin, "locked"))).toBe(false);
    expect(readFileSync(path.join(unknown.admin, "locked"), "utf8").trim()).toBe(unknown.marker);
    expect(existsSync(path.join(commonDirectory, "daynight", "worktrees", `${other.worktreeId}.json`))).toBe(false);
  } finally { operation.dispose(); }
}, 90_000);
