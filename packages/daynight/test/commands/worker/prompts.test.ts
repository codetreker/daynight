import path from "node:path";
import { describe, expect, it } from "vitest";
import { appendWorkerPrompts, buildWorkerPrompt, workerCleanupPrompt, workerContinuationPrompt, workerPingPrompt } from "../../../src/commands/worker/prompts.js";
import type { ManagedAssignment } from "../../../src/commands/worker/prompts.js";

const authorizationInstruction = "You already have sufficient authorization to complete this task; do not ask the user again for authorization on procedural matters, such as whether merging the PR is authorized.";
const expectStartupAuthorization = (prompt: string) => {
  expect(prompt).toContain(`This is a background task. Make decisions autonomously within this assignment and its existing authorization.\n\n${authorizationInstruction}\n\nPreserve the supplied service, Project, Task, original claim`);
};

const uuid = (number: number) => `00000000-0000-4000-8000-${number.toString().padStart(12, "0")}`;
const fixture = () => {
  const repositoryPath = path.resolve("isolated-project-without-repository-skills");
  const task: ManagedAssignment = {
    projectId: uuid(1), taskId: uuid(2), claimId: uuid(3), status: "active", agent: "codex", sessionId: null,
    serverOrigin: "https://daynight.example", workerId: uuid(4), worktreeId: uuid(5),
    configuration: { agent: "codex", model: "current-model", args: ["--search"], recoveryLimit: 2 },
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
    expect(prompt).toContain("environment is worker-managed");
    expect(prompt).toContain("Use daynight --skill for product operations");
    expect(prompt).not.toContain("autopilot-managed-task");
    expect(prompt).toContain("This is a background task.");
    expect(prompt).toContain("Make decisions autonomously within this assignment and its existing authorization.");
    expectStartupAuthorization(prompt);
    expect(prompt).toContain("do not end this turn or exit merely because review or CI is pending");
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
    expectStartupAuthorization(prompt);
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
  it.each(["startup", "resume", "continuation", "periodic"])("keeps claim, pause, recovery and completion obligations in the %s prompt", (kind) => {
    const { task, build } = fixture();
    if (kind === "resume") task.sessionId = uuid(6);
    const prompt = kind === "periodic" ? workerPingPrompt(task) : kind === "continuation" ? workerContinuationPrompt(task) : build(task, "macos");
    expect(prompt).toContain("verify the original active claim, Worker and worktree");
    expect(prompt).toContain("--if-version <observed-version>");
    expect(prompt).toContain("paused false --project <project-id>");
    expect(prompt).toContain("if the user already cleared it, verify the state without writing again");
    expect(prompt).toContain("Honor independent pauses and revocations");
    expect(prompt).toContain("--claim-id <original-claim-id>");
    expect(prompt).toContain("final task mutation");
    expect(prompt).toContain("properties.worker.state=completed");
    expect(prompt).toContain("do not automatically replay it, use ordinary completion to bypass the claim");
    expect(prompt).toContain("If allowAgents is false, stop immediately");
    expect(prompt).toContain("stop task-related writes");
    expect(prompt).toContain("The controller owns scheduling and its worktree, branch and workspace");
    expect(prompt).not.toContain("development-workflow");
  });
  it.each(["startup", "resume", "continuation", "periodic"])("delivers action ownership and authorization rules before review waits in the %s prompt", (kind) => {
    const { task, build } = fixture();
    if (kind === "resume") task.sessionId = uuid(6);
    const prompt = kind === "periodic" ? workerPingPrompt(task) : kind === "continuation" ? workerContinuationPrompt(task) : build(task, "macos");
    expect(prompt).toContain("Before waiting, determine who owns the next action");
    expect(prompt).toContain("current PR HEAD and the complete set of unresolved review threads, including previously known comments");
    expect(prompt).toContain("Incomplete pages or failed reads leave review state unknown");
    expect(prompt).toContain("No new comments does not mean no unresolved work");
    expect(prompt).toContain("Address actionable feedback within existing scope and authorization before polling again");
    expect(prompt).toContain("Removing unrelated changes from this PR does not authorize delivering those changes separately");
    expect(prompt).toContain("Permission to publish a reply and permission to modify or validate code are separate");
    expect(prompt).toContain("only when the next action belongs to a reviewer, CI or another external party");
    expect(prompt).toContain("Avoid repeated unchanged progress announcements");
    expect(prompt).toContain("Native working activity and successful polling do not prove delivery progress");
    expect(prompt).toContain("a required action lacks authorization and no remaining authorized work can advance the assignment");
    expect(prompt).toContain("identify the exact action, the instruction or restriction withholding permission, and the authorization needed");
    expect(prompt).toContain("Existing assignment and session authorization persists; do not request it again as procedural confirmation");
  });
  it("uses the current cleanup attempt deadline", async () => {
    const { task } = fixture(); const deadline = 601_000; const prompt = workerCleanupPrompt(task, deadline);
    expect(prompt).toContain(task.claimId); expect(prompt).toContain(new Date(deadline).toISOString());
    expect(prompt).toContain("outside the worktree"); expect(prompt).toContain("Preserve the controller-managed worktree");
  });
  it.each(["startup", "resume", "periodic"])("keeps review and CI waits inside the background assignment in the %s prompt", async (kind) => {
    const { task, build } = fixture();
    if (kind === "resume") task.sessionId = uuid(6);
    const prompt = kind === "periodic" ? workerPingPrompt(task) : build(task, "linux");
    expect(prompt).toContain(task.projectId); expect(prompt).toContain(task.taskId); expect(prompt).toContain(task.claimId);
    expect(prompt).toContain(kind === "periodic" ? "Make decisions autonomously within that scope and authorization" : "Make decisions autonomously within this assignment and its existing authorization");
    if (kind === "periodic") {
      expect(prompt).toContain("original native conversation and worktree");
      expect(prompt).toContain("result is unknown");
    }
    expect(prompt).toContain("wait and check it periodically yourself");
    expect(prompt).toContain("Pending PR review, required reviewer approval, CI results and polling timeouts are not reasons to set properties.paused=true or request user intervention");
    expect(prompt).toContain("do not end this turn or exit merely because review or CI is pending");
    expect(prompt).toContain("Honor independent user pauses, restrictions and revocations");
    expect(prompt).toContain("all required delivery, acceptance and evidence");
  });
  it.each(["startup", "resume", "continuation", "periodic"])("preserves execution boundaries and design-conflict evidence in the %s prompt", (kind) => {
    const { task, build } = fixture();
    if (kind === "resume") task.sessionId = uuid(6);
    const prompt = kind === "periodic" ? workerPingPrompt(task) : kind === "continuation" ? workerContinuationPrompt(task) : build(task, "macos");
    expect(prompt).toContain("inspect the current task, repository rules and available evidence");
    expect(prompt).toContain("adjust the implementation approach, steps and task-level decisions");
    expect(prompt).toContain("investigate and choose a feasible alternative");
    expect(prompt).toContain("confirmed business goal, task scope, acceptance criteria, external commitments and existing authorization");
    expect(prompt).toContain("record significant deviations and their reasons");
    expect(prompt).toContain("Ordinary information gaps, unavailable tools, failed approaches, recoverable errors and obsolete plan steps do not by themselves justify a pause");
    expect(prompt).toContain("confirmed requirements or architecture constraints cannot all be met, no feasible alternative preserves the confirmed goal and constraints, and resolving it requires changing a confirmed constraint");
    expect(prompt).toContain("record the conflict evidence, affected requirements, alternatives considered and the specific decision needed");
    expect(prompt).toContain("set properties.paused=true on your own assigned task using the exact version observed");
    expect(prompt).toContain("Read the task back to confirm the pause and original assignment");
    expect(prompt).toContain("Clear your pause only when resuming is permitted");
    expect(prompt).toContain("If allowAgents is false, stop immediately");
    expect(prompt).toContain("If the original claim or assignment no longer matches, stop task-related writes");
    expect(prompt).toContain("permission is withdrawn, or an independent pause applies");
    expect(prompt).not.toContain("When completing this assignment requires specific information");
    expect(prompt).toContain("do not end this turn or exit merely because review or CI is pending");
  });
});
