import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, createApiClient, createOperation, parseApiJson } from "../../../src/api/index.js";
import type { ApiClient, Operation, Project, Task, TaskGraph } from "../../../src/api/index.js";
import { UsageError } from "../../../src/cli/context.js";
import { runTaskCommand } from "../../../src/commands/task/command.js";
import type { TaskCommandDependencies } from "../../../src/commands/task/command.js";
import { renderTask, renderTaskList } from "../../../src/commands/task/rendering.js";
import { notApplicableObservation as session } from "../../fixtures/task-observation.js";
import type { ObservedTaskGraph } from "../../../src/api/task-observation.js";

const projectId = "abcdefab-1111-4222-8333-123456789abc";
const taskId = "abcdefab-2222-4222-8333-123456789abc";
const dependencyId = "abcdefab-3333-4222-8333-123456789abc";
const otherDependencyId = "abcdefab-4444-4222-8333-123456789abc";
const claimId = "abcdefab-5555-4222-8333-123456789abc";
const accountId = "abcdefab-6666-4222-8333-123456789abc";
const currentUser = { id: accountId, email: null, emailVerified: null, name: null, avatarUrl: null, personalTeam: { id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", kind: "personal" as const, name: null } };
const time = "2026-10-20T00:00:00.123456789Z";
const project: Project = { id: projectId, name: "Project", repoUrl: "git@git.example:Org/Repo.git", settings: { version: 1n, executionWarningMinutes: 60 }, ownership: { teamId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", version: 1n }, createdAt: time, updatedAt: time };
const task: Task = { type: "task", parentId: null, id: taskId, projectId, title: "Task title", description: "Description", tags: [], properties: { pullRequests: [] }, status: "todo", allowAgents: false, assignedTo: null, requiredPlatform: null, version: 9_007_199_254_740_993n, ready: true, dependsOn: [], externalDependsOn: [], blockedBy: [], startedAt: null, completedAt: null, cancelledAt: null, createdAt: time, updatedAt: time };
const graph: TaskGraph = { observedAt: time, project, summary: { total: 1, proposed: 0, todo: 1, inProgress: 0, done: 0, cancelled: 0, ready: 1, blocked: 0 }, tasks: [{ type: "task", parentId: null, id: taskId, titlePreview: `Task title${"T".repeat(150)}`, titleTruncated: true, allowAgents: false, assignedTo: null, requiredPlatform: null, status: "todo", ready: true, dependsOn: [], externalDependsOn: [], blockedBy: [], startedAt: null, completedAt: null, cancelledAt: null, createdAt: time, updatedAt: time }] };
const propertyResource = { projectId, taskId, version: task.version, properties: task.properties };
const observe = (task: Task) => ({ ...task, session });
const observeGraph = (value: TaskGraph): ObservedTaskGraph => ({ ...value, tasks: value.tasks.map(task => ({ ...task, session, relation: "member" })), sessionSummary: { indicator: null, workingCount: 0, noticeCount: 0, warningCount: 0, unknownCount: 0, complete: true, observedAt: time }, partial: false });
const propertySchema = { properties: { future: { description: "Future definition", readOnly: false, schema: { type: "string", custom: { version: 7 } } } } };
const operations: Operation[] = [];
afterEach(() => { operations.splice(0).forEach((operation) => operation.dispose()); });
const fixture = (operation = createOperation()) => {
  operations.push(operation);
  const api = {
    withExpectedUserId: () => { throw new Error("Unexpected actor binding"); },
    readTaskSessionOperation: async () => { throw new Error("Unexpected operation read"); },
    sendTaskSessionCommand: async () => { throw new Error("Unexpected Session send"); },
    inspectTaskSession: vi.fn<ApiClient["inspectTaskSession"]>(), listTaskWork: vi.fn<ApiClient["listTaskWork"]>(),
    currentTaskSession: vi.fn<ApiClient["currentTaskSession"]>(async () => { throw new Error("Unexpected Session read."); }),
    listTaskSessions: vi.fn<ApiClient["listTaskSessions"]>(async () => { throw new Error("Unexpected Session read."); }),
    readTaskSession: vi.fn<ApiClient["readTaskSession"]>(async () => { throw new Error("Unexpected Session read."); }),
    readTaskSessionEntry: vi.fn<ApiClient["readTaskSessionEntry"]>(async () => { throw new Error("Unexpected Session read."); }),
    getObservedTask: vi.fn<ApiClient["getObservedTask"]>().mockResolvedValue(observe(task)),
    listObservedTasks: vi.fn<ApiClient["listObservedTasks"]>().mockResolvedValue({ items: [observe(task)], partial: false, unsupported: false }),
    getObservedTaskGraph: vi.fn<ApiClient["getObservedTaskGraph"]>().mockResolvedValue(observeGraph(graph)),
    previewProjectTransfer: vi.fn(), transferProject: vi.fn(), previewProjectDeletion: vi.fn(), deleteProject: vi.fn(),
    updateTaskStep: async () => { throw new Error("Unused Step API method"); },
    setTaskStepStatus: async () => { throw new Error("Unused Step API method"); },
    moveTaskStep: vi.fn<ApiClient["moveTaskStep"]>(),
    addTaskStep: vi.fn<ApiClient["addTaskStep"]>(),
    deleteTaskStep: vi.fn<ApiClient["deleteTaskStep"]>(),
    listTaskSteps: vi.fn<ApiClient["listTaskSteps"]>(), getTaskStep: vi.fn<ApiClient["getTaskStep"]>(),
    readTaskThread: vi.fn<ApiClient["readTaskThread"]>(), postTaskThreadMessage: vi.fn<ApiClient["postTaskThreadMessage"]>(),
    getCurrentUser: vi.fn<ApiClient["getCurrentUser"]>().mockResolvedValue(currentUser),
    inspectInvitation: vi.fn<ApiClient["inspectInvitation"]>(), acceptInvitation: vi.fn<ApiClient["acceptInvitation"]>(),
    getTeamCurrentUser: vi.fn<ApiClient["getTeamCurrentUser"]>(), listTeams: vi.fn<ApiClient["listTeams"]>(), getTeam: vi.fn<ApiClient["getTeam"]>(), createTeam: vi.fn<ApiClient["createTeam"]>(), renameTeam: vi.fn<ApiClient["renameTeam"]>(), deleteTeam: vi.fn<ApiClient["deleteTeam"]>(), listTeamProjects: vi.fn<ApiClient["listTeamProjects"]>(),
    listTeamInvitations: vi.fn<ApiClient["listTeamInvitations"]>(), createTeamInvitation: vi.fn<ApiClient["createTeamInvitation"]>(), revokeTeamInvitation: vi.fn<ApiClient["revokeTeamInvitation"]>(),
    listTeamMembers: vi.fn<ApiClient["listTeamMembers"]>(), setTeamMemberRole: vi.fn<ApiClient["setTeamMemberRole"]>(), removeTeamMember: vi.fn<ApiClient["removeTeamMember"]>(),
    getProjectAccess: vi.fn<ApiClient["getProjectAccess"]>(),
    listTags: vi.fn<ApiClient["listTags"]>(), getTag: vi.fn<ApiClient["getTag"]>(), createTag: vi.fn<ApiClient["createTag"]>(), renameTag: vi.fn<ApiClient["renameTag"]>(), deleteTag: vi.fn<ApiClient["deleteTag"]>(),
    listBots: vi.fn<ApiClient["listBots"]>(), getBot: vi.fn<ApiClient["getBot"]>(), createBot: vi.fn<ApiClient["createBot"]>(), deleteBot: vi.fn<ApiClient["deleteBot"]>(), listWorkers: vi.fn<ApiClient["listWorkers"]>(), getWorker: vi.fn<ApiClient["getWorker"]>(),
    reportWorker: vi.fn<ApiClient["reportWorker"]>(), readWorkerMonitoring: vi.fn<ApiClient["readWorkerMonitoring"]>(), writeWorkerMonitoring: vi.fn<ApiClient["writeWorkerMonitoring"]>(), getWorkerConfiguration: vi.fn<ApiClient["getWorkerConfiguration"]>(), reportWorkerConfiguration: vi.fn<ApiClient["reportWorkerConfiguration"]>(),
    listProjectMembers: vi.fn<ApiClient["listProjectMembers"]>(),
    getTaskPropertySchema: vi.fn<ApiClient["getTaskPropertySchema"]>().mockResolvedValue(propertySchema),
    getTaskProperties: vi.fn<ApiClient["getTaskProperties"]>().mockResolvedValue(propertyResource),
    setTaskProperty: vi.fn<ApiClient["setTaskProperty"]>().mockResolvedValue(propertyResource),
    removeTaskProperty: vi.fn<ApiClient["removeTaskProperty"]>().mockResolvedValue({ ...propertyResource, properties: {} }),
    createProject: vi.fn<ApiClient["createProject"]>(), listProjects: vi.fn<ApiClient["listProjects"]>(),
    getProject: vi.fn<ApiClient["getProject"]>().mockResolvedValue(project),
    createTask: vi.fn<ApiClient["createTask"]>().mockResolvedValue(task), getTask: vi.fn<ApiClient["getTask"]>().mockResolvedValue(task),
    listTasks: vi.fn<ApiClient["listTasks"]>().mockResolvedValue([task]), searchTasks: vi.fn<ApiClient["searchTasks"]>().mockResolvedValue([]), listReadyTasks: vi.fn<ApiClient["listReadyTasks"]>().mockResolvedValue([task]), updateTask: vi.fn<ApiClient["updateTask"]>().mockResolvedValue(task),
    deleteTask: vi.fn<ApiClient["deleteTask"]>().mockResolvedValue(),
    setTaskStatus: vi.fn<ApiClient["setTaskStatus"]>().mockResolvedValue(task),
    listTaskPage: async () => { throw new Error("Unused worker API method"); },
    claimWorkerTask: async () => { throw new Error("Unused worker API method"); },
    updateWorkerClaim: async () => { throw new Error("Unused worker API method"); },
    completeWorkerTask: vi.fn<ApiClient["completeWorkerTask"]>().mockResolvedValue(task),
    releaseWorkerClaim: async () => { throw new Error("Unused worker API method"); },
    withdrawWorkerClaim: async () => { throw new Error("Unused worker API method"); },
    getTaskGraph: vi.fn<ApiClient["getTaskGraph"]>().mockResolvedValue(graph),
    putTaskAttachment: vi.fn<ApiClient["putTaskAttachment"]>(), listTaskAttachments: vi.fn<ApiClient["listTaskAttachments"]>(),
    readTaskAttachment: vi.fn<ApiClient["readTaskAttachment"]>(), removeTaskAttachment: vi.fn<ApiClient["removeTaskAttachment"]>(), webhookRequest: async <T>(): Promise<T> => { throw new Error("Unavailable in this test."); },
  };
  const context = {
    version: "0.0.0", packageDirectory: "unused", homeDirectory: vi.fn<() => string>(() => { throw new Error("Dispatch must not read home"); }),
    workingDirectory: vi.fn(() => path.resolve("caller")), stdout: vi.fn<(value: string) => void>(), stdoutBytes: vi.fn(async () => {}), stderr: vi.fn<(value: string) => void>(),
  };
  const dependencies = {
    resolveProject: vi.fn<TaskCommandDependencies["resolveProject"]>().mockResolvedValue(project),
    runServerCommand: vi.fn<TaskCommandDependencies["runServerCommand"]>(async (current, command) => {
      const output = await command({ api, operation, serverUrl: "http://localhost:8787", serverConfiguration: { serverUrl: "http://localhost:8787" } });
      operation.check(); if (typeof output === "string") current.stdout(output); else if (output !== undefined) current.stdout(output.output);
    }),
  };
  return { context, api, dependencies, operation };
};

describe("task parameter boundaries", () => {
  it.each([[], ["--help"], ...["create", "list", "search", "ready", "show", "update", "set-status", "delete", "graph", "properties", "set-property", "remove-property"].map((name) => [name, "--help"])].map((args) => ({ args })))("renders help without business dependencies: $args", async ({ args }) => {
    const f = fixture();
    await runTaskCommand(args, f.context, f.dependencies);
    expect(f.context.stdout).toHaveBeenCalledOnce();
    expect(f.context.stdout.mock.calls[0]![0]).toContain("Usage: daynight task");
    if (args[0] === "create" || args[0] === "update") {
      const output = f.context.stdout.mock.calls[0]![0];
      for (const option of ["--pull-request-url", "--pull-request-title", "--clear-pull-requests"]) expect(output).not.toContain(option);
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
    ["properties"], ["properties", taskId, "--schema"], ["properties", "--schema", "--project", projectId],
    ["properties", "invalid"], ["properties", taskId, "--project", "invalid"],
    ["set-property"], ["set-property", taskId, "future"], ["set-property", taskId, "", "value"],
    ["set-property", "invalid", "future", "value"], ["remove-property", "invalid", "future"],
    ["remove-property", taskId, ""], ["remove-property", taskId],
    ...["0", "1.5", "9223372036854775808"].flatMap((version) => [
      ["set-property", taskId, "future", "value", "--if-version", version],
      ["remove-property", taskId, "future", "--if-version", version],
    ]),
    ["create"], ["create", "--title", "\u0085"], ["create", "--title", "\0"], ["create", "--title", "\ud800"],
    ["create", "--title", "Title", "--description", "\ud800"], ["create", "--title", "Title", "--description", "\0"],
    ["create", "--title", "Title", "--external-depends-on", "invalid"], ["update", taskId, "--external-depends-on", "invalid"],
    ["create", "--title", "Title", "--depends-on", "invalid"],
    ["create", "--title", "Title", "--depends-on", dependencyId, "--depends-on", dependencyId.toUpperCase()],
    ["create", "--title", "Title", "--external-depends-on", dependencyId, "--external-depends-on", dependencyId.toUpperCase()],
    ["update", taskId, "--depends-on", dependencyId, "--external-depends-on", dependencyId.toUpperCase()],
    ["update", taskId, "--external-depends-on", dependencyId, "--clear-dependencies"],
    ["list", "--status", "blocked"], ["list", "--status", "unknown"], ["set-status", taskId, "unknown"], ["set-status", taskId], ["set-status", "invalid", "todo"],
    ...["todo", "in_progress"].map((status) => ["set-status", taskId, status, "--claim-id", claimId]),
    ...["", "invalid", ` ${claimId}`, claimId.replaceAll("-", "")].map((value) => ["set-status", taskId, "done", `--claim-id=${value}`]),
    ["set-status", taskId, "done", "--claim-id"],
    ["set-status", taskId, "done", "--claim-id", claimId, `--claim-id=${claimId}`],
    ["show", taskId, "--claim-id", claimId], ["update", taskId, "--claim-id", claimId],
    ...["0", "1.5", "9223372036854775808"].map((version) => ["set-status", taskId, "todo", "--if-version", version]), ["update", taskId, "--status", "unknown"], ["list", "--project", "invalid"], ["show", "invalid"], ["show", taskId, "--project", "invalid"],
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
    ["graph"], ["graph", "invalid"], ["graph", taskId, "extra"], ["graph", taskId, "--depends-only", "--depends-only"],
    ["search"], ["search", ""], ["search", " \t"], ["search", "\0"], ["search", "x", "--project", "invalid"], ["search", "x", "--assigned-to", "invalid"], ["search", "x", "--status", "invalid"], ["search", "x", "--all"],
    ["graph", taskId, "--ready"], ["create", "--title", "Title", "--json"], ["list", "--ready", "--ready"],
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

  it("searches an explicit project without reading it and preserves the raw expression and filter values", async () => {
    const f = fixture();
    const query = '  title:"缓存 😀 \\"x\\""  ';
    await runTaskCommand(["search", query, "--project", projectId.toUpperCase(), "--status", "done", "--assigned-to", "me", "--ready", "--allow-agents", "false", "--compatible-platform", "linux", "--json"], f.context, f.dependencies);
    expect(f.api.getProject).not.toHaveBeenCalled();
    expect(f.dependencies.resolveProject).not.toHaveBeenCalled();
    expect(f.api.searchTasks).toHaveBeenCalledExactlyOnceWith(projectId, { query, status: "done", assignedTo: "me", ready: true, allowAgents: false, compatiblePlatform: "linux" });
    expect(f.context.stdout).toHaveBeenCalledExactlyOnceWith("[]\n");
  });

  it("resolves the repository when no project is supplied", async () => {
    const f = fixture();
    await runTaskCommand(["search", "--", "-literal"], f.context, f.dependencies);
    expect(f.dependencies.resolveProject).toHaveBeenCalledOnce();
    expect(f.api.getProject).not.toHaveBeenCalled();
    expect(f.api.searchTasks).toHaveBeenCalledExactlyOnceWith(projectId, { query: "-literal" });
    expect(f.context.stdout).toHaveBeenCalledExactlyOnceWith(`Project: ${projectId}\nNo matching tasks.\n`);
  });

  it("keeps stdout empty when a search exceeds its shared response budget", async () => {
    const operation = createOperation({ limits: { responseBytes: 32 } });
    const f = fixture(operation);
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(" ".repeat(33), { status: 200, headers: { "content-type": "application/json", "Daynight-User-ID": accountId } }));
    const api = createApiClient({ serverUrl: "http://localhost:8787", operation, fetch });
    f.api.searchTasks.mockImplementation(api.searchTasks);
    await expect(runTaskCommand(["search", "query", "--project", projectId, "--json"], f.context, f.dependencies)).rejects.toThrow("HTTP response byte limit exceeded");
    expect(fetch).toHaveBeenCalledOnce();
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

  it("submits dependency-removal consent with the supplied exact version after a task read", async () => {
    const f = fixture();
    await runTaskCommand(["delete", taskId, "--remove-depends", "--if-version", "9223372036854775807", "--project", projectId], f.context, f.dependencies);
    expect(f.api.getTask).toHaveBeenCalledExactlyOnceWith(projectId, taskId);
    expect(f.api.getTaskGraph).not.toHaveBeenCalled();
    expect(f.api.deleteTask).toHaveBeenCalledExactlyOnceWith(projectId, taskId, { version: 9_223_372_036_854_775_807n, removeDepends: true });
  });

  it("preserves a deletion refusal without rereading or retrying an explicit version", async () => {
    const f = fixture();
    const failure = new Error("Dependent tasks prevent deletion");
    f.api.deleteTask.mockRejectedValue(failure);
    await expect(runTaskCommand(["delete", taskId, "--if-version", "9223372036854775807", "--project", projectId], f.context, f.dependencies)).rejects.toBe(failure);
    expect(f.api.getTask).toHaveBeenCalledExactlyOnceWith(projectId, taskId);
    expect(f.api.deleteTask).toHaveBeenCalledExactlyOnceWith(projectId, taskId, { version: 9_223_372_036_854_775_807n });
    expect(f.context.stdout).not.toHaveBeenCalled();
  });

  it.each(["proposed", "todo", "in_progress", "done", "cancelled"] as const)("uses the observed version to set %s and prints the full confirmed result", async (status) => {
    const f = fixture();
    const result = { ...task, status, ready: status === "todo", cancelledAt: status === "cancelled" ? time : null, description: "Full status result", version: task.version + 1n };
    f.api.setTaskStatus.mockResolvedValue(result);
    await runTaskCommand(["set-status", taskId.toUpperCase(), status], f.context, f.dependencies);
    expect(f.dependencies.resolveProject).toHaveBeenCalledExactlyOnceWith({ serverUrl: "http://localhost:8787", operation: f.operation, api: f.api, workingDirectory: path.resolve("caller") });
    expect(f.api.getTask).toHaveBeenCalledExactlyOnceWith(projectId, taskId);
    expect(f.api.setTaskStatus).toHaveBeenCalledExactlyOnceWith(projectId, taskId, { version: task.version, status });
    expect(f.api.getTask.mock.invocationCallOrder[0]!).toBeLessThan(f.api.setTaskStatus.mock.invocationCallOrder[0]!);
    expect(f.api.updateTask).not.toHaveBeenCalled();
    expect(f.context.stdout.mock.calls[0]![0]).toBe(`Task status set.\n${renderTask(result)}`);
  });

  it.each(["proposed", "todo", "in_progress", "done", "cancelled"] as const)("submits the explicit full-int64 version for %s after reading the target without retrying conflicts", async (status) => {
    const f = fixture();
    const failure = new Error("Version conflict");
    f.api.setTaskStatus.mockRejectedValue(failure);
    await expect(runTaskCommand(["set-status", taskId, status, "--if-version", "9223372036854775807", "--project", projectId], f.context, f.dependencies)).rejects.toBe(failure);
    expect(f.api.getTask).toHaveBeenCalledExactlyOnceWith(projectId, taskId);
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

  it("submits the exact explicit worker completion version after reading the target without replaying a refusal", async () => {
    const f = fixture();
    const failure = new Error("Claim is no longer current");
    f.api.completeWorkerTask.mockRejectedValue(failure);

    await expect(runTaskCommand(["set-status", taskId, "done", `--claim-id=${claimId}`, "--if-version", "9223372036854775807", "--project", projectId], f.context, f.dependencies)).rejects.toBe(failure);

    expect(f.api.getTask).toHaveBeenCalledExactlyOnceWith(projectId, taskId);
    expect(f.api.completeWorkerTask).toHaveBeenCalledExactlyOnceWith(projectId, taskId, { version: 9_223_372_036_854_775_807n, claimId });
    expect(f.api.setTaskStatus).not.toHaveBeenCalled();
    expect(f.dependencies.resolveProject).not.toHaveBeenCalled();
    expect(f.context.stdout).not.toHaveBeenCalled();
  });

  it("does not infer worker completion when the observed task contains a claim", async () => {
    const f = fixture();
    f.api.getTask.mockResolvedValue({
      ...task, status: "in_progress", ready: false, startedAt: time,
      properties: { ...task.properties, worker: { claimId, state: "active", userId: projectId, workerId: dependencyId, machine: { id: otherDependencyId, name: "Build machine" }, platform: "linux", agent: "codex", agentControlMode: "herdr", worktreeId: taskId, phase: "executing", herdr: null, nativeSessionId: null, claimedAt: time } },
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
    const base = command === "create" ? [command, "--title", "Title"] : (command === "show" || command === "graph") ? [command, taskId.toUpperCase()] : command === "update" ? [command, taskId.toUpperCase(), "--description="] : [command];
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
    expect(f.api.createTask).toHaveBeenCalledExactlyOnceWith(projectId, { title: "Platform task", assignedTo: accountId, requiredPlatform });
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
    expect(f.api.listObservedTasks).toHaveBeenCalledExactlyOnceWith(projectId, { ready: true, allowAgents: true, compatiblePlatform });
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
    f.api.getObservedTask.mockResolvedValue(observe(value));
    f.api.listObservedTasks.mockResolvedValue({ items: [observe(value)], partial: false, unsupported: false });
    f.api.getObservedTaskGraph.mockResolvedValue(observeGraph({ ...graph, tasks: graph.tasks.map((item) => ({ ...item, requiredPlatform })) }));
    for (const args of [["show", taskId], ["list"], ["graph", taskId]]) await runTaskCommand([...args, "--project", projectId], f.context, f.dependencies);
    for (const [output] of f.context.stdout.mock.calls) expect(output).toContain(`Required platform: ${requiredPlatform === null ? "any" : requiredPlatform}\n`);
  });

  it.each([true, false])("forwards automatic-execution filter %s before list and ready pagination", async (allowAgents) => {
    const f = fixture();
    await runTaskCommand(["list", "--allow-agents", String(allowAgents), "--ready", "--project", projectId], f.context, f.dependencies);
    await runTaskCommand(["ready", "--allow-agents", String(allowAgents), "--limit", "1", "--project", projectId], f.context, f.dependencies);
    expect(f.api.listObservedTasks).toHaveBeenCalledExactlyOnceWith(projectId, { ready: true, allowAgents });
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
    expect(f.api.createTask).toHaveBeenCalledExactlyOnceWith(projectId, { title: "\ufeff", assignedTo: accountId });
  });

  it.each(["proposed", "todo"] as const)("forwards explicit initial status %s without changing assignment defaults", async (status) => {
    const f = fixture();
    await runTaskCommand(["create", "--title", "Confirmed scope", "--status", status, "--project", projectId], f.context, f.dependencies);
    expect(f.api.createTask).toHaveBeenCalledExactlyOnceWith(projectId, { title: "Confirmed scope", assignedTo: accountId, status });
  });

  it("normalizes mixed dependency declarations while preserving empty descriptions", async () => {
    const f = fixture();
    await runTaskCommand(["create", "--title=-Title=original", "--description=", "--depends-on", otherDependencyId.toUpperCase(), "--external-depends-on", dependencyId, "--project", projectId], f.context, f.dependencies);
    expect(f.api.createTask).toHaveBeenCalledExactlyOnceWith(projectId, { title: "-Title=original", description: "", assignedTo: accountId, dependsOn: [dependencyId, otherDependencyId], externalDependsOn: [dependencyId] });
  });

  it.each([
    { name: "ordinary-only", fields: ["--depends-on", dependencyId.toUpperCase()], externalDependsOn: [] },
    { name: "external-only", fields: ["--external-depends-on", dependencyId.toUpperCase()], externalDependsOn: [dependencyId] },
  ])("replaces both dependency sets for $name creation and updates", async ({ fields, externalDependsOn }) => {
    const f = fixture();
    await runTaskCommand(["create", "--title", "Title", ...fields, "--project", projectId], f.context, f.dependencies);
    expect(f.api.createTask).toHaveBeenCalledExactlyOnceWith(projectId, { title: "Title", assignedTo: accountId, dependsOn: [dependencyId], externalDependsOn });
    await runTaskCommand(["update", taskId, ...fields, "--if-version", "9223372036854775807", "--project", projectId], f.context, f.dependencies);
    expect(f.api.updateTask).toHaveBeenCalledExactlyOnceWith(projectId, taskId, { version: 9_223_372_036_854_775_807n, dependsOn: [dependencyId], externalDependsOn });
    expect(f.api.getTask).not.toHaveBeenCalled();
  });

  it("combines status and ready filters without inventing absent fields", async () => {
    const f = fixture();
    await runTaskCommand(["list", "--status", "todo", "--ready", "--project", projectId], f.context, f.dependencies);
    expect(f.api.listObservedTasks).toHaveBeenCalledExactlyOnceWith(projectId, { status: "todo", ready: true });
    const unfiltered = fixture();
    await runTaskCommand(["list", "--project", projectId], unfiltered.context, unfiltered.dependencies);
    expect(unfiltered.api.listObservedTasks).toHaveBeenCalledExactlyOnceWith(projectId, {});
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
    await expect(runTaskCommand(["update", taskId, "--description=", "--project", projectId], f.context, f.dependencies)).rejects.toBe(failure);
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
    const current = { ...task, properties: { pullRequests: [{ title: "First", url: "arbitrary text" }, { title: "First", url: "arbitrary text" }, { title: "", url: "" }] }, dependsOn: [dependencyId], externalDependsOn: [dependencyId], blockedBy: [dependencyId], ready: false };
    f.api.createTask.mockResolvedValue(current); f.api.getTask.mockResolvedValue(current); f.api.getObservedTask.mockResolvedValue(observe(current)); f.api.updateTask.mockResolvedValue(current);
    const base = command === "create" ? [command, "--title", "Title"] : command === "update" ? [command, taskId, "--description="] : [command, taskId];
    await runTaskCommand([...base, "--project", projectId], f.context, f.dependencies);
    const output = f.context.stdout.mock.calls[0]![0];
    for (const field of [`ID: ${taskId}`, `Project: ${projectId}`, `Title: ${task.title}`, `Description: ${task.description}`, `Status: ${task.status}`, "Automatic execution: false", `Version: ${task.version}`, "Ready: false", `Depends on: ${dependencyId}`, `External dependencies (1): ${dependencyId}`, `Blocked by: ${dependencyId}`, `Created: ${time}`, `Updated: ${time}`]) expect(output).toContain(field);
    expect(output).toContain('Properties: 1\n  pullRequests: [{"title":"First","url":"arbitrary text"},{"title":"First","url":"arbitrary text"},{"title":"","url":""}]\n');
  });

  it.each(["list", "ready", "show", "graph"])("preserves %s JSON fields with numeric full-int64 versions", async (command) => {
    const f = fixture();
    const base = (command === "show" || command === "graph") ? [command, taskId] : [command];
    await runTaskCommand([...base, "--json", "--project", projectId], f.context, f.dependencies);
    const output = f.context.stdout.mock.calls[0]![0];
    expect(output.endsWith("\n")).toBe(true);
    const parsed = parseApiJson(output);
    const { description: _description, ...listItem } = task;
    expect(parsed).toEqual(command === "list" ? [{ ...listItem, session }] : command === "ready" ? [task] : command === "graph" ? observeGraph(graph) : observe(task));
    if (command === "list") expect(parsed).not.toHaveProperty("0.description");
    if (command === "ready") expect(parsed).toHaveProperty("0.description", task.description);
    if (command !== "graph") expect(output).toContain('"version":9007199254740993');
  });

  it("renders every graph node, dependency and summary with explicit title truncation", async () => {
    const f = fixture();
    await runTaskCommand(["graph", taskId, "--project", projectId], f.context, f.dependencies);
    const output = f.context.stdout.mock.calls[0]![0];
    for (const field of [`Project: ${projectId}`, "Name: Project", `Repository: ${project.repoUrl}`, "Summary:", "Total: 1", "Proposed: 0", "Todo: 1", "In progress: 0", "Done: 0", "Ready: 1", "Blocked: 0", `ID: ${taskId}`, "Title preview: Task title", "Title truncated: true", "Depends on: none", "External dependencies (0): none", "Blocked by: none"]) expect(output).toContain(field);
    expect(f.api.getObservedTaskGraph).toHaveBeenCalledExactlyOnceWith(projectId, taskId);
  });

  it.each([false, true])("prints only complete dependency declarations in graph audit mode with JSON=%s", async (json) => {
    const f = fixture();
    const tasks = [
      { ...graph.tasks[0]!, dependsOn: [dependencyId], externalDependsOn: [dependencyId] },
      { ...graph.tasks[0]!, id: dependencyId, dependsOn: [otherDependencyId], externalDependsOn: [] },
    ];
    f.api.getTaskGraph.mockResolvedValue({ ...graph, tasks });
    await runTaskCommand(["graph", taskId.toUpperCase(), "--depends-only", ...(json ? ["--json"] : []), "--project", projectId], f.context, f.dependencies);
    expect(f.api.getTaskGraph).toHaveBeenCalledExactlyOnceWith(projectId, taskId);
    const output = f.context.stdout.mock.calls[0]![0];
    if (json) expect(parseApiJson(output)).toEqual([
      { id: taskId, dependsOn: [dependencyId], externalDependsOn: [dependencyId] },
      { id: dependencyId, dependsOn: [otherDependencyId], externalDependsOn: [] },
    ]);
    else expect(output).toBe(`ID: ${taskId}\nDepends on: ${dependencyId}\nExternal dependencies: ${dependencyId}\n\nID: ${dependencyId}\nDepends on: ${otherDependencyId}\nExternal dependencies: none\n`);
  });

  it("keeps terminal control characters visible and preserves raw JSON strings", async () => {
    const f = fixture();
    const raw = { ...task, title: "First\nSecond\u001b[2J", description: "Tab\tReturn\r\u0085", properties: { pullRequests: [{ title: "\0\n\u001b[2J", url: "Tab\tReturn\r\u0085" }, { title: "", url: "" }] } };
    f.api.getObservedTask.mockResolvedValue(observe(raw));
    await runTaskCommand(["show", taskId, "--project", projectId], f.context, f.dependencies);
    expect(f.context.stdout.mock.calls[0]![0]).toContain("First\\nSecond\\u001b[2J");
    expect(f.context.stdout.mock.calls[0]![0]).toContain("Tab\\tReturn\\r\\u0085");
    expect(f.context.stdout.mock.calls[0]![0]).toContain('"title":"\\u0000\\n\\u001b[2J"');
    await runTaskCommand(["show", taskId, "--project", projectId, "--json"], f.context, f.dependencies);
    expect(parseApiJson(f.context.stdout.mock.calls[1]![0])).toEqual(observe(raw));
  });

  it("renders an empty task list explicitly", async () => {
    const f = fixture(); f.api.listObservedTasks.mockResolvedValue({ items: [], partial: false, unsupported: false });
    await runTaskCommand(["list", "--project", projectId], f.context, f.dependencies);
    expect(f.context.stdout).toHaveBeenLastCalledWith("No tasks.\n");
  });

  it("renders an empty ready selection in human and JSON output", async () => {
    const f = fixture(); f.api.listReadyTasks.mockResolvedValue([]);
    await runTaskCommand(["ready", "--project", projectId], f.context, f.dependencies);
    expect(f.context.stdout).toHaveBeenLastCalledWith("No ready tasks.\n");
    await runTaskCommand(["ready", "--json", "--project", projectId], f.context, f.dependencies);
    expect(f.context.stdout).toHaveBeenLastCalledWith("[]\n");
  });

  it("preserves full titles and descriptions beside a longer task value", () => {
    const tasks = [task, { ...task, id: "22222222-2222-4222-8333-123456789abc", title: "Long task title ".repeat(4), description: "Long description ".repeat(4) }];
    const output = renderTaskList(tasks);
    for (const current of tasks) expect(output).toContain(`ID: ${current.id}\nProject: ${projectId}\nType: task\nParent: none\nTitle: ${current.title}\nTags: none\nDescription: ${current.description}\n`);
  });
});


describe("task responsibility options", () => {
  it.each([
    ["create", "--title", "Assigned task", "--assigned-to", "me"],
    ["create", "--title", "Assigned task", "--assigned-to", "unassigned"],
    ["create", "--title", "Assigned task", "--assigned-to", projectId, "--clear-assigned-to"],
    ["create", "--title", "Assigned task", "--assigned-to="],
    ["update", taskId, "--assigned-to", "me"],
    ["update", taskId, "--assigned-to", "unassigned"],
    ["update", taskId, "--assigned-to", projectId, "--clear-assigned-to"],
    ["update", taskId, "--clear-assigned-to", "--clear-assigned-to"],
    ["list", "--assigned-to="], ["list", "--assigned-to", "ME"],
    ["list", "--assigned-to", "Unassigned"], ["list", "--assigned-to", "bad"],
    ["ready", "--assigned-to", projectId],
  ])("rejects invalid responsibility options before any local or remote preparation: %j", async (...args) => {
    const f = fixture();
    await expect(runTaskCommand(args, f.context, f.dependencies)).rejects.toBeInstanceOf(UsageError);
    expect(f.dependencies.runServerCommand).not.toHaveBeenCalled();
    expect(f.dependencies.resolveProject).not.toHaveBeenCalled();
    expect(f.context.homeDirectory).not.toHaveBeenCalled(); expect(f.context.workingDirectory).not.toHaveBeenCalled();
    expect(f.context.stdout).not.toHaveBeenCalled();
  });

  it("assigns default creation to the authenticated account before submitting", async () => {
    const f = fixture();
    await runTaskCommand(["create", "--title", "My task", "--project", projectId], f.context, f.dependencies);
    expect(f.api.getCurrentUser).toHaveBeenCalledExactlyOnceWith();
    expect(f.api.createTask).toHaveBeenCalledExactlyOnceWith(projectId, { title: "My task", assignedTo: accountId });
    expect(f.api.getCurrentUser.mock.invocationCallOrder[0]!).toBeLessThan(f.api.createTask.mock.invocationCallOrder[0]!);
  });

  it("preserves an identity failure without submitting an unassigned task", async () => {
    const f = fixture();
    const failure = new Error("Current account unavailable");
    f.api.getCurrentUser.mockRejectedValue(failure);
    await expect(runTaskCommand(["create", "--title", "My task", "--project", projectId], f.context, f.dependencies)).rejects.toBe(failure);
    expect(f.api.getCurrentUser).toHaveBeenCalledOnce();
    expect(f.api.createTask).not.toHaveBeenCalled();
    expect(f.context.stdout).not.toHaveBeenCalled();
  });

  it("stops before creation when cancelled during the identity read", async () => {
    const cancellation = new AbortController();
    const f = fixture(createOperation({ signal: cancellation.signal }));
    f.api.getCurrentUser.mockImplementation(async () => { cancellation.abort(); return currentUser; });
    await expect(runTaskCommand(["create", "--title", "My task", "--project", projectId], f.context, f.dependencies)).rejects.toThrow("Operation cancelled");
    expect(f.api.getCurrentUser).toHaveBeenCalledOnce();
    expect(f.api.createTask).not.toHaveBeenCalled();
    expect(f.context.stdout).not.toHaveBeenCalled();
  });

  it("sets and clears native assignment using exact versions without task reads", async () => {
    const f = fixture();
    f.api.createTask.mockResolvedValue({ ...task, assignedTo: dependencyId });
    f.api.updateTask.mockResolvedValue({ ...task, assignedTo: dependencyId });
    await runTaskCommand(["create", "--title", "Assigned task", "--assigned-to", dependencyId.toUpperCase(), "--project", projectId], f.context, f.dependencies);
    expect(f.api.createTask).toHaveBeenCalledExactlyOnceWith(projectId, { title: "Assigned task", assignedTo: dependencyId });
    await runTaskCommand(["update", taskId, "--assigned-to", dependencyId.toUpperCase(), "--title", "Updated", "--allow-agents", "true", "--if-version", "9223372036854775807", "--project", projectId], f.context, f.dependencies);
    expect(f.api.updateTask).toHaveBeenLastCalledWith(projectId, taskId, { assignedTo: dependencyId, title: "Updated", allowAgents: true, version: 9_223_372_036_854_775_807n });
    f.api.updateTask.mockResolvedValue(task);
    await runTaskCommand(["update", taskId, "--clear-assigned-to", "--if-version", "9007199254740993", "--project", projectId], f.context, f.dependencies);
    expect(f.api.updateTask).toHaveBeenLastCalledWith(projectId, taskId, { assignedTo: null, version: 9_007_199_254_740_993n });
    expect(f.api.getTask).not.toHaveBeenCalled(); expect(f.api.getCurrentUser).not.toHaveBeenCalled();
  });

  it("retains the existing one-read default version path for an assignment-only update", async () => {
    const f = fixture();
    await runTaskCommand(["update", taskId, "--clear-assigned-to", "--project", projectId], f.context, f.dependencies);
    expect(f.api.getTask).toHaveBeenCalledExactlyOnceWith(projectId, taskId);
    expect(f.api.updateTask).toHaveBeenCalledExactlyOnceWith(projectId, taskId, { assignedTo: null, version: task.version });
  });

  it.each([dependencyId, "me", "unassigned"])("passes responsibility filter %s before pagination without another identity request", async (assignedTo) => {
    const f = fixture();
    await runTaskCommand(["list", "--assigned-to", assignedTo, "--ready", "--allow-agents", "true", "--project", projectId], f.context, f.dependencies);
    expect(f.api.listObservedTasks).toHaveBeenCalledExactlyOnceWith(projectId, { assignedTo, ready: true, allowAgents: true });
    expect(f.api.getCurrentUser).not.toHaveBeenCalled();
  });

  it.each([null, dependencyId])("renders current assignment %s without changing dependency-only JSON", async (assignedTo) => {
    const f = fixture();
    const value = { ...task, assignedTo };
    f.api.getObservedTask.mockResolvedValue(observe(value)); f.api.listObservedTasks.mockResolvedValue({ items: [observe(value)], partial: false, unsupported: false }); f.api.listReadyTasks.mockResolvedValue([value]);
    f.api.getObservedTaskGraph.mockResolvedValue(observeGraph({ ...graph, tasks: graph.tasks.map((item) => ({ ...item, assignedTo })) }));
    for (const args of [["show", taskId], ["list"], ["ready"], ["graph", taskId]]) await runTaskCommand([...args, "--project", projectId], f.context, f.dependencies);
    for (const [output] of f.context.stdout.mock.calls) expect(output).toContain(`Assigned to: ${assignedTo === null ? "unassigned" : assignedTo}\n`);
    f.context.stdout.mockClear();
    await runTaskCommand(["graph", taskId, "--depends-only", "--json", "--project", projectId], f.context, f.dependencies);
    expect(parseApiJson(f.context.stdout.mock.calls[0]![0])).toEqual([{ id: taskId, dependsOn: [], externalDependsOn: [] }]);
  });

  it.each(["create", "update", "list"])("advertises the assignment option in %s help", async (command) => {
    const f = fixture();
    await runTaskCommand([command, "--help"], f.context, f.dependencies);
    expect(f.context.stdout.mock.calls[0]![0]).toContain("--assigned-to");
    if (command === "update") expect(f.context.stdout.mock.calls[0]![0]).toContain("--clear-assigned-to");
    expect(f.dependencies.runServerCommand).not.toHaveBeenCalled();
  });
});


describe("generic task property commands", () => {
  it("loads server definitions without project preparation or task reads", async () => {
    const f = fixture();
    await runTaskCommand(["properties", "--schema", "--json"], f.context, f.dependencies);
    expect(f.api.getTaskPropertySchema).toHaveBeenCalledOnce();
    expect(f.api.getTaskProperties).not.toHaveBeenCalled();
    expect(f.api.getTask).not.toHaveBeenCalled(); expect(f.api.getProject).not.toHaveBeenCalled(); expect(f.api.listProjects).not.toHaveBeenCalled();
    expect(f.context.workingDirectory).not.toHaveBeenCalled(); expect(f.dependencies.resolveProject).not.toHaveBeenCalled();
    expect(parseApiJson(f.context.stdout.mock.calls[0]![0])).toEqual(propertySchema);
  });

  it("reads current values with exact identity and no redundant project read", async () => {
    const f = fixture();
    const expected = { ...propertyResource, properties: { future: { version: 7, enabled: true }, empty: [] } };
    f.api.getTaskProperties.mockResolvedValue(expected);
    await runTaskCommand(["properties", taskId.toUpperCase(), "--project", projectId.toUpperCase(), "--json"], f.context, f.dependencies);
    expect(f.api.getTaskProperties).toHaveBeenCalledExactlyOnceWith(projectId, taskId);
    expect(f.api.getTask).not.toHaveBeenCalled(); expect(f.api.getProject).not.toHaveBeenCalled(); expect(f.api.getTaskPropertySchema).not.toHaveBeenCalled();
    expect(f.context.workingDirectory).not.toHaveBeenCalled(); expect(f.dependencies.resolveProject).not.toHaveBeenCalled();
    expect(parseApiJson(f.context.stdout.mock.calls[0]![0])).toEqual(expected);
  });

  it("uses repository discovery only when no project was supplied", async () => {
    const f = fixture();
    await runTaskCommand(["properties", taskId], f.context, f.dependencies);
    expect(f.context.workingDirectory).toHaveBeenCalledOnce(); expect(f.dependencies.resolveProject).toHaveBeenCalledOnce();
    expect(f.api.getProject).not.toHaveBeenCalled(); expect(f.api.getTaskProperties).toHaveBeenCalledExactlyOnceWith(projectId, taskId);
    expect(f.context.stdout.mock.calls[0]![0]).toContain(`Version: ${task.version}`);
    expect(f.context.stdout.mock.calls[0]![0]).toContain("pullRequests: []");
  });

  it.each(["", "abc", "123", "true", "null", '"quoted"', '{"duplicate":1,"duplicate":2}', ' \n[1,2]\t '])("forwards raw input without parsing or schema requests: %#", async (valueText) => {
    const f = fixture();
    await runTaskCommand(["set-property", taskId, "future.name", valueText, "--if-version", "9223372036854775807", "--project", projectId], f.context, f.dependencies);
    expect(f.api.setTaskProperty).toHaveBeenCalledExactlyOnceWith(projectId, taskId, "future.name", { version: 9_223_372_036_854_775_807n, valueText });
    expect(f.api.getTaskProperties).not.toHaveBeenCalled(); expect(f.api.getTask).not.toHaveBeenCalled(); expect(f.api.getProject).not.toHaveBeenCalled(); expect(f.api.getTaskPropertySchema).not.toHaveBeenCalled();
    expect(f.context.stdout.mock.calls[0]![0]).toContain("Task property set.");
  });

  it.each(["-123", "-text"])("preserves a dash-prefixed value after the option terminator: %s", async (valueText) => {
    const f = fixture();
    await runTaskCommand(["set-property", taskId, "future", "--project", projectId, "--", valueText], f.context, f.dependencies);
    expect(f.api.setTaskProperty).toHaveBeenCalledExactlyOnceWith(projectId, taskId, "future", { version: task.version, valueText });
    expect(f.api.getTaskProperties).toHaveBeenCalledExactlyOnceWith(projectId, taskId);
  });

  it.each(["set-property", "remove-property"])("reads the property version once before default-version %s", async (name) => {
    const f = fixture();
    await runTaskCommand([name, taskId, "pullRequests", ...(name === "set-property" ? ["[]"] : []), "--project", projectId], f.context, f.dependencies);
    expect(f.api.getTaskProperties).toHaveBeenCalledExactlyOnceWith(projectId, taskId);
    const mutation = name === "set-property" ? f.api.setTaskProperty : f.api.removeTaskProperty;
    expect(mutation).toHaveBeenCalledOnce();
    expect(f.api.getTaskProperties.mock.invocationCallOrder[0]!).toBeLessThan(mutation.mock.invocationCallOrder[0]!);
    expect(f.api.getTask).not.toHaveBeenCalled(); expect(f.api.getProject).not.toHaveBeenCalled(); expect(f.api.getTaskPropertySchema).not.toHaveBeenCalled();
  });

  it("removes a whole literal key using an explicit version and prints actual missing-key values", async () => {
    const f = fixture();
    await runTaskCommand(["remove-property", taskId, "future.name", "--if-version", "9007199254740993", "--project", projectId], f.context, f.dependencies);
    expect(f.api.removeTaskProperty).toHaveBeenCalledExactlyOnceWith(projectId, taskId, "future.name", { version: task.version });
    expect(f.api.getTaskProperties).not.toHaveBeenCalled(); expect(f.api.getTask).not.toHaveBeenCalled(); expect(f.api.getProject).not.toHaveBeenCalled();
    expect(f.context.stdout.mock.calls[0]![0]).toContain("Task property removed.");
    expect(f.context.stdout.mock.calls[0]![0]).not.toContain("pullRequests: []");
  });

  it.each([
    { code: "invalid_input", status: 400, unknown: false },
    { code: "version_conflict", status: 409, unknown: false },
    { code: "internal_error", status: 500, unknown: true },
  ])("propagates $code without replay, schema reads, or a fresh-version retry", async ({ code, status, unknown }) => {
    const f = fixture();
    const failure = new ApiError({ operation: "task.property.set", projectId, taskId }, "response", { cause: new Error(code), status, serverError: { code, message: "Property refused", requestId: "property-refusal" }, outcomeUnconfirmed: unknown, confirmedRefusal: !unknown });
    f.api.setTaskProperty.mockRejectedValue(failure);
    await expect(runTaskCommand(["set-property", taskId, "worker", "not JSON", "--project", projectId], f.context, f.dependencies)).rejects.toBe(failure);
    expect(f.api.getTaskProperties).toHaveBeenCalledOnce(); expect(f.api.setTaskProperty).toHaveBeenCalledOnce();
    expect(f.api.getTaskPropertySchema).not.toHaveBeenCalled(); expect(f.context.stdout).not.toHaveBeenCalled();
  });

  it("does not write after a failed or cancelled property version read", async () => {
    const failure = new Error("Properties unavailable");
    const f = fixture(); f.api.getTaskProperties.mockRejectedValue(failure);
    await expect(runTaskCommand(["remove-property", taskId, "future", "--project", projectId], f.context, f.dependencies)).rejects.toBe(failure);
    expect(f.api.removeTaskProperty).not.toHaveBeenCalled();
    const cancellation = new AbortController(); const cancelled = fixture(createOperation({ signal: cancellation.signal }));
    cancelled.api.getTaskProperties.mockImplementation(async () => { cancellation.abort(); return propertyResource; });
    await expect(runTaskCommand(["set-property", taskId, "future", "raw", "--project", projectId], cancelled.context, cancelled.dependencies)).rejects.toThrow("cancelled");
    expect(cancelled.api.setTaskProperty).not.toHaveBeenCalled(); expect(cancelled.context.stdout).not.toHaveBeenCalled();
  });
});
