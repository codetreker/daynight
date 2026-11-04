import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiClient, createOperation, stringifyApiJson } from "../../../src/api/index.js";
import type { Project } from "../../../src/api/types.js";
import { runCli } from "../../../src/cli/application.js";
import type { CliContext } from "../../../src/cli/context.js";
import { runTaskCommand } from "../../../src/commands/task/command.js";
import type { TaskCommandDependencies } from "../../../src/commands/task/command.js";
import { taskDefinition } from "../../../src/commands/task/definition.js";
import { StepReadCommandError } from "../../../src/commands/task/step-diagnostics.js";
import { formatError } from "../../../src/platform/diagnostics.js";
import { resolveProject } from "../../../src/repository/context.js";
import { ProjectDiscoveryError } from "../../../src/repository/discovery-error.js";

const projectId = "aaaaaaaa-1111-4111-8111-111111111111";
const otherId = "bbbbbbbb-2222-4222-8222-222222222222";
const unrelatedId = "cccccccc-3333-4333-8333-333333333333";
const taskId = "dddddddd-4444-4444-8444-444444444444";
const time = "2026-11-03T10:11:12.123456Z";
const serverUrl = "http://localhost:8787";
const project: Project = { id: projectId, name: "private-project-name\n\u001b[31m token-secret", repoUrl: "https://git.example/Org/Repo.git", settings: { version: 1n, executionWarningMinutes: 60 }, createdAt: time, updatedAt: time };
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const fixture = async (count: 0 | 2) => {
  const temporary = path.resolve(import.meta.dirname, "../../../../../.tmp/step-discovery-tests");
  await mkdir(temporary, { recursive: true });
  const root = await mkdtemp(path.join(temporary, "resolver-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", root]);
  execFileSync("git", ["-C", root, "remote", "add", "origin", "git@git.example:Org/Repo.git"]);
  const operation = createOperation(); cleanups.push(() => operation.dispose());
  const calls: string[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, options) => {
    const url = new URL(String(input)); calls.push(`${options?.method} ${url.pathname}${url.search}`);
    if (url.pathname !== "/api/v1/projects") throw new Error("private-unexpected-resource-token");
    const second = url.searchParams.has("cursor");
    const items = count === 0 ? second ? [] : [{ ...project, id: unrelatedId, repoUrl: "https://git.example/Other/Repo.git" }]
      : [{ ...project, id: second ? otherId : projectId }];
    return new Response(stringifyApiJson({ items, nextCursor: second ? null : "second-page" }), { headers: { "Content-Type": "application/json" } });
  });
  const api = createApiClient({ serverUrl, operation, fetch });
  const context = {
    version: "0.0.0", packageDirectory: "unused", homeDirectory: vi.fn(() => { throw new Error("private-configuration-path-token"); }), workingDirectory: vi.fn(() => root),
    stdout: vi.fn<(text: string) => void>(), stderr: vi.fn<(text: string) => void>(), stdoutBytes: vi.fn(async () => {}),
  } satisfies CliContext;
  const dependencies: TaskCommandDependencies = {
    resolveProject,
    runServerCommand: async (current, command) => {
      const output = await command({ api, operation, serverUrl });
      if (typeof output === "string") current.stdout(output);
    },
  };
  const registry = [{ ...taskDefinition, load: async () => ({ run: (args: readonly string[], current: CliContext) => runTaskCommand(args, current, dependencies) }) }];
  return { root, context, dependencies, registry, fetch, calls };
};

describe("Steps expected project discovery failures", () => {
  it.each([0, 2] as const)("keeps real paginated discovery recovery for %i matches in list and show", async (count) => {
    for (const name of ["list", "show"] as const) {
      const f = await fixture(count);
      const code = await runCli(["task", "step", name, taskId, ...(name === "show" ? ["00abcdef"] : [])], f.context, f.registry);
      expect(code).toBe(1); expect(f.context.stdout).not.toHaveBeenCalled(); expect(f.context.stdoutBytes).not.toHaveBeenCalled();
      const error = f.context.stderr.mock.calls[0]![0];
      if (count === 0) expect(error).toContain("Project does not exist.");
      else {
        expect(error).toContain(`Multiple projects match this repository (${projectId}, ${otherId})`);
        expect(error).toContain("--project <id>");
      }
      expect(error).toContain(`operation=task.step.${name} phase=prepare`); expect(error).toContain(`taskId=${taskId}`);
      expect(error).not.toContain("projectId="); expect(error).not.toContain("daynight login");
      expect(error).not.toMatch(/private-|token-secret|git\.example|\u001b/);
      expect(f.calls).toEqual(["GET /api/v1/projects?limit=100", "GET /api/v1/projects?limit=100&cursor=second-page"]);
      expect((await readdir(f.root)).toSorted()).toEqual([".git"]);
      expect(f.context.homeDirectory).not.toHaveBeenCalled();
    }
  });

  it("retains trusted discovery facts through cause and aggregate wrappers, ignoring mutable message text", () => {
    const source = [projectId, otherId];
    const discovery = new ProjectDiscoveryError(source);
    source[0] = unrelatedId;
    discovery.message = "private-mutated-error-message";
    expect(discovery.projectIds).toEqual([projectId, otherId]); expect(Object.isFrozen(discovery.projectIds)).toBe(true);
    const wrapper = new Error("private-wrapper", { cause: discovery });
    const aggregate = new AggregateError([new Error("private-cleanup-token"), wrapper], "private-aggregate");
    for (const cause of [discovery, wrapper, aggregate]) {
      const error = new StepReadCommandError(cause, "show", "prepare", undefined, taskId, "00abcdef");
      expect(error.cause).toBe(cause); expect(error.exitCode).toBe(1);
      const text = formatError(error);
      expect(text).toContain(projectId); expect(text).toContain(otherId); expect(text).toContain("--project <id>");
      expect(text).not.toContain(unrelatedId); expect(text).not.toContain("private-");
    }
    const cycle = new Error("private-cycle"); cycle.cause = cycle;
    const error = new StepReadCommandError(new AggregateError([cycle, new ProjectDiscoveryError([])], "private-aggregate"), "list", "prepare");
    expect(formatError(error)).toContain("Project does not exist."); expect(formatError(error)).not.toContain("private-");
  });

  it("does not trust lookalike messages, names or arbitrary cleanup causes", () => {
    const lookalike = new Error(`Multiple projects match this repository (private-token); specify --project <id>.`);
    lookalike.name = "ProjectDiscoveryError";
    for (const cause of [lookalike, new Error("Project does not exist. private-config-token"), new AggregateError([lookalike, new Error("private-cleanup")], "private-aggregate")]) {
      const error = new StepReadCommandError(cause, "list", "prepare", undefined, taskId);
      expect(formatError(error)).toContain("Could not prepare the Steps read."); expect(formatError(error)).not.toContain("private-");
      expect(error.cause).toBe(cause);
    }
  });

  it("keeps usage2 and explicit-project success0 without discovery or extra GET", async () => {
    const f = await fixture(2);
    expect(await runCli(["task", "step", "show", taskId, "bad"], f.context, f.registry)).toBe(2);
    expect(f.fetch).not.toHaveBeenCalled(); expect(f.context.workingDirectory).not.toHaveBeenCalled();
    f.fetch.mockResolvedValue(new Response(stringifyApiJson({ projectId, taskId, version: 1n, steps: [] }), { headers: { "Content-Type": "application/json", "Daynight-User-ID": unrelatedId } }));
    expect(await runCli(["task", "step", "list", taskId, `--project=${projectId}`], f.context, f.registry)).toBe(0);
    expect(f.fetch).toHaveBeenCalledOnce(); expect(String(f.fetch.mock.calls[0]![0])).toBe(`${serverUrl}/api/v1/projects/${projectId}/tasks/${taskId}/steps`);
    expect(f.context.workingDirectory).not.toHaveBeenCalled();
  });

  it("rejects invalid facts rather than marking arbitrary IDs as trusted candidates", () => {
    for (const ids of [[projectId], [projectId, projectId], [projectId, "private\n\u001b[31m"], [projectId, projectId.toUpperCase()]]) expect(() => new ProjectDiscoveryError(ids)).toThrow();
  });
});
