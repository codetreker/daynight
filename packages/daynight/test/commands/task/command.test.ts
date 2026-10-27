import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, createOperation, parseApiJson } from "../../../src/api/index.js";
import type { ApiClient, Operation, Project, Task, TaskGraph } from "../../../src/api/index.js";
import { UsageError } from "../../../src/cli/context.js";
import { runTaskCommand } from "../../../src/commands/task/command.js";
import type { TaskCommandDependencies } from "../../../src/commands/task/command.js";
import { renderTask, renderTaskList } from "../../../src/commands/task/rendering.js";

const projectId = "abcdefab-1111-4222-8333-123456789abc";
const taskId = "abcdefab-2222-4222-8333-123456789abc";
const dependencyId = "abcdefab-3333-4222-8333-123456789abc";
const otherDependencyId = "abcdefab-4444-4222-8333-123456789abc";
const claimId = "abcdefab-5555-4222-8333-123456789abc";
const time = "2026-10-20T00:00:00.123456789Z";
const project: Project = { id: projectId, name: "Project", repoUrl: "git@git.example:Org/Repo.git", settings: { version: 1n, executionWarningMinutes: 60 }, createdAt: time, updatedAt: time };
const task: Task = { id: taskId, projectId, title: "Task title", description: "Description", properties: { worker: null, pullRequests: [] }, status: "todo", allowAgents: false, requiredPlatform: null, version: 9_007_199_254_740_993n, ready: true, dependsOn: [], externalDependsOn: [], blockedBy: [], startedAt: null, completedAt: null, createdAt: time, updatedAt: time };
const graph: TaskGraph = { observedAt: time, project, summary: { total: 1, todo: 1, inProgress: 0, done: 0, ready: 1, blocked: 0 }, tasks: [{ id: taskId, titlePreview: `Task title${"T".repeat(150)}`, titleTruncated: true, allowAgents: false, requiredPlatform: null, status: "todo", ready: true, dependsOn: [], externalDependsOn: [], blockedBy: [], startedAt: null, completedAt: null, createdAt: time, updatedAt: time }] };
const operations: Operation[] = [];
afterEach(() => { operations.splice(0).forEach((operation) => operation.dispose()); });
const fixture = (operation = createOperation()) => {
  operations.push(operation);
  const api = {
    getCurrentUser: vi.fn<ApiClient["getCurrentUser"]>(),
    listProjectMembers: vi.fn<ApiClient["listProjectMembers"]>(),
    createProject: vi.fn<ApiClient["createProject"]>(), listProjects: vi.fn<ApiClient["listProjects"]>(),
    getProject: vi.fn<ApiClient["getProject"]>().mockResolvedValue(project),
    createTask: vi.fn<ApiClient["createTask"]>().mockResolvedValue(task), getTask: vi.fn<ApiClient["getTask"]>().mockResolvedValue(task),
    listTasks: vi.fn<ApiClient["listTasks"]>().mockResolvedValue([task]), listReadyTasks: vi.fn<ApiClient["listReadyTasks"]>().mockResolvedValue([task]), updateTask: vi.fn<ApiClient["updateTask"]>().mockResolvedValue(task),
    deleteTask: vi.fn<ApiClient["deleteTask"]>().mockResolvedValue(),
    setTaskStatus: vi.fn<ApiClient["setTaskStatus"]>().mockResolvedValue(task),
    listTaskPage: async () => { throw new Error("Unused worker API method"); },
    claimWorkerTask: async () => { throw new Error("Unused worker API method"); },
    updateWorkerClaim: async () => { throw new Error("Unused worker API method"); },
    completeWorkerTask: vi.fn<ApiClient["completeWorkerTask"]>().mockResolvedValue(task),
    releaseWorkerClaim: async () => { throw new Error("Unused worker API method"); },
    withdrawWorkerClaim: async () => { throw new Error("Unused worker API method"); },
    resumeWorkerTask: async () => { throw new Error("Unused worker API method"); },
    getTaskGraph: vi.fn<ApiClient["getTaskGraph"]>().mockResolvedValue(graph),
    putTaskAttachment: vi.fn<ApiClient["putTaskAttachment"]>(), listTaskAttachments: vi.fn<ApiClient["listTaskAttachments"]>(),
    readTaskAttachment: vi.fn<ApiClient["readTaskAttachment"]>(), removeTaskAttachment: vi.fn<ApiClient["removeTaskAttachment"]>(),
  };
  const context = {
    version: "0.0.0", packageDirectory: "unused", homeDirectory: vi.fn<() => string>(() => { throw new Error("Dispatch must not read home"); }),
    workingDirectory: vi.fn(() => path.resolve("caller")), stdout: vi.fn<(value: string) => void>(), stdoutBytes: vi.fn(async () => {}), stderr: vi.fn<(value: string) => void>(),
  };
  const dependencies = {
    resolveProject: vi.fn<TaskCommandDependencies["resolveProject"]>().mockResolvedValue(project),
    runServerCommand: vi.fn<TaskCommandDependencies["runServerCommand"]>(async (current, command) => {
      const output = await command({ api, operation, serverUrl: "http://localhost:8787" });
      operation.check(); if (output !== undefined) current.stdout(output);
    }),
  };
  return { context, api, dependencies, operation };
};

describe("task parameter boundaries", () => {
  it.each([[], ["--help"], ...["create", "list", "ready", "show", "update", "set-status", "delete", "graph"].map((name) => [name, "--help"])].map((args) => ({ args })))("renders help without business dependencies: $args", async ({ args }) => {
    const f = fixture();
    await runTaskCommand(args, f.context, f.dependencies);
    expect(f.context.stdout).toHaveBeenCalledOnce();
    expect(f.context.stdout.mock.calls[0]![0]).toContain("Usage: daynight task");
    if (args[0] === "create" || args[0] === "update") {
      const output = f.context.stdout.mock.calls[0]![0];
      expect(output).toContain("[--pull-request-url <text>...]");
      expect(output).toContain("[--pull-request-title <text>...]");
      expect(output).toContain("the nth URL pairs with the nth title");
      if (args[0] === "update") expect(output).toContain("--clear-pull-requests");
      else expect(output).not.toContain("--clear-pull-requests");
    }
    if (args[0] === "set-status") {
      expect(f.context.stdout.mock.calls[0]![0]).toContain("[--claim-id <claim-id>]");
      expect(f.context.stdout.mock.calls[0]![0]).toContain("The claim is never inferred from the task or environment.");
    }
    expect(f.dependencies.runServerCommand).not.toHaveBeenCalled();
    expect(f.dependencies.resolveProject).not.toHaveBeenCalled();
    expect(f.context.homeDirectory).not.toHaveBeenCalled(); expect(f.context.workingDirectory).not.toHaveBeenCalled();
  });

  it.each([
    ["create"], ["create", "--title", "\u0085"], ["create", "--title", "\0"], ["create", "--title", "\ud800"],
    ["create", "--title", "Title", "--description", "\ud800"], ["create", "--title", "Title", "--description", "\0"],
    ["create", "--title", "Title", "--external-depends-on", "invalid"], ["update", taskId, "--external-depends-on", "invalid"],
    ["create", "--title", "Title", "--depends-on", "invalid"],
    ["create", "--title", "Title", "--depends-on", dependencyId, "--depends-on", dependencyId.toUpperCase()],
    ["create", "--title", "Title", "--external-depends-on", dependencyId, "--external-depends-on", dependencyId.toUpperCase()],
    ["update", taskId, "--depends-on", dependencyId, "--external-depends-on", dependencyId.toUpperCase()],
    ["update", taskId, "--external-depends-on", dependencyId, "--clear-dependencies"],
    ["list", "--status", "blocked"], ["list", "--status", "proposed"], ["set-status", taskId, "proposed"], ["set-status", taskId], ["set-status", "invalid", "todo"],
    ...["todo", "in_progress"].map((status) => ["set-status", taskId, status, "--claim-id", claimId]),
    ...["", "invalid", ` ${claimId}`, claimId.replaceAll("-", "")].map((value) => ["set-status", taskId, "done", `--claim-id=${value}`]),
    ["set-status", taskId, "done", "--claim-id"],
    ["set-status", taskId, "done", "--claim-id", claimId, `--claim-id=${claimId}`],
    ["show", taskId, "--claim-id", claimId], ["update", taskId, "--claim-id", claimId],
    ...["0", "1.5", "9223372036854775808"].map((version) => ["set-status", taskId, "todo", "--if-version", version]), ["update", taskId, "--status", "proposed"], ["list", "--project", "invalid"], ["show", "invalid"], ["show", taskId, "--project", "invalid"],
    ["delete"], ["delete", "invalid"], ["delete", taskId, "--json"],
    ["delete", taskId, "--remove-depends=true"], ["delete", taskId, "--remove-depends=false"],
    ["delete", taskId, "--remove-depends", "true"], ["delete", taskId, "--remove-depends", "--remove-depends"],
    ["update", taskId, "--remove-depends"],
    ...["0", "1.5", "9223372036854775808"].map((version) => ["delete", taskId, "--if-version", version]),
    ["update", taskId], ["update", taskId, "--if-version", "1"], ["update", taskId, "--status", "done", "--if-version", "0"],
    ["update", taskId, "--title", "\u2003"], ["update", taskId, "--status", "done", "--if-version", "9223372036854775808"],
    ["update", taskId, "--status", "done", "--if-version", "1.5"], ["update", taskId, "--depends-on", dependencyId, "--clear-dependencies"],
    ["create", "--title", "Title", "--pull-request-url", "url"],
    ["create", "--title", "Title", "--pull-request-title="],
    ["create", "--title", "Title", "--clear-pull-requests"],
    ["update", taskId, "--pull-request-url", "one", "--pull-request-url", "two", "--pull-request-title", "title"],
    ["update", taskId, "--pull-request-url=", "--clear-pull-requests"],
    ["update", taskId, "--pull-request-title=", "--clear-pull-requests"],
    ["update", taskId, "--pull-request-url", "-leading", "--pull-request-title", "Title"],
    ["graph", "--ready"], ["create", "--title", "Title", "--json"], ["list", "--ready", "--ready"],
    ...["0", "101", "-1", "+1", "1.5", "1e1", " 1", "1 ", "Infinity", "99999999999999999999999999999", ""].map((value) => ["ready", `--limit=${value}`]),
    ["ready", "--status", "todo"], ["ready", "--cursor", "next"], ["ready", "--limit", "1", "--limit", "2"],
    ...["approve", "unapprove", "claim", "complete"].flatMap((action) => [
      [action], [action, "invalid"], [action, taskId, "--status", "done"], [action, taskId, "--title", "Title"],
      ...["0", "1.5", "9223372036854775808"].map((version) => [action, taskId, "--if-version", version]),
    ]),
  ].map((args) => ({ args })))("rejects invalid parameters before runtime or local preparation: $args", async ({ args }) => {
    const f = fixture();
    await expect(runTaskCommand(args, f.context, f.dependencies)).rejects.toBeInstanceOf(UsageError);
    expect(f.dependencies.runServerCommand).not.toHaveBeenCalled(); expect(f.dependencies.resolveProject).not.toHaveBeenCalled();
    expect(f.context.homeDirectory).not.toHaveBeenCalled(); expect(f.context.workingDirectory).not.toHaveBeenCalled();
    expect(f.context.stdout).not.toHaveBeenCalled();
  });

  it("rejects generic status writes before runtime and directs status changes through action help", async () => {
    const f = fixture();
    await expect(runTaskCommand(["update", taskId, "--status", "todo"], f.context, f.dependencies)).rejects.toMatchObject({ message: expect.stringContaining('option "--status"'), helpCommand: "daynight task update --help" });
    expect(f.dependencies.runServerCommand).not.toHaveBeenCalled();
    await runTaskCommand(["update", "--help"], f.context, f.dependencies);
    expect(f.context.stdout.mock.calls[0]![0]).toContain("Use daynight task set-status to change status.");
  });

  it.each([false, true])("soft-deletes using the observed version and explicit dependency-removal choice %s", async (removeDepends) => {
    const f = fixture();
    await runTaskCommand(["delete", taskId.toUpperCase(), ...(removeDepends ? ["--remove-depends"] : [])], f.context, f.dependencies);
    expect(f.api.getTask).toHaveBeenCalledExactlyOnceWith(projectId, taskId);
    expect(f.api.deleteTask).toHaveBeenCalledExactlyOnceWith(projectId, taskId, { version: task.version, ...(removeDepends ? { removeDepends: true } : {}) });
    expect(f.api.getTaskGraph).not.toHaveBeenCalled();
    expect(f.api.getTask.mock.invocationCallOrder[0]!).toBeLessThan(f.api.deleteTask.mock.invocationCallOrder[0]!);
    expect(f.context.stdout).toHaveBeenCalledExactlyOnceWith(`Task deleted. Stored data and attachments are retained.\nID: ${taskId}\nProject: ${projectId}\n`);
  });

  it("submits dependency-removal consent with the supplied exact version without a task or graph read", async () => {
    const f = fixture();
    await runTaskCommand(["delete", taskId, "--remove-depends", "--if-version", "9223372036854775807", "--project", projectId], f.context, f.dependencies);
    expect(f.api.getTask).not.toHaveBeenCalled();
    expect(f.api.getTaskGraph).not.toHaveBeenCalled();
    expect(f.api.deleteTask).toHaveBeenCalledExactlyOnceWith(projectId, taskId, { version: 9_223_372_036_854_775_807n, removeDepends: true });
  });

  it("preserves a deletion refusal without rereading or retrying an explicit version", async () => {
    const f = fixture();
    const failure = new Error("Dependent tasks prevent deletion");
    f.api.deleteTask.mockRejectedValue(failure);
    await expect(runTaskCommand(["delete", taskId, "--if-version", "9223372036854775807", "--project", projectId], f.context, f.dependencies)).rejects.toBe(failure);
    expect(f.api.getTask).not.toHaveBeenCalled();
    expect(f.api.deleteTask).toHaveBeenCalledExactlyOnceWith(projectId, taskId, { version: 9_223_372_036_854_775_807n });
    expect(f.context.stdout).not.toHaveBeenCalled();
  });

  it.each(["todo", "in_progress", "done"] as const)("uses the observed version to set %s and prints the full confirmed result", async (status) => {
    const f = fixture();
    const result = { ...task, status, description: "Full status result", version: task.version + 1n };
    f.api.setTaskStatus.mockResolvedValue(result);
    await runTaskCommand(["set-status", taskId.toUpperCase(), status], f.context, f.dependencies);
    expect(f.dependencies.resolveProject).toHaveBeenCalledExactlyOnceWith({ serverUrl: "http://localhost:8787", operation: f.operation, api: f.api, workingDirectory: path.resolve("caller") });
    expect(f.api.getTask).toHaveBeenCalledExactlyOnceWith(projectId, taskId);
    expect(f.api.setTaskStatus).toHaveBeenCalledExactlyOnceWith(projectId, taskId, { version: task.version, status });
    expect(f.api.getTask.mock.invocationCallOrder[0]!).toBeLessThan(f.api.setTaskStatus.mock.invocationCallOrder[0]!);
    expect(f.api.updateTask).not.toHaveBeenCalled();
    expect(f.context.stdout.mock.calls[0]![0]).toBe(`Task status set.\n${renderTask(result)}`);
  });

  it.each(["todo", "in_progress", "done"] as const)("submits the explicit full-int64 version for %s without reading or retrying conflicts", async (status) => {
    const f = fixture();
    const failure = new Error("Version conflict");
    f.api.setTaskStatus.mockRejectedValue(failure);
    await expect(runTaskCommand(["set-status", taskId, status, "--if-version", "9223372036854775807", "--project", projectId], f.context, f.dependencies)).rejects.toBe(failure);
    expect(f.api.getTask).not.toHaveBeenCalled();
    expect(f.api.setTaskStatus).toHaveBeenCalledExactlyOnceWith(projectId, taskId, { version: 9_223_372_036_854_775_807n, status });
    expect(f.dependencies.resolveProject).not.toHaveBeenCalled();
    expect(f.context.workingDirectory).not.toHaveBeenCalled();
    expect(f.context.stdout).not.toHaveBeenCalled();
  });

  it("completes an explicit canonical worker claim using one observed version read", async () => {
    const f = fixture();
    const result = { ...task, status: "done", ready: false, description: "Confirmed worker completion", version: task.version + 1n } as const;
    f.api.completeWorkerTask.mockResolvedValue(result);

    await runTaskCommand(["set-status", taskId.toUpperCase(), "done", "--claim-id", claimId.toUpperCase()], f.context, f.dependencies);

    expect(f.api.getTask).toHaveBeenCalledExactlyOnceWith(projectId, taskId);
    expect(f.api.completeWorkerTask).toHaveBeenCalledExactlyOnceWith(projectId, taskId, { version: task.version, claimId });
    expect(f.api.getTask.mock.invocationCallOrder[0]!).toBeLessThan(f.api.completeWorkerTask.mock.invocationCallOrder[0]!);
    expect(f.api.setTaskStatus).not.toHaveBeenCalled();
    expect(f.api.updateTask).not.toHaveBeenCalled();
    expect(f.context.stdout).toHaveBeenCalledExactlyOnceWith(`Task status set.\n${renderTask(result)}`);
  });

  it("submits the exact explicit worker completion version without reading or replaying a refusal", async () => {
    const f = fixture();
    const failure = new Error("Claim is no longer current");
    f.api.completeWorkerTask.mockRejectedValue(failure);

    await expect(runTaskCommand(["set-status", taskId, "done", `--claim-id=${claimId}`, "--if-version", "9223372036854775807", "--project", projectId], f.context, f.dependencies)).rejects.toBe(failure);

    expect(f.api.getTask).not.toHaveBeenCalled();
    expect(f.api.completeWorkerTask).toHaveBeenCalledExactlyOnceWith(projectId, taskId, { version: 9_223_372_036_854_775_807n, claimId });
    expect(f.api.setTaskStatus).not.toHaveBeenCalled();
    expect(f.dependencies.resolveProject).not.toHaveBeenCalled();
    expect(f.context.stdout).not.toHaveBeenCalled();
  });

  it("does not infer worker completion when the observed task contains a claim", async () => {
    const f = fixture();
    f.api.getTask.mockResolvedValue({
      ...task, status: "in_progress", ready: false, startedAt: time,
      properties: { ...task.properties, worker: { claimId, state: "active", userId: projectId, workerId: dependencyId, machine: { id: otherDependencyId, name: "Build machine" }, platform: "linux", agent: "codex", worktreeId: taskId, phase: "executing", herdr: null, nativeSessionId: null, claimedAt: time } },
    });

    await runTaskCommand(["set-status", taskId, "done", "--project", projectId], f.context, f.dependencies);

    expect(f.api.setTaskStatus).toHaveBeenCalledExactlyOnceWith(projectId, taskId, { version: task.version, status: "done" });
    expect(f.api.completeWorkerTask).not.toHaveBeenCalled();
  });

  it("stops worker completion before dispatch when cancelled after its version read", async () => {
    const cancellation = new AbortController();
    const f = fixture(createOperation({ signal: cancellation.signal }));
    f.api.getTask.mockImplementation(async () => { cancellation.abort(); return task; });

    await expect(runTaskCommand(["set-status", taskId, "done", "--claim-id", claimId, "--project", projectId], f.context, f.dependencies)).rejects.toThrow("Operation cancelled");

    expect(f.api.completeWorkerTask).not.toHaveBeenCalled();
    expect(f.context.stdout).not.toHaveBeenCalled();
  });

  it("stops a status change before dispatch when cancelled after reading the version", async () => {
    const cancellation = new AbortController();
    const f = fixture(createOperation({ signal: cancellation.signal }));
    f.api.getTask.mockImplementation(async () => { cancellation.abort(); return task; });
    await expect(runTaskCommand(["set-status", taskId, "done", "--project", projectId], f.context, f.dependencies)).rejects.toThrow("Operation cancelled");
    expect(f.api.setTaskStatus).not.toHaveBeenCalled();
    expect(f.context.stdout).not.toHaveBeenCalled();
  });

  it.each(["create", "list", "ready", "show", "update", "graph"])("uses explicit project for %s without consulting cwd or repository resolution", async (command) => {
    const f = fixture();
    f.context.workingDirectory.mockImplementation(() => { throw new Error("Explicit project must not read cwd"); });
    const base = command === "create" ? [command, "--title", "Title"] : command === "show" ? [command, taskId.toUpperCase()] : command === "update" ? [command, taskId.toUpperCase(), "--description="] : [command];
    await runTaskCommand([...base, "--project", projectId.toUpperCase()], f.context, f.dependencies);
    expect(f.api.getProject).toHaveBeenCalledExactlyOnceWith(projectId);
    expect(f.dependencies.resolveProject).not.toHaveBeenCalled(); expect(f.context.workingDirectory).not.toHaveBeenCalled();
  });

  it.each(["list", "ready"])("uses the current repository resolver with the same API client and command operation for %s", async (command) => {
    const f = fixture();
    await runTaskCommand([command], f.context, f.dependencies);
    expect(f.dependencies.resolveProject).toHaveBeenCalledExactlyOnceWith({ serverUrl: "http://localhost:8787", operation: f.operation, api: f.api, workingDirectory: path.resolve("caller") });
    expect(f.api.getProject).not.toHaveBeenCalled();
  });
});

describe("task request contracts", () => {
  it.each([true, false])("updates only automatic execution to %s using the explicit exact version", async (allowAgents) => {
    const f = fixture();
    await runTaskCommand(["update", taskId, "--allow-agents", String(allowAgents), "--if-version", "9223372036854775807", "--project", projectId], f.context, f.dependencies);
    expect(f.api.getTask).not.toHaveBeenCalled();
    expect(f.api.updateTask).toHaveBeenCalledExactlyOnceWith(projectId, taskId, { allowAgents, version: 9_223_372_036_854_775_807n });
  });

  it.each(["windows", "linux", "macos"] as const)("creates and updates an explicit %s platform requirement", async (requiredPlatform) => {
    const f = fixture();
    await runTaskCommand(["create", "--title", "Platform task", "--required-platform", requiredPlatform, "--project", projectId], f.context, f.dependencies);
    expect(f.api.createTask).toHaveBeenCalledExactlyOnceWith(projectId, { title: "Platform task", requiredPlatform });
    await runTaskCommand(["update", taskId, `--required-platform=${requiredPlatform}`, "--if-version", "9223372036854775807", "--project", projectId], f.context, f.dependencies);
    expect(f.api.getTask).not.toHaveBeenCalled();
    expect(f.api.updateTask).toHaveBeenCalledExactlyOnceWith(projectId, taskId, { requiredPlatform, version: 9_223_372_036_854_775_807n });
  });

  it("clears the platform explicitly without touching permission or other task fields", async () => {
    const f = fixture();
    await runTaskCommand(["update", taskId, "--clear-required-platform", "--project", projectId], f.context, f.dependencies);
    expect(f.api.updateTask).toHaveBeenCalledExactlyOnceWith(projectId, taskId, { requiredPlatform: null, version: task.version });
    expect(f.api.getTask).toHaveBeenCalledExactlyOnceWith(projectId, taskId);
  });

  it.each(["windows", "linux", "macos"] as const)("forwards %s compatibility with permission and readiness before pagination", async (compatiblePlatform) => {
    const f = fixture();
    await runTaskCommand(["list", "--compatible-platform", compatiblePlatform, "--allow-agents", "true", "--ready", "--project", projectId], f.context, f.dependencies);
    await runTaskCommand(["ready", `--compatible-platform=${compatiblePlatform}`, "--allow-agents", "false", "--limit", "1", "--project", projectId], f.context, f.dependencies);
    expect(f.api.listTasks).toHaveBeenCalledExactlyOnceWith(projectId, { ready: true, allowAgents: true, compatiblePlatform });
    expect(f.api.listReadyTasks).toHaveBeenCalledExactlyOnceWith(projectId, 1, { allowAgents: false, compatiblePlatform });
  });

  it("passes a standalone compatibility filter without implying automatic permission", async () => {
    const f = fixture();
    await runTaskCommand(["ready", "--compatible-platform", "linux", "--project", projectId], f.context, f.dependencies);
    expect(f.api.listReadyTasks).toHaveBeenCalledExactlyOnceWith(projectId, 10, { compatiblePlatform: "linux" });
  });

  it.each([
    ["create", "--title", "Task", "--required-platform", "darwin"],
    ["create", "--title", "Task", "--clear-required-platform"],
    ["update", taskId, "--required-platform", "linux", "--clear-required-platform"],
    ["update", taskId, "--required-platform="],
    ["list", "--compatible-platform", "Linux"],
    ["ready", "--compatible-platform", "any"],
  ])("rejects invalid or conflicting platform options before loading server configuration: %s", async (...args) => {
    const f = fixture();
    await expect(runTaskCommand(args, f.context, f.dependencies)).rejects.toBeInstanceOf(UsageError);
    expect(f.dependencies.runServerCommand).not.toHaveBeenCalled();
  });

  it.each([null, "windows", "linux", "macos"] as const)("renders platform %s in complete, inventory and graph output", async (requiredPlatform) => {
    const f = fixture();
    const value = { ...task, requiredPlatform };
    f.api.getTask.mockResolvedValue(value);
    f.api.listTasks.mockResolvedValue([value]);
    f.api.getTaskGraph.mockResolvedValue({ ...graph, tasks: graph.tasks.map((item) => ({ ...item, requiredPlatform })) });
    for (const args of [["show", taskId], ["list"], ["graph"]]) await runTaskCommand([...args, "--project", projectId], f.context, f.dependencies);
    for (const [output] of f.context.stdout.mock.calls) expect(output).toContain(`Required platform: ${requiredPlatform === null ? "any" : requiredPlatform}\n`);
  });

  it.each([true, false])("forwards automatic-execution filter %s before list and ready pagination", async (allowAgents) => {
    const f = fixture();
    await runTaskCommand(["list", "--allow-agents", String(allowAgents), "--ready", "--project", projectId], f.context, f.dependencies);
    await runTaskCommand(["ready", "--allow-agents", String(allowAgents), "--limit", "1", "--project", projectId], f.context, f.dependencies);
    expect(f.api.listTasks).toHaveBeenCalledExactlyOnceWith(projectId, { ready: true, allowAgents });
    expect(f.api.listReadyTasks).toHaveBeenCalledExactlyOnceWith(projectId, 1, { allowAgents });
  });

  it.each(["yes", "TRUE", "0", "", "null"])("rejects invalid permission %s before loading runtime", async (value) => {
    const f = fixture();
    await expect(runTaskCommand(["update", taskId, `--allow-agents=${value}`, "--project", projectId], f.context, f.dependencies)).rejects.toThrow();
    expect(f.dependencies.runServerCommand).not.toHaveBeenCalled();
    expect(f.api.updateTask).not.toHaveBeenCalled();
  });

  it("does not provide automatic-execution permission during creation", async () => {
    const f = fixture();
    await expect(runTaskCommand(["create", "--title", "Title", "--allow-agents", "true", "--project", projectId], f.context, f.dependencies)).rejects.toThrow('Unknown daynight task create option "--allow-agents".');
    expect(f.dependencies.runServerCommand).not.toHaveBeenCalled();
  });

  it("omits optional creation fields and preserves a FEFF-only title", async () => {
    const f = fixture();
    await runTaskCommand(["create", "--title", "\ufeff", "--project", projectId], f.context, f.dependencies);
    expect(f.api.createTask).toHaveBeenCalledExactlyOnceWith(projectId, { title: "\ufeff" });
  });

  it("normalizes mixed dependency declarations while preserving empty descriptions", async () => {
    const f = fixture();
    await runTaskCommand(["create", "--title=-Title=original", "--description=", "--depends-on", otherDependencyId.toUpperCase(), "--external-depends-on", dependencyId, "--project", projectId], f.context, f.dependencies);
    expect(f.api.createTask).toHaveBeenCalledExactlyOnceWith(projectId, { title: "-Title=original", description: "", dependsOn: [dependencyId, otherDependencyId], externalDependsOn: [dependencyId] });
  });

  it.each([
    { name: "ordinary-only", fields: ["--depends-on", dependencyId.toUpperCase()], externalDependsOn: [] },
    { name: "external-only", fields: ["--external-depends-on", dependencyId.toUpperCase()], externalDependsOn: [dependencyId] },
  ])("replaces both dependency sets for $name creation and updates", async ({ fields, externalDependsOn }) => {
    const f = fixture();
    await runTaskCommand(["create", "--title", "Title", ...fields, "--project", projectId], f.context, f.dependencies);
    expect(f.api.createTask).toHaveBeenCalledExactlyOnceWith(projectId, { title: "Title", dependsOn: [dependencyId], externalDependsOn });
    await runTaskCommand(["update", taskId, ...fields, "--if-version", "9223372036854775807", "--project", projectId], f.context, f.dependencies);
    expect(f.api.updateTask).toHaveBeenCalledExactlyOnceWith(projectId, taskId, { version: 9_223_372_036_854_775_807n, dependsOn: [dependencyId], externalDependsOn });
    expect(f.api.getTask).not.toHaveBeenCalled();
  });

  it("combines status and ready filters without inventing absent fields", async () => {
    const f = fixture();
    await runTaskCommand(["list", "--status", "todo", "--ready", "--project", projectId], f.context, f.dependencies);
    expect(f.api.listTasks).toHaveBeenCalledExactlyOnceWith(projectId, { status: "todo", ready: true });
    const unfiltered = fixture();
    await runTaskCommand(["list", "--project", projectId], unfiltered.context, unfiltered.dependencies);
    expect(unfiltered.api.listTasks).toHaveBeenCalledExactlyOnceWith(projectId, {});
  });

  it.each(["create", "update"])("pairs %s PR references by occurrence while preserving all string values", async (command) => {
    const f = fixture();
    const base = command === "create" ? [command, "--title", "Title"] : [command, taskId];
    const pullRequests = [{ url: "", title: "\0\n\u001b[2J" }, { url: "-url=a,b", title: "  标题  " }, { url: "-url=a,b", title: "  标题  " }];
    await runTaskCommand([...base, "--pull-request-title", pullRequests[0]!.title, "--pull-request-url=", "--pull-request-url=-url=a,b", "--pull-request-url=-url=a,b", "--pull-request-title", "  标题  ", "--pull-request-title", "  标题  ", "--project", projectId], f.context, f.dependencies);
    if (command === "create") expect(f.api.createTask).toHaveBeenCalledExactlyOnceWith(projectId, { title: "Title", properties: { pullRequests } });
    else expect(f.api.updateTask).toHaveBeenCalledExactlyOnceWith(projectId, taskId, { properties: { pullRequests }, version: task.version });
  });

  it("clears PR references as the sole update using an explicit version", async () => {
    const f = fixture();
    await runTaskCommand(["update", taskId, "--clear-pull-requests", "--if-version", "9223372036854775807", "--project", projectId], f.context, f.dependencies);
    expect(f.api.getTask).not.toHaveBeenCalled();
    expect(f.api.updateTask).toHaveBeenCalledExactlyOnceWith(projectId, taskId, { properties: { pullRequests: [] }, version: 9_223_372_036_854_775_807n });
  });

  it.each([{ args: [], limit: 10 }, { args: ["--limit", "1"], limit: 1 }, { args: ["--limit=100"], limit: 100 }, { args: ["--limit=002"], limit: 2 }])("requests a bounded ready page with limit $limit", async ({ args, limit }) => {
    const f = fixture();
    await runTaskCommand(["ready", ...args, "--project", projectId], f.context, f.dependencies);
    expect(f.api.listReadyTasks).toHaveBeenCalledExactlyOnceWith(projectId, limit, {});
    expect(f.api.listTasks).not.toHaveBeenCalled();
    expect(f.context.stdout).toHaveBeenCalledExactlyOnceWith(renderTaskList([task]));
  });

  it("does not print ready results after operation cancellation", async () => {
    const cancellation = new AbortController();
    const f = fixture(createOperation({ signal: cancellation.signal }));
    f.api.listReadyTasks.mockImplementation(async () => { cancellation.abort(); return [task]; });
    await expect(runTaskCommand(["ready", "--project", projectId], f.context, f.dependencies)).rejects.toThrow("Operation cancelled");
    expect(f.context.stdout).not.toHaveBeenCalled();
  });

  it("reads the task's exact current version before PATCH while preserving omitted fields", async () => {
    const f = fixture();
    await runTaskCommand(["update", taskId, "--description", "", "--project", projectId], f.context, f.dependencies);
    expect(f.api.getTask).toHaveBeenCalledExactlyOnceWith(projectId, taskId);
    expect(f.api.updateTask).toHaveBeenCalledExactlyOnceWith(projectId, taskId, { description: "", version: task.version });
    expect(f.api.getTask.mock.invocationCallOrder[0]!).toBeLessThan(f.api.updateTask.mock.invocationCallOrder[0]!);
  });

  it("submits an explicit full-int64 version directly without reading the task", async () => {
    const f = fixture();
    await runTaskCommand(["update", taskId, "--description=", "--if-version", "9223372036854775807", "--project", projectId], f.context, f.dependencies);
    expect(f.api.getTask).not.toHaveBeenCalled();
    expect(f.api.updateTask).toHaveBeenCalledExactlyOnceWith(projectId, taskId, { description: "", version: 9_223_372_036_854_775_807n });
  });

  it.each([false, true])("replaces dependencies using a complete set, clear=%s", async (clear) => {
    const f = fixture();
    const fields = clear ? ["--clear-dependencies"] : ["--depends-on", dependencyId];
    await runTaskCommand(["update", taskId, ...fields, "--project", projectId], f.context, f.dependencies);
    expect(f.api.updateTask).toHaveBeenCalledExactlyOnceWith(projectId, taskId, { dependsOn: clear ? [] : [dependencyId], externalDependsOn: [], version: task.version });
  });

  it("finishes repository preparation before task mutation and propagates local failures", async () => {
    const f = fixture();
    const failure = new Error("Ignore file replacement denied");
    f.dependencies.resolveProject.mockRejectedValue(failure);
    await expect(runTaskCommand(["create", "--title", "Title"], f.context, f.dependencies)).rejects.toBe(failure);
    expect(f.api.createTask).not.toHaveBeenCalled(); expect(f.context.stdout).not.toHaveBeenCalled();
  });

  it("does not retry a version conflict or read a newer version", async () => {
    const f = fixture();
    const failure = new ApiError({ operation: "task.update", projectId, taskId }, "response", { cause: new Error("Conflict"), status: 409, serverError: { code: "version_conflict", message: "Conflict", requestId: "conflict-request", details: { taskIds: [taskId] } }, confirmedRefusal: true });
    f.api.updateTask.mockRejectedValue(failure);
    await expect(runTaskCommand(["update", taskId, "--pull-request-url=", "--pull-request-title=", "--project", projectId], f.context, f.dependencies)).rejects.toBe(failure);
    expect(f.api.getTask).toHaveBeenCalledOnce(); expect(f.api.updateTask).toHaveBeenCalledOnce();
    expect(f.context.stdout).not.toHaveBeenCalled();
  });

  it("stops before PATCH when cancelled after the version read", async () => {
    const cancellation = new AbortController();
    const f = fixture(createOperation({ signal: cancellation.signal }));
    f.api.getTask.mockImplementation(async () => { cancellation.abort(); return task; });
    await expect(runTaskCommand(["update", taskId, "--description=", "--project", projectId], f.context, f.dependencies)).rejects.toThrow("Operation cancelled");
    expect(f.api.updateTask).not.toHaveBeenCalled(); expect(f.context.stdout).not.toHaveBeenCalled();
  });

  it("stops before mutation when cancelled during automatic repository preparation", async () => {
    const cancellation = new AbortController();
    const f = fixture(createOperation({ signal: cancellation.signal }));
    f.dependencies.resolveProject.mockImplementation(async () => { cancellation.abort(); return project; });
    await expect(runTaskCommand(["create", "--title", "Title"], f.context, f.dependencies)).rejects.toThrow("Operation cancelled");
    expect(f.api.createTask).not.toHaveBeenCalled();
  });
});

describe("task output contracts", () => {
  it.each(["create", "show", "update"])("renders every task field in %s human output", async (command) => {
    const f = fixture();
    const current = { ...task, properties: { worker: null, pullRequests: [{ title: "First", url: "arbitrary text" }, { title: "First", url: "arbitrary text" }, { title: "", url: "" }] }, dependsOn: [dependencyId], externalDependsOn: [dependencyId], blockedBy: [dependencyId], ready: false };
    f.api.createTask.mockResolvedValue(current); f.api.getTask.mockResolvedValue(current); f.api.updateTask.mockResolvedValue(current);
    const base = command === "create" ? [command, "--title", "Title"] : command === "update" ? [command, taskId, "--description="] : [command, taskId];
    await runTaskCommand([...base, "--project", projectId], f.context, f.dependencies);
    const output = f.context.stdout.mock.calls[0]![0];
    for (const field of [`ID: ${taskId}`, `Project: ${projectId}`, `Title: ${task.title}`, `Description: ${task.description}`, `Status: ${task.status}`, "Automatic execution: false", `Version: ${task.version}`, "Ready: false", `Depends on: ${dependencyId}`, `External dependencies (1): ${dependencyId}`, `Blocked by: ${dependencyId}`, `Created: ${time}`, `Updated: ${time}`]) expect(output).toContain(field);
    expect(output).toContain("Pull requests: 3\n  1. Title: First\n     URL: arbitrary text\n  2. Title: First\n     URL: arbitrary text\n  3. Title: \n     URL: \n");
  });

  it.each(["list", "ready", "show", "graph"])("preserves %s JSON fields with numeric full-int64 versions", async (command) => {
    const f = fixture();
    const base = command === "show" ? [command, taskId] : [command];
    await runTaskCommand([...base, "--json", "--project", projectId], f.context, f.dependencies);
    const output = f.context.stdout.mock.calls[0]![0];
    expect(output.endsWith("\n")).toBe(true);
    const parsed = parseApiJson(output);
    const { description: _description, ...listItem } = task;
    expect(parsed).toEqual(command === "list" ? [listItem] : command === "ready" ? [task] : command === "graph" ? graph : task);
    if (command === "list") expect(parsed).not.toHaveProperty("0.description");
    if (command === "ready") expect(parsed).toHaveProperty("0.description", task.description);
    if (command !== "graph") expect(output).toContain('"version":9007199254740993');
  });

  it("renders every graph node, dependency and summary with explicit title truncation", async () => {
    const f = fixture();
    await runTaskCommand(["graph", "--project", projectId], f.context, f.dependencies);
    const output = f.context.stdout.mock.calls[0]![0];
    for (const field of [`Project: ${projectId}`, "Name: Project", `Repository: ${project.repoUrl}`, "Summary:", "Total: 1", "Todo: 1", "In progress: 0", "Done: 0", "Ready: 1", "Blocked: 0", `ID: ${taskId}`, "Title preview: Task title", "Title truncated: true", "Depends on: none", "External dependencies (0): none", "Blocked by: none"]) expect(output).toContain(field);
  });

  it("keeps terminal control characters visible and preserves raw JSON strings", async () => {
    const f = fixture();
    const raw = { ...task, title: "First\nSecond\u001b[2J", description: "Tab\tReturn\r\u0085", properties: { worker: null, pullRequests: [{ title: "\0\n\u001b[2J", url: "Tab\tReturn\r\u0085" }, { title: "", url: "" }] } };
    f.api.getTask.mockResolvedValue(raw);
    await runTaskCommand(["show", taskId, "--project", projectId], f.context, f.dependencies);
    expect(f.context.stdout.mock.calls[0]![0]).toContain("First\\nSecond\\u001b[2J");
    expect(f.context.stdout.mock.calls[0]![0]).toContain("Tab\\tReturn\\r\\u0085");
    expect(f.context.stdout.mock.calls[0]![0]).toContain("1. Title: \\u0000\\n\\u001b[2J");
    await runTaskCommand(["show", taskId, "--project", projectId, "--json"], f.context, f.dependencies);
    expect(parseApiJson(f.context.stdout.mock.calls[1]![0])).toEqual(raw);
  });

  it("renders an empty task list and empty graph explicitly", async () => {
    const f = fixture(); f.api.listTasks.mockResolvedValue([]);
    f.api.getTaskGraph.mockResolvedValue({ observedAt: time, project, tasks: [], summary: { total: 0, todo: 0, inProgress: 0, done: 0, ready: 0, blocked: 0 } });
    await runTaskCommand(["list", "--project", projectId], f.context, f.dependencies);
    expect(f.context.stdout).toHaveBeenLastCalledWith("No tasks.\n");
    await runTaskCommand(["graph", "--project", projectId], f.context, f.dependencies);
    expect(f.context.stdout.mock.calls[1]![0]).toContain("Total: 0"); expect(f.context.stdout.mock.calls[1]![0]).toMatch(/No tasks\.\n$/);
  });

  it("renders an empty ready selection in human and JSON output", async () => {
    const f = fixture(); f.api.listReadyTasks.mockResolvedValue([]);
    await runTaskCommand(["ready", "--project", projectId], f.context, f.dependencies);
    expect(f.context.stdout).toHaveBeenLastCalledWith("No ready tasks.\n");
    await runTaskCommand(["ready", "--json", "--project", projectId], f.context, f.dependencies);
    expect(f.context.stdout).toHaveBeenLastCalledWith("[]\n");
  });

  it("renders full values in linear space despite an outlier title or description", () => {
    const tasks = Array.from({ length: 1_000 }, (_, index) => ({ ...task, id: `${index.toString(16).padStart(8, "0")}-2222-4222-8333-123456789abc`, title: index === 0 ? "T".repeat(4_096) : `Task ${index}` }));
    const output = renderTaskList(tasks);
    let contentLength = 0;
    for (const current of tasks) {
      expect(output).toContain(`ID: ${current.id}\nProject: ${projectId}\nTitle: ${current.title}\n`);
      contentLength += current.id.length + current.projectId.length + current.title.length + current.description.length + current.status.length + current.version.toString().length + current.createdAt.length + current.updatedAt.length + `Automatic execution: ${current.allowAgents}\nRequired platform: ${current.requiredPlatform === null ? "any" : current.requiredPlatform}\n`.length;
    }
    expect(output.length).toBeLessThanOrEqual(contentLength + 190 * tasks.length);
  });
});
