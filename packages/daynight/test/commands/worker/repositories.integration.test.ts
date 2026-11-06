import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Project } from "../../../src/api/types.js";
import { readWorkerConfiguration } from "../../../src/commands/worker/config.js";
import { resolveWorkerPaths } from "../../../src/commands/worker/paths.js";
import { openWorkerStore } from "../../../src/commands/worker/store.js";
import { changeWorkerRepositories, readWorkerRepositorySnapshot } from "../../../src/commands/worker/repositories.js";

const uuid = (number: number): string => `00000000-0000-4000-8000-${number.toString().padStart(12, "0")}`;
const token = "dn_pat_abcdefghijklmnopqrstuvwxyz1234567890";
const connection = `serverUrl: https://service.example\nserverToken: ${token}\n`;
const project = (number = 1, repoUrl = "https://github.com/owner/repository.git"): Project => ({
  id: uuid(number), name: `Project ${number}`, repoUrl,
  settings: { version: 1n, executionWarningMinutes: 60 }, ownership: { teamId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", version: 1n }, createdAt: "2026-10-27T00:00:00Z", updatedAt: "2026-10-27T00:00:00Z",
});
const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});
const fixture = async (source: string | undefined = connection) => {
  const temporary = path.resolve(import.meta.dirname, "../../../../../.tmp/worker-repository-tests");
  await mkdir(temporary, { recursive: true });
  const homeDirectory = await mkdtemp(path.join(temporary, "home-"));
  directories.push(homeDirectory);
  const paths = resolveWorkerPaths(homeDirectory);
  if (source !== undefined) {
    await mkdir(paths.stateDirectory);
    await writeFile(paths.configFile, source);
  }
  const snapshot = await readWorkerRepositorySnapshot(paths);
  return { paths, homeDirectory, snapshot };
};

describe("worker Project registration", () => {
  it.each([true, false])("retains the original transport and active native session across restart with explicitProject=%s", async (explicitProject) => {
    const remote = "git@github.com:owner/repository.git";
    const source = `${connection}worker:\n  repositories:\n    - remote: ${remote} # Keep SSH transport\n      path: ../original\n      agent: codex\n      model: original-model\n${explicitProject ? `      projectId: ${uuid(1)}\n` : ""}`;
    const f = await fixture(source);
    const binding = { projectId: uuid(1), repoUrl: remote, localPath: f.snapshot.configuration.repositories[0]!.path };
    const claim = { projectId: binding.projectId, taskId: uuid(2), claimId: uuid(3) };
    const sessionId = uuid(7);
    await mkdir(f.paths.workerDirectory);
    const original = openWorkerStore(f.paths.databaseFile);
    let originalTask: ReturnType<typeof original.getTask>;
    try {
      original.registerProject(binding);
      original.registerPending({ ...claim, agent: "codex" });
      original.activateTask(claim);
      original.setSessionId(claim, sessionId);
      originalTask = original.getTask(claim);
    } finally { original.close(); }
    await changeWorkerRepositories({ ...f, projects: [project()], addProjectIds: [uuid(1)] });
    const savedSource = await readFile(f.paths.configFile, "utf8");
    if (explicitProject) expect(savedSource).toBe(source);
    else expect(savedSource).toContain(`projectId: ${uuid(1)}`);
    expect(savedSource).toContain(`remote: ${remote} # Keep SSH transport`);
    const saved = (await readWorkerConfiguration(f.paths)).repositories[0]!;
    const reopened = openWorkerStore(f.paths.databaseFile);
    try {
      expect(reopened.registerProject({ projectId: saved.projectId!, repoUrl: saved.remote, localPath: saved.path })).toEqual(binding);
      expect(reopened.getTask(claim)).toEqual(originalTask);
      expect(reopened.getTask(claim)).toMatchObject({ status: "active", agent: "codex", sessionId });
      expect(saved).toMatchObject({ remote, path: binding.localPath, agent: "codex", model: "original-model" });
    } finally { reopened.close(); }
  });
});
