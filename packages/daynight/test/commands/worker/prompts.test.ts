import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkerPromptBuilder, workerCleanupPrompt } from "../../../src/commands/worker/prompts.js";
import type { LocalTask } from "../../../src/commands/worker/types.js";

const directories: string[] = [];
const uuid = (number: number) => `00000000-0000-4000-8000-${number.toString().padStart(12, "0")}`;
const fixture = async () => {
  const root = path.resolve("../../.tmp/worker-prompt-tests");
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(path.join(root, "p-"));
  directories.push(directory);
  const packageDirectory = path.join(directory, "package");
  const source = path.resolve("src/commands/skill/skills/using-daynight");
  await cp(source, path.join(packageDirectory, "dist/commands/skill/skills/using-daynight"), { recursive: true });
  const repositoryPath = path.join(directory, "repository");
  const task: LocalTask = {
    serverOrigin: "https://daynight.example", projectId: uuid(1), taskId: uuid(2), claimId: uuid(3), workerId: uuid(4), worktreeId: uuid(5),
    status: "active", repoUrl: "https://github.com/owner/repo.git", repositoryPath,
    configuration: { agent: "codex", model: "explicit-model", args: ["-c", "model_reasoning_effort=high"], recoveryLimit: 2 },
    resources: { worktree: { repositoryPath, commonDirectory: path.join(repositoryPath, ".git"), worktreePath: path.join(repositoryPath, ".worktrees/daynight", uuid(2)), branch: `daynight/${uuid(2)}` }, herdr: null, nativeSession: null },
    nativeExecution: null, recovery: { count: 0, pauseReason: null, retryAuthorized: false }, cleanup: null, control: null,
    createdAt: 0, updatedAt: 0,
  };
  return { packageDirectory, task, build: await createWorkerPromptBuilder(packageDirectory) };
};

afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });

describe("worker managed prompt production", () => {
  it("passes the exact original assignment and explicit installed managed entry", async () => {
    const { task, build, packageDirectory } = await fixture();
    const prompt = build(task, "linux");
    expect(prompt).toContain("environment is worker-managed");
    expect(prompt).toContain("using-daynight skill in execute-task-in-managed mode");
    expect(prompt).toContain(JSON.stringify(path.join(packageDirectory, "dist/commands/skill/skills/using-daynight/references/execute-task-in-managed.md")));
    const assignment = JSON.parse(prompt.split("Assignment:\n\n")[1]!);
    expect(assignment).toEqual({ serverOrigin: task.serverOrigin, projectId: task.projectId, taskId: task.taskId, claimId: task.claimId, workerId: task.workerId, worktreeId: task.worktreeId, worktreePath: task.resources.worktree!.worktreePath, branch: task.resources.worktree!.branch, platform: "linux", nativeSession: null, configuration: task.configuration });
  });

  it("carries original native history and frozen arguments into a restart prompt", async () => {
    const { task, build } = await fixture();
    task.resources.nativeSession = { sessionId: uuid(6), source: "herdr" };
    const prompt = build(task, "windows");
    expect(prompt).toContain("Continue this same execution");
    const assignment = JSON.parse(prompt.split("Assignment:\n\n")[1]!);
    expect(assignment.nativeSession.sessionId).toBe(uuid(6));
    expect(assignment.configuration).toEqual(task.configuration);
  });

  it.each(["configuration", "worktree", "branch", "claim", "control", "status"])("refuses incomplete or mismatched %s before Herdr receives text", async (field) => {
    const { task, build } = await fixture();
    switch (field) {
      case "configuration": task.configuration = null; break;
      case "worktree": task.resources.worktree = null; break;
      case "branch": task.resources.worktree!.branch = "main"; break;
      case "claim": task.claimId = "wrong"; break;
      case "control": task.control = { intent: { kind: "release", sourceClaimId: task.claimId, version: "1" }, requestedAt: 1, submission: "not-submitted", submittedAt: null, outcome: null, resultVersion: null, error: null }; break;
      case "status": task.status = "pending"; break;
    }
    expect(() => build(task, "linux")).toThrow();
  });

  it("requires the shipped managed resource, not only a skill declaration", async () => {
    const { packageDirectory } = await fixture();
    await rm(path.join(packageDirectory, "dist/commands/skill/skills/using-daynight/references/execute-task-in-managed.md"));
    await expect(createWorkerPromptBuilder(packageDirectory)).rejects.toThrow("missing references/execute-task-in-managed.md");
  });

  it("keeps a cleanup request bound to the persisted original deadline and resources", async () => {
    const { task } = await fixture();
    expect(() => workerCleanupPrompt(task)).toThrow("persisted original deadline");
    task.cleanup = { kind: "terminal", startedAt: 1_000, deadline: 601_000, input: "not-submitted", baseline: null, result: null, error: null, agentStopped: false, workspaceClosed: false, worktreeDeleted: false };
    const prompt = workerCleanupPrompt(task);
    expect(prompt).toContain(task.claimId);
    expect(prompt).toContain(new Date(task.cleanup.deadline).toISOString());
    expect(prompt).toContain("outside the worktree");
    expect(prompt).toContain("Preserve the controller-managed worktree");
  });
});
