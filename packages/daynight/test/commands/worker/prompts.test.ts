import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkerPromptBuilder, workerCleanupPrompt, workerPingPrompt } from "../../../src/commands/worker/prompts.js";
import type { ManagedAssignment } from "../../../src/commands/worker/prompts.js";

const directories: string[] = [];
const uuid = (number: number) => `00000000-0000-4000-8000-${number.toString().padStart(12, "0")}`;
const fixture = async () => {
  const root = path.resolve("../../.tmp/worker-prompt-tests");
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(path.join(root, "p-")); directories.push(directory);
  const packageDirectory = path.join(directory, "package");
  await cp(path.resolve("src/commands/skill/skills/using-daynight"), path.join(packageDirectory, "dist/commands/skill/skills/using-daynight"), { recursive: true });
  const repositoryPath = path.join(directory, "repository");
  const task: ManagedAssignment = {
    projectId: uuid(1), taskId: uuid(2), claimId: uuid(3), status: "active", agent: "codex", sessionId: null,
    serverOrigin: "https://daynight.example", workerId: uuid(4), worktreeId: uuid(5),
    configuration: { agent: "codex", model: "current-model", args: ["--search"], recoveryLimit: 2 },
    worktree: { repositoryPath, commonDirectory: path.join(repositoryPath, ".git"), worktreePath: path.join(repositoryPath, ".worktrees", "daynight", uuid(2)), branch: `daynight/${uuid(2)}` },
  };
  return { packageDirectory, task, build: await createWorkerPromptBuilder(packageDirectory) };
};
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });

describe("worker managed prompts", () => {
  it("passes the explicit managed entry and current assignment", async () => {
    const { task, build, packageDirectory } = await fixture(); const prompt = build(task, "linux");
    expect(prompt).toContain("environment is worker-managed");
    expect(prompt).toContain("using-daynight skill in execute-task-in-managed mode");
    expect(prompt).toContain("This is a background task. Do not ask the user any questions.");
    expect(prompt).toContain("Make decisions autonomously within this assignment and its existing authorization.");
    expect(prompt).toContain("do not end this turn or exit merely because review or CI is pending");
    expect(prompt).toContain(JSON.stringify(path.join(packageDirectory, "dist/commands/skill/skills/using-daynight/references/execute-task-in-managed.md")));
    expect(JSON.parse(prompt.split("Assignment:\n\n")[1]!)).toEqual({ serverOrigin: task.serverOrigin, projectId: task.projectId, taskId: task.taskId, claimId: task.claimId, workerId: task.workerId, worktreeId: task.worktreeId, worktreePath: task.worktree.worktreePath, branch: task.worktree.branch, platform: "linux", nativeSessionId: null, configuration: task.configuration });
  });
  it("identifies a known native conversation when resuming", async () => {
    const { task, build } = await fixture(); task.sessionId = uuid(6);
    const prompt = build(task, "windows"); expect(prompt).toContain("original native conversation");
    expect(JSON.parse(prompt.split("Assignment:\n\n")[1]!).nativeSessionId).toBe(uuid(6));
  });
  it.each(["agent", "branch", "claim", "status"])("rejects mismatched %s before input", async (field) => {
    const { task, build } = await fixture();
    if (field === "agent") task.configuration.agent = "copilot";
    if (field === "branch") task.worktree.branch = "main";
    if (field === "claim") task.claimId = "wrong";
    if (field === "status") task.status = "pending";
    expect(() => build(task, "linux")).toThrow();
  });
  it("requires the installed managed reference", async () => {
    const { packageDirectory } = await fixture();
    await rm(path.join(packageDirectory, "dist/commands/skill/skills/using-daynight/references/execute-task-in-managed.md"));
    await expect(createWorkerPromptBuilder(packageDirectory)).rejects.toThrow("missing references/execute-task-in-managed.md");
  });
  it("uses the current cleanup attempt deadline", async () => {
    const { task } = await fixture(); const deadline = 601_000; const prompt = workerCleanupPrompt(task, deadline);
    expect(prompt).toContain(task.claimId); expect(prompt).toContain(new Date(deadline).toISOString());
    expect(prompt).toContain("outside the worktree"); expect(prompt).toContain("Preserve the controller-managed worktree");
  });
  it("keeps review and CI waits inside the background assignment", async () => {
    const { task } = await fixture(); const prompt = workerPingPrompt(task);
    expect(prompt).toContain(task.projectId); expect(prompt).toContain(task.taskId); expect(prompt).toContain(task.claimId);
    expect(prompt).toContain("original native conversation and worktree");
    expect(prompt).toContain("do not ask the user any questions");
    expect(prompt).toContain("Make decisions autonomously within that scope and authorization");
    expect(prompt).toContain("wait and check it periodically yourself");
    expect(prompt).toContain("do not end this turn or exit merely because review or CI is pending");
    expect(prompt).toContain("all required delivery, acceptance and evidence");
    expect(prompt).toContain("Reconcile unconfirmed writes");
  });
});
