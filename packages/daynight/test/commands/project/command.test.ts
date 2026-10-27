import { describe, expect, it, vi } from "vitest";
import { ApiError, createOperation, parseApiJson } from "../../../src/api/index.js";
import type { ApiClient, Project } from "../../../src/api/index.js";
import { UsageError } from "../../../src/cli/context.js";
import { runProjectCommand } from "../../../src/commands/project/command.js";
import type { ProjectCommandDependencies } from "../../../src/commands/project/command.js";
import { renderProjectList } from "../../../src/commands/project/rendering.js";

const id = "abcdefab-1234-5678-90ab-abcdefabcdef";
const project: Project = { id, name: "Project 名称", repoUrl: "git@Git.Example:Org/Repo.git", settings: { version: 1n, executionWarningMinutes: 60 }, createdAt: "2026-10-20T01:02:03.123456789Z", updatedAt: "2026-10-20T02:03:04.987654321Z" };
const context = () => ({
  version: "0.0.0", packageDirectory: "unused", homeDirectory: vi.fn<() => string>(() => { throw new Error("Home directory must not be read by project dispatch"); }),
  workingDirectory: vi.fn<() => string>(() => { throw new Error("Working directory must not be read by project commands"); }),
  stdoutBytes: vi.fn(async () => {}), stdout: vi.fn<(value: string) => void>(), stderr: vi.fn<(value: string) => void>(),
});
const fixture = (projects: readonly Project[] = []) => {
  const unavailable = async (): Promise<never> => { throw new Error("Unexpected task API"); };
  const api = {
    listProjectMembers: async () => { throw new Error("Unused project member API method"); },
    getCurrentUser: unavailable,
    createProject: vi.fn<ApiClient["createProject"]>().mockResolvedValue(project),
    listProjects: vi.fn<ApiClient["listProjects"]>().mockResolvedValue(projects),
    getProject: vi.fn<ApiClient["getProject"]>().mockResolvedValue(project),
    listTaskPage: async () => { throw new Error("Unused worker API method"); },
    claimWorkerTask: async () => { throw new Error("Unused worker API method"); },
    updateWorkerClaim: async () => { throw new Error("Unused worker API method"); },
    completeWorkerTask: async () => { throw new Error("Unused worker API method"); },
    releaseWorkerClaim: async () => { throw new Error("Unused worker API method"); },
    transferWorkerClaim: async () => { throw new Error("Unused worker API method"); },
    resumeWorkerTask: async () => { throw new Error("Unused worker API method"); },
    createTask: unavailable, getTask: unavailable, listTasks: unavailable, listReadyTasks: unavailable, updateTask: unavailable, deleteTask: unavailable, setTaskStatus: unavailable, getTaskGraph: unavailable,
    putTaskAttachment: unavailable, listTaskAttachments: unavailable, readTaskAttachment: unavailable, removeTaskAttachment: unavailable,
  };
  const runServerCommand = vi.fn<ProjectCommandDependencies["runServerCommand"]>(async (current, command) => {
    const operation = createOperation();
    try {
      const output = await command({ api, operation, serverUrl: "http://server.example:8787" });
      if (typeof output === "string") current.stdout(output);
    }
    finally { operation.dispose(); }
  });
  return { api, dependencies: { runServerCommand }, context: context() };
};

describe("project command boundaries", () => {
  it.each([[], ["--help"], ["-h"], ["create", "--help"], ["list", "--help"], ["show", "--help"]].map((args) => ({ args })))("renders help without consulting command dependencies: $args", async ({ args }) => {
    const { context, dependencies } = fixture();
    await runProjectCommand(args, context, dependencies);
    expect(context.stdout).toHaveBeenCalledOnce();
    expect(context.stdout.mock.calls[0]![0]).toMatch(/^Usage: daynight project/);
    expect(dependencies.runServerCommand).not.toHaveBeenCalled();
    expect(context.homeDirectory).not.toHaveBeenCalled();
    expect(context.workingDirectory).not.toHaveBeenCalled();
  });

  it.each([
    ["unknown"], ["create"], ["create", "--repo", "https://git.example/o/r"],
    ["create", "--name", "Name", "--repo", "remote"], ["create", "Name", "Again", "--repo", "remote"],
    ["create", "--repo", "remote", "-leading"], ["create", "--", "Name", "--repo", "remote"], ["create", "Name", "--repo", "remote", "--json"],
    ["list", "extra"], ["list", "--project", id], ["list", "--json", "--json"], ["show"], ["show", "invalid"], ["show", id, "extra"],
  ].map((args) => ({ args })))("rejects bad arguments before runtime or location access: $args", async ({ args }) => {
    const { context, dependencies } = fixture();
    await expect(runProjectCommand(args, context, dependencies)).rejects.toBeInstanceOf(UsageError);
    expect(dependencies.runServerCommand).not.toHaveBeenCalled();
    expect(context.homeDirectory).not.toHaveBeenCalled();
    expect(context.workingDirectory).not.toHaveBeenCalled();
    expect(context.stdout).not.toHaveBeenCalled();
  });

  it.each(["", " \t\r\n", "\u0085", "\u2003\u3000", "\0", "\ud800"])("rejects a server-invalid name before runtime: %j", async (name) => {
    const { context, dependencies } = fixture();
    await expect(runProjectCommand(["create", name, "--repo", "https://git.example/o/r"], context, dependencies)).rejects.toBeInstanceOf(UsageError);
    expect(dependencies.runServerCommand).not.toHaveBeenCalled();
  });

  it("preserves FEFF-only names and explicit repository addresses", async () => {
    const { api, context, dependencies } = fixture();
    const repoUrl = "https://git.example/o/r.git";
    await runProjectCommand(["create", "\ufeff", "--repo", repoUrl], context, dependencies);
    expect(api.createProject).toHaveBeenCalledExactlyOnceWith({ name: "\ufeff", repoUrl });
    expect(context.workingDirectory).not.toHaveBeenCalled();
  });

  it.each(["Project 中文", "  Original name  ", "\ufeff\u0085", "name\nwith lines"])("passes the original positional name and explicit repo to the API: %j", async (name) => {
    for (const args of [["create", name, "--repo", project.repoUrl], ["create", "--repo", project.repoUrl, name]]) {
      const { api, context, dependencies } = fixture();
      await runProjectCommand(args, context, dependencies);
      expect(api.createProject).toHaveBeenCalledExactlyOnceWith({ name, repoUrl: project.repoUrl });
    }
  });

  it.each(["-leading", "--name", "--help", "--", "-中文"])("preserves dash-prefixed names after the options terminator: %j", async (name) => {
    const { api, context, dependencies } = fixture();
    await runProjectCommand(["create", "--repo", project.repoUrl, "--", name], context, dependencies);
    expect(api.createProject).toHaveBeenCalledExactlyOnceWith({ name, repoUrl: project.repoUrl });
  });

  it("describes the required positional name and dash syntax in create help", async () => {
    const { context, dependencies } = fixture();
    await runProjectCommand(["create", "--help"], context, dependencies);
    const output = context.stdout.mock.calls[0]![0];
    expect(output).toContain("Usage: daynight project create <name> [--repo <repo>]");
    expect(output).toContain("<name>  Project name");
    expect(output).toContain("use -- before the name");
    expect(output).not.toContain("--name");
  });

  it("returns the original server project for an equivalent repository without renaming it", async () => {
    const { api, context, dependencies } = fixture([project]);
    await runProjectCommand(["create", "A different name", "--repo", "https://git.example/Org/Repo"], context, dependencies);
    expect(api.listProjects).toHaveBeenCalledOnce();
    expect(api.createProject).not.toHaveBeenCalled();
    expect(context.stdout.mock.calls[0]![0]).toContain(`Project already exists.\nID: ${id}\nName: ${project.name}\n`);
    expect(context.workingDirectory).not.toHaveBeenCalled();
  });

  it("rejects ambiguous repository matches with their IDs before creation", async () => {
    const second = { ...project, id: "22222222-2222-2222-2222-222222222222", repoUrl: "https://git.example/Org/Repo" };
    const { api, context, dependencies } = fixture([project, second]);
    await expect(runProjectCommand(["create", "Name", "--repo", project.repoUrl], context, dependencies)).rejects.toThrow(`Multiple projects match this repository (${id}, ${second.id})`);
    expect(api.createProject).not.toHaveBeenCalled();
    expect(context.stdout).not.toHaveBeenCalled();
  });

  it("rejects an invalid listed repository before creation even after an earlier match", async () => {
    const { api, context, dependencies } = fixture([project, { ...project, repoUrl: "invalid repository" }]);
    await expect(runProjectCommand(["create", "Name", "--repo", project.repoUrl], context, dependencies)).rejects.toThrow("Invalid repository address");
    expect(api.createProject).not.toHaveBeenCalled();
    expect(context.stdout).not.toHaveBeenCalled();
  });

  it("checks cancellation after listing and does not create", async () => {
    const controller = new AbortController();
    const operation = createOperation({ signal: controller.signal });
    const { api, context } = fixture();
    api.listProjects.mockImplementation(async () => { controller.abort(new Error("Cancelled after listing")); return []; });
    try {
      const failure = await runProjectCommand(["create", "Name", "--repo", project.repoUrl], context, { runServerCommand: async (_current, command) => { await command({ api, operation, serverUrl: "http://server.example" }); } }).catch((error: unknown) => error);
      expect(failure).toBe(operation.signal.reason);
      expect(api.createProject).not.toHaveBeenCalled();
    } finally { operation.dispose(); }
  });

  it("canonicalizes an explicit show UUID before the API call", async () => {
    const { api, context, dependencies } = fixture();
    await runProjectCommand(["show", id.toUpperCase()], context, dependencies);
    expect(api.getProject).toHaveBeenCalledExactlyOnceWith(id);
    expect(context.workingDirectory).not.toHaveBeenCalled();
  });
});

describe("project command output", () => {
  it("prints the confirmed created resource with every project field", async () => {
    const { api, context, dependencies } = fixture();
    const name = "  Original name  ";
    await runProjectCommand(["create", name, "--repo", project.repoUrl], context, dependencies);
    expect(api.createProject).toHaveBeenCalledExactlyOnceWith({ name, repoUrl: project.repoUrl });
    expect(context.stdout).toHaveBeenCalledExactlyOnceWith(`Project created.\nID: ${id}\nName: ${project.name}\nRepository: ${project.repoUrl}\nCreated: ${project.createdAt}\nUpdated: ${project.updatedAt}\n`);
    expect(context.stderr).not.toHaveBeenCalled();
  });

  it("prints server ordering and full IDs, names and repository addresses in the list", async () => {
    const other = { ...project, id: "22222222-2222-2222-2222-222222222222", name: "Second project", repoUrl: "https://git.example/Other/Repo" };
    const { context, dependencies } = fixture([other, project]);
    await runProjectCommand(["list"], context, dependencies);
    const output = context.stdout.mock.calls[0]![0];
    expect(output).toMatch(new RegExp(`^ID: ${other.id}\\nName: ${other.name}\\nRepository: `));
    expect(output.indexOf(other.id)).toBeLessThan(output.indexOf(project.id));
    for (const value of [other.name, other.repoUrl, project.name, project.repoUrl]) expect(output).toContain(value);
  });

  it.each([false, true])("renders an empty list with json=%s", async (json) => {
    const { context, dependencies } = fixture([]);
    await runProjectCommand(json ? ["list", "--json"] : ["list"], context, dependencies);
    expect(context.stdout).toHaveBeenCalledExactlyOnceWith(json ? "[]\n" : "No projects.\n");
  });

  it.each(["list", "show"])("preserves complete raw resource data in %s JSON", async (command) => {
    const raw = { ...project, name: "First\nSecond\u001b[2J", repoUrl: "https://git.example/Org/Repo.git", createdAt: "2026-10-20T01:02:03.123456789Z" };
    const { api, context, dependencies } = fixture([raw]);
    api.getProject.mockResolvedValue(raw);
    await runProjectCommand(command === "list" ? ["list", "--json"] : ["show", id, "--json"], context, dependencies);
    const output = context.stdout.mock.calls[0]![0];
    expect(output.endsWith("\n")).toBe(true);
    expect(parseApiJson(output)).toEqual(command === "list" ? [raw] : raw);
  });

  it.each(["create", "list", "show"])("escapes server-controlled terminal characters in %s human output", async (command) => {
    const raw = { ...project, name: "First\nSecond\u001b[2J\u0085", repoUrl: "git@git.example:Org/Repo\t.git" };
    const { api, context, dependencies } = fixture(command === "create" ? [] : [raw]);
    api.getProject.mockResolvedValue(raw); api.createProject.mockResolvedValue(raw);
    const args = command === "create" ? ["create", "Name", "--repo", "https://git.example/Other/Repo"] : command === "show" ? ["show", id] : ["list"];
    await runProjectCommand(args, context, dependencies);
    const output = context.stdout.mock.calls[0]![0];
    expect(output).toContain("First\\nSecond\\u001b[2J\\u0085");
    expect(output).toContain("Repo\\t.git");
    expect(output).not.toMatch(/[\u001b\u0085\t]/);
  });

  it("renders a large complete list without argument-stack limits", () => {
    const projects = Array.from({ length: 140_000 }, (_, index) => ({ ...project, id: `${index.toString(16).padStart(8, "0")}-1234-5678-90ab-abcdefabcdef` }));
    const output = renderProjectList(projects);
    let count = 0;
    for (const _ of output.matchAll(/^ID: /gm)) count++;
    expect(count).toBe(projects.length);
    expect(output).toContain(projects.at(-1)!.id);
  });

  it("keeps full human list output linear when one project has a long name", () => {
    const projects = Array.from({ length: 1_000 }, (_, index) => ({ ...project, id: `${index.toString(16).padStart(8, "0")}-1234-5678-90ab-abcdefabcdef`, name: index === 0 ? "N".repeat(4_096) : `Project ${index}` }));
    const output = renderProjectList(projects);
    let contentLength = 0;
    for (const current of projects) {
      expect(output).toContain(`ID: ${current.id}\nName: ${current.name}\nRepository: ${current.repoUrl}\n`);
      contentLength += current.id.length + current.name.length + current.repoUrl.length + current.createdAt.length + current.updatedAt.length;
    }
    expect(output.length).toBeLessThanOrEqual(contentLength + 80 * projects.length);
  });

  it.each(["create", "list", "show"])("preserves an API refusal without success output for %s", async (command) => {
    const { api, context, dependencies } = fixture();
    const failure = new ApiError({ operation: `project.${command}`, projectId: id }, "response", { cause: new Error("Server rejected operation"), status: 409, serverError: { code: "conflict", message: "Server rejected operation", requestId: "project-request" } });
    api.createProject.mockRejectedValue(failure); api.listProjects.mockRejectedValue(failure); api.getProject.mockRejectedValue(failure);
    const args = command === "create" ? ["create", "Name", "--repo", "https://git.example/Other/Repo"] : command === "show" ? ["show", id] : ["list"];
    await expect(runProjectCommand(args, context, dependencies)).rejects.toBe(failure);
    expect(context.stdout).not.toHaveBeenCalled();
  });
});
