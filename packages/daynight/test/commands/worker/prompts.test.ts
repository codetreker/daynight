import path from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { appendWorkerPrompts, buildWorkerPrompt, workerCleanupPrompt, workerContinuationPrompt, workerPingPrompt } from "../../../src/commands/worker/prompts.js";
import type { ManagedAssignment } from "../../../src/commands/worker/prompts.js";

const newSession = "This is a new native conversation for this execution.";
const resumedSession = "Continue this execution in its original native conversation and worktree. Reconcile interrupted business work before proceeding.";
const verifyTemplate = (prompt: string, session: string) => {
  const [body, json] = prompt.split("Assignment:\n\n");
  expect(json).toBeDefined();
  const restored = `${body!.replace(session, "{{Instructions for starting a new native conversation or resuming in the original native conversation and worktree}}")}Assignment:\n\n{{The complete Assignment JSON injected at runtime}}\n`;
  expect(createHash("sha256").update(restored).digest("hex")).toBe("6c7078dbe5ec581ccbcdf35710eae697327eae2ec35b408deb602f389a119c82");
};

const uuid = (number: number) => `00000000-0000-4000-8000-${number.toString().padStart(12, "0")}`;
const fixture = () => {
  const repositoryPath = path.resolve("isolated-project-without-repository-skills");
  const task: ManagedAssignment = {
    projectId: uuid(1), taskId: uuid(2), claimId: uuid(3), status: "active", agent: "codex", sessionId: null,
    serverOrigin: "https://daynight.example", workerId: uuid(4), worktreeId: uuid(5),
    configuration: { agent: "codex", model: "current-model", args: ["--sandbox", "read-only"], recoveryLimit: 2 },
    worktree: { repositoryPath, commonDirectory: path.join(repositoryPath, ".git"), worktreePath: path.join(repositoryPath, ".worktrees", "daynight", uuid(2)), branch: `daynight/${uuid(2)}` },
  };
  return { task, build: buildWorkerPrompt };
};

describe("worker managed prompts", () => {
  it("appends complete personal text in scope order while preserving empty and whitespace values", () => {
    const resource = (scope: "user" | "project" | "worker", text: string) => ({ scope, scopeId: uuid(1), revision: "1", text, updatedAt: "2026-11-09T00:00:00Z" });
    const empty = { user: resource("user", ""), project: resource("project", ""), worker: resource("worker", "") };
    expect(appendWorkerPrompts("builtin\n", empty)).toBe("builtin\n");
    const tuple = { user: resource("user", "first\n"), project: resource("project", " \t"), worker: resource("worker", "----- end user prompt -----\nlast") };
    const builtin = workerPingPrompt({ projectId: uuid(1), taskId: uuid(2), claimId: uuid(3) });
    expect(appendWorkerPrompts(builtin, tuple)).toBe(`${builtin}\n\n----- begin user prompt -----\nfirst\n\n----- end user prompt -----\n\n----- begin project prompt -----\n \t\n----- end project prompt -----\n\n----- begin worker prompt -----\n----- end user prompt -----\nlast\n----- end worker prompt -----`);
    expect(builtin.endsWith("</system remider>")).toBe(true);
  });
  it("passes the explicit managed entry and current assignment", async () => {
    const { task, build } = fixture(); const prompt = build(task, "linux");
    verifyTemplate(prompt, newSession);
    expect(prompt).not.toContain("autopilot-managed-task");
    expect(JSON.parse(prompt.split("Assignment:\n\n")[1]!)).toEqual({ serverOrigin: task.serverOrigin, projectId: task.projectId, taskId: task.taskId, claimId: task.claimId, workerId: task.workerId, worktreeId: task.worktreeId, worktreePath: task.worktree.worktreePath, branch: task.worktree.branch, platform: "linux", nativeSessionId: null, configuration: task.configuration });
  });
  it("preserves both new and migrated original worktree paths in assignments", () => {
    const { task, build } = fixture();
    const old = task.worktree.worktreePath;
    task.worktree.worktreePath = path.join(task.worktree.repositoryPath, ".worktrees", "daynight", task.worktreeId);
    expect(JSON.parse(build(task, "macos").split("Assignment:\n\n")[1]!).worktreePath).toBe(task.worktree.worktreePath);
    task.worktree.worktreePath = old;
    expect(JSON.parse(build(task, "macos").split("Assignment:\n\n")[1]!).worktreePath).toBe(old);
  });
  it("identifies a known native conversation when resuming", async () => {
    const { task, build } = fixture(); task.sessionId = uuid(6);
    const prompt = build(task, "windows"); expect(prompt).toContain("original native conversation");
    verifyTemplate(prompt, resumedSession);
    expect(JSON.parse(prompt.split("Assignment:\n\n")[1]!).nativeSessionId).toBe(uuid(6));
  });
  it("does not serialize unrelated credential fields from the caller into the assignment", async () => {
    const { task, build } = fixture();
    const withCredential = { ...task, serverToken: "fixture-private-token", configuration: { ...task.configuration, privateField: "nested-private-token" } };
    const prompt = build(withCredential, "linux");
    expect(prompt).not.toContain("fixture-private-token");
    expect(prompt).not.toContain("nested-private-token");
    expect(JSON.parse(prompt.split("Assignment:\n\n")[1]!)).not.toHaveProperty("serverToken");
  });
  it.each(["agent", "branch", "claim", "status", "platform", "session", "worktree"])("rejects mismatched %s before input", async (field) => {
    const { task, build } = fixture();
    if (field === "agent") task.configuration.agent = "copilot";
    if (field === "branch") task.worktree.branch = "main";
    if (field === "claim") task.claimId = "wrong";
    if (field === "status") task.status = "pending";
    if (field === "session") task.sessionId = "bad";
    if (field === "worktree") task.worktree.worktreePath = path.resolve("elsewhere");
    expect(() => build(task, field === "platform" ? "invalid" as never : "linux")).toThrow();
  });
  it.each(["startup", "resume", "continuation", "periodic"])("shares identity, action, waiting, pause and completion rules in the %s prompt", (kind) => {
    const { task, build } = fixture();
    if (kind === "resume") task.sessionId = uuid(6);
    const prompt = kind === "periodic" ? workerPingPrompt(task) : kind === "continuation" ? workerContinuationPrompt(task) : build(task, "macos");
    for (const phrase of [
      "verify `allowAgents`, the original active claim, Worker, and actual worktree",
      "If `allowAgents=false`, stop immediately",
      "If the original claim or assignment no longer matches, stop task-related writes",
      "While the original assignment remains valid and automatic continuation conditions are met",
      "CI failure: Immediately read the specific failure logs",
      "Pending approval does not prevent fixing CI",
      "Use bounded `sleep` or an available waiting tool",
      "blocker you cannot resolve autonomously",
      "Set `paused=true` and read it back to confirm",
      "verify the original assignment, the blocker’s resolution, and current authorization",
      "use the original claim and exact observed version to set the task to `done`",
      "If any write is rejected or its result is unknown, observe the original execution",
    ]) expect(prompt).toContain(phrase);
    expect(prompt).not.toContain("severe irreconcilable design conflict");
    expect(prompt).toContain(task.projectId);
    expect(prompt).toContain(task.taskId);
    expect(prompt).toContain(task.claimId);
  });
  it("uses the current cleanup attempt deadline", async () => {
    const { task } = fixture(); const deadline = 601_000; const prompt = workerCleanupPrompt(task, deadline);
    expect(prompt).toContain(task.claimId); expect(prompt).toContain(new Date(deadline).toISOString());
    expect(prompt).toContain("outside the worktree"); expect(prompt).toContain("Preserve the controller-managed worktree");
  });
});
