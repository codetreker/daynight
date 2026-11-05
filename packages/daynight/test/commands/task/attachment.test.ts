import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOperation } from "../../../src/api/operation.js";
import type { ApiClient } from "../../../src/api/client.js";
import type { Operation } from "../../../src/api/operation.js";
import type { Project, TaskAttachment } from "../../../src/api/types.js";
import { UsageError } from "../../../src/cli/context.js";
import { runTaskCommand } from "../../../src/commands/task/command.js";
import type { TaskCommandDependencies } from "../../../src/commands/task/command.js";

const projectId = "abcdefab-1111-4222-8333-123456789abc";
const taskId = "abcdefab-2222-4222-8333-123456789abc";
const time = "2026-10-21T00:00:00.123456789Z";
const project: Project = { id: projectId, name: "Project", repoUrl: "git@git.example:Org/Repo.git", settings: { version: 1n, executionWarningMinutes: 60 }, ownership: { teamId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", version: 1n }, createdAt: time, updatedAt: time };
const attachment = (partial: Partial<TaskAttachment> = {}): TaskAttachment => ({ path: "docs/中文%?#.md", contentType: "text/markdown", sizeBytes: 3, createdAt: time, updatedAt: time, ...partial });
const operations: Operation[] = [];
const directories: string[] = [];
afterEach(async () => { operations.splice(0).forEach((operation) => operation.dispose()); await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

const fixture = () => {
  const operation = createOperation();
  operations.push(operation);
  const api = {
    getProject: vi.fn<ApiClient["getProject"]>().mockResolvedValue(project),
    putTaskAttachment: vi.fn<ApiClient["putTaskAttachment"]>().mockResolvedValue(attachment()),
    listTaskAttachments: vi.fn<ApiClient["listTaskAttachments"]>().mockResolvedValue([attachment()]),
    readTaskAttachment: vi.fn<ApiClient["readTaskAttachment"]>().mockResolvedValue(),
    removeTaskAttachment: vi.fn<ApiClient["removeTaskAttachment"]>().mockResolvedValue(),
  };
  const context = { version: "0.0.0", packageDirectory: "unused", homeDirectory: vi.fn(() => { throw new Error("Unexpected config access"); }), workingDirectory: vi.fn(() => path.resolve("caller")), stdout: vi.fn<(value: string) => void>(), stdoutBytes: vi.fn(async (_chunk: Uint8Array, _signal: AbortSignal) => {}), stderr: vi.fn<(value: string) => void>() };
  const dependencies = {
    resolveProject: vi.fn<TaskCommandDependencies["resolveProject"]>().mockResolvedValue(project),
    runServerCommand: vi.fn<TaskCommandDependencies["runServerCommand"]>(async (current, command) => {
      const result = await command({ api: api as unknown as ApiClient, operation, serverUrl: "http://localhost:8787", serverConfiguration: { serverUrl: "http://localhost:8787" } });
      operation.check();
      if (typeof result === "string") current.stdout(result); else if (result !== undefined) current.stdout(result.output);
    }),
  };
  return { api, context, dependencies, operation };
};

const source = async (name: string, bytes: Uint8Array = Buffer.from([0, 255, 128])) => {
  const temporary = fileURLToPath(new URL("../../../../../.tmp/", import.meta.url));
  await mkdir(temporary, { recursive: true });
  const directory = await mkdtemp(path.join(temporary, "attachment-command-"));
  directories.push(directory);
  const file = path.join(directory, name);
  await writeFile(file, bytes);
  return { file, directory };
};

describe("task attachment command boundaries", () => {
  it.each([
    ["list", "invalid"], ["list", taskId, "--project", "invalid"], ["list", taskId, "--tree", "--json"],
    ...["/absolute", "a//b", "a/../b", "a/./b", "a\\b", "a\nb", "C:/absolute", "\ud800"].flatMap((value) => [["read", taskId, value], ["remove", taskId, value], ["put", taskId, "missing", "--path", value]]),
  ].map((args) => ({ args })))("rejects invalid IDs and paths before local source or runtime access: $args", async ({ args }) => {
    const f = fixture();
    await expect(runTaskCommand(["attachment", ...args], f.context, f.dependencies)).rejects.toBeInstanceOf(UsageError);
    expect(f.dependencies.runServerCommand).not.toHaveBeenCalled();
    expect(f.dependencies.resolveProject).not.toHaveBeenCalled();
    expect(f.context.homeDirectory).not.toHaveBeenCalled();
    expect(f.context.workingDirectory).not.toHaveBeenCalled();
    expect(f.context.stdout).not.toHaveBeenCalled();
  });

  it("rejects a directory before preparing the server operation", async () => {
    const f = fixture();
    const { directory } = await source("source.txt");
    await expect(runTaskCommand(["attachment", "put", taskId, directory], f.context, f.dependencies)).rejects.toThrow("Attachment source must be a regular file.");
    expect(f.dependencies.runServerCommand).not.toHaveBeenCalled();
  });

  it.each(["list", "read", "remove"])("uses an explicit canonical project for %s", async (name) => {
    const f = fixture();
    f.context.workingDirectory.mockImplementation(() => { throw new Error("Unexpected cwd access"); });
    await runTaskCommand(["attachment", name, taskId.toUpperCase(), ...(name === "list" ? [] : ["docs/中文%?#.md"]), "--project", projectId.toUpperCase()], f.context, f.dependencies);
    expect(f.api.getProject).toHaveBeenCalledExactlyOnceWith(projectId);
    expect(f.dependencies.resolveProject).not.toHaveBeenCalled();
    expect(f.context.workingDirectory).not.toHaveBeenCalled();
  });

  it("reuses repository project resolution and keeps attachment list separate from task list", async () => {
    const f = fixture();
    await runTaskCommand(["attachment", "list", taskId], f.context, f.dependencies);
    expect(f.dependencies.resolveProject).toHaveBeenCalledExactlyOnceWith({ serverUrl: "http://localhost:8787", operation: f.operation, api: f.api, workingDirectory: path.resolve("caller") });
    expect(f.api.listTaskAttachments).toHaveBeenCalledExactlyOnceWith(projectId, taskId);
    expect(f.context.stdout.mock.calls[0]![0]).toContain("Path: docs/中文%?#.md");
  });
});

describe("task attachment content and presentation", () => {
  it.each([{ name: "original.bin", target: "renamed.html", type: "text/html" }, { name: "unknown.unregistered-extension", target: undefined, type: "application/octet-stream" }, { name: "source.md", target: undefined, type: "text/markdown" }])("infers MIME from the target and streams a real source: $name", async ({ name, target, type }) => {
    const f = fixture();
    const { file } = await source(name);
    let body: Buffer | undefined;
    f.api.putTaskAttachment.mockImplementation(async (_projectId, _taskId, _path, input) => {
      const chunks: Uint8Array[] = [];
      for await (const chunk of input.body) chunks.push(chunk);
      body = Buffer.concat(chunks);
      return attachment();
    });
    await runTaskCommand(["attachment", "put", taskId, file, ...(target === undefined ? [] : ["--path", target]), "--project", projectId], f.context, f.dependencies);
    expect(f.api.putTaskAttachment).toHaveBeenCalledWith(projectId, taskId, target ?? name, expect.objectContaining({ contentType: type }));
    expect(body).toEqual(Buffer.from([0, 255, 128]));
    expect(f.context.stdout.mock.calls[0]![0]).toContain("Attachment uploaded.");
  });

  it("prints complete original metadata JSON and a deterministic path tree", async () => {
    const f = fixture();
    const items = [attachment({ path: "z.bin" }), attachment({ path: "docs/中文.md" }), attachment({ path: "docs/a.md" })];
    f.api.listTaskAttachments.mockResolvedValue(items);
    await runTaskCommand(["attachment", "list", taskId, "--json", "--project", projectId], f.context, f.dependencies);
    expect(JSON.parse(f.context.stdout.mock.calls[0]![0])).toEqual(items);
    await runTaskCommand(["attachment", "list", taskId, "--tree", "--project", projectId], f.context, f.dependencies);
    expect(f.context.stdout.mock.calls[1]![0]).toBe("├── docs/\n│   ├── a.md\n│   └── 中文.md\n└── z.bin\n");
    f.api.listTaskAttachments.mockResolvedValue([]);
    await runTaskCommand(["attachment", "list", taskId, "--project", projectId], f.context, f.dependencies);
    expect(f.context.stdout.mock.calls[2]![0]).toBe("No attachments.\n");
  });

  it("sends dash-prefixed paths through the binary sink without text output", async () => {
    const f = fixture();
    const bytes = new Uint8Array([0, 255, 128, 10]);
    f.api.readTaskAttachment.mockImplementation(async (_projectId, _taskId, _path, consume) => { await consume(bytes, f.operation.signal); });
    await runTaskCommand(["attachment", "read", taskId, "--project", projectId, "--", "-draft.md"], f.context, f.dependencies);
    expect(f.api.readTaskAttachment).toHaveBeenCalledWith(projectId, taskId, "-draft.md", expect.any(Function));
    expect(f.context.stdoutBytes).toHaveBeenCalledExactlyOnceWith(bytes, f.operation.signal);
    expect(f.context.stdout).not.toHaveBeenCalled();
  });

  it("propagates a binary sink failure with the original error and no success output", async () => {
    const f = fixture();
    const failure = new Error("stdout closed");
    f.context.stdoutBytes.mockRejectedValue(failure);
    f.api.readTaskAttachment.mockImplementation(async (_projectId, _taskId, _path, consume) => { await consume(new Uint8Array([1]), f.operation.signal); });
    await expect(runTaskCommand(["attachment", "read", taskId, "file", "--project", projectId], f.context, f.dependencies)).rejects.toBe(failure);
    expect(f.context.stdout).not.toHaveBeenCalled();
  });
});
