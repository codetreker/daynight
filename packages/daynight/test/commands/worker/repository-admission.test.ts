import { createMemoryDatabase } from "../../helpers/sqlite.js";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveWorkerPaths } from "../../../src/commands/worker/paths.js";
import { createWorkerRepositoryAdmission } from "../../../src/commands/worker/repository-admission.js";
import { openWorkerStore } from "../../../src/commands/worker/store.js";
import { openWebExecutionStore } from "../../../src/commands/worker/backends/web-store.js";
import type { WorkerStore } from "../../../src/commands/worker/store.js";
import type { WorkerProject } from "../../../src/commands/worker/types.js";

const uuid = (number: number): string => `00000000-0000-4000-8000-${number.toString().padStart(12, "0")}`;
const roots: string[] = [];
const stores: WorkerStore[] = [];
const fixture = async () => {
  const temporary = path.resolve(import.meta.dirname, "../../../../../.tmp/worker-repository-admission-tests");
  await mkdir(temporary, { recursive: true });
  const directory = await mkdtemp(path.join(temporary, "repositories-"));
  roots.push(directory);
  vi.stubEnv("DN_CONFIG_DIR", path.join(directory, "state"));
  const paths = resolveWorkerPaths(directory);
  await mkdir(paths.workerDirectory, { recursive: true });
  const store = openWorkerStore(createMemoryDatabase(), { onMigration: () => {} });
  stores.push(store);
  const admission = createWorkerRepositoryAdmission({ paths, store: () => store, workerId: uuid(4), serverOrigin: "https://daynight.example" });
  const project = async (number: number, relative: string): Promise<WorkerProject> => {
    const localPath = path.join(directory, relative);
    await mkdir(localPath, { recursive: true });
    return { projectId: uuid(number), repoUrl: `https://git.example/team/repo-${number}.git`, localPath };
  };
  return { directory, paths, store, admission, project };
};

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const store of stores.splice(0)) store.close();
  await Promise.all(roots.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe("Worker repository admission", () => {
  it("rejects a selected repository nested beneath a retained Project without touching its contents", async () => {
    const f = await fixture();
    const retained = await f.project(1, "retained");
    const candidate = await f.project(2, "retained/.worktrees/daynight/nested");
    const sentinel = path.join(candidate.localPath, "sentinel.txt");
    await writeFile(sentinel, "preserve this repository");
    f.store.registerProject(retained);

    await expect(f.admission.admit(candidate, new AbortController().signal)).rejects.toThrow("overlaps another worker repository");
    expect(f.store.listProjects()).toEqual([retained]);
    expect(f.store.getProject(candidate)).toBeNull();
    expect(await readFile(sentinel, "utf8")).toBe("preserve this repository");
  });

  it("checks physical symlink aliases against all retained mappings", async () => {
    const f = await fixture();
    const retained = await f.project(1, "retained");
    f.store.registerProject(retained);
    const alias = path.join(f.directory, "alias");
    await symlink(retained.localPath, alias, process.platform === "win32" ? "junction" : "dir");
    const candidate: WorkerProject = { projectId: uuid(2), repoUrl: "https://git.example/team/repo-2.git", localPath: path.join(alias, "nested") };
    await mkdir(candidate.localPath);
    const sentinel = path.join(candidate.localPath, "sentinel.txt");
    await writeFile(sentinel, "physical repository content");

    await expect(f.admission.admit(candidate, new AbortController().signal)).rejects.toThrow("physically overlaps another worker repository");
    expect(f.store.getProject(candidate)).toBeNull();
    expect(f.store.listProjects()).toEqual([retained]);
    expect(await readFile(sentinel, "utf8")).toBe("physical repository content");
  });

  it("admits independent sibling directories and returns the persisted bindings", async () => {
    const f = await fixture();
    const first = await f.project(1, "first");
    const second = await f.project(2, "second");
    expect(await f.admission.admit(first, new AbortController().signal)).toEqual(first);
    expect(await f.admission.admit(second, new AbortController().signal)).toEqual(second);
    expect(f.store.listProjects()).toEqual([first, second]);
  });

  it("serializes concurrent first admissions so overlapping candidates cannot both register", async () => {
    const f = await fixture();
    const first = await f.project(1, "first");
    const second = await f.project(2, "first/nested");
    const results = await Promise.allSettled([
      f.admission.admit(first, new AbortController().signal),
      f.admission.admit(second, new AbortController().signal),
    ]);
    expect(results[0]).toEqual({ status: "fulfilled", value: first });
    expect(results[1]).toEqual({ status: "rejected", reason: expect.objectContaining({ message: expect.stringContaining("overlaps another worker repository") }) });
    expect(f.store.listProjects()).toEqual([first]);
  });

  it("continues independent admission after a failed candidate", async () => {
    const f = await fixture();
    const retained = await f.project(1, "retained");
    f.store.registerProject(retained);
    const invalid = await f.project(2, "retained/nested");
    const healthy = await f.project(3, "healthy");
    const [rejected, admitted] = await Promise.allSettled([
      f.admission.admit(invalid, new AbortController().signal),
      f.admission.admit(healthy, new AbortController().signal),
    ]);
    expect(rejected).toEqual({ status: "rejected", reason: expect.any(TypeError) });
    expect(admitted).toEqual({ status: "fulfilled", value: healthy });
    expect(f.store.listProjects()).toEqual([retained, healthy]);
  });

  it("does not register an admission canceled while queued", async () => {
    const f = await fixture();
    const first = await f.project(1, "first");
    const second = await f.project(2, "second");
    const cancellation = new AbortController();
    const reason = new Error("Queued repository preparation canceled.");
    const firstAdmission = f.admission.admit(first, new AbortController().signal);
    const secondAdmission = f.admission.admit(second, cancellation.signal);
    cancellation.abort(reason);
    const [admitted, rejected] = await Promise.allSettled([firstAdmission, secondAdmission]);
    expect(admitted).toEqual({ status: "fulfilled", value: first });
    expect(rejected).toEqual({ status: "rejected", reason });
    expect(f.store.listProjects()).toEqual([first]);
  });

  it("excludes the same canonical Project when re-admitting its unchanged binding", async () => {
    const f = await fixture();
    const binding = { ...await f.project(1, "first"), projectId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" };
    await f.admission.admit(binding, new AbortController().signal);
    expect(await f.admission.admit({ ...binding, projectId: binding.projectId.toUpperCase() }, new AbortController().signal)).toEqual(binding);
    expect(f.store.listProjects()).toEqual([binding]);
  });

  it("revalidates an existing binding against the other retained Projects", async () => {
    const f = await fixture();
    const first = await f.project(1, "first");
    const second = await f.project(2, "first/nested");
    f.store.registerProject(first);
    f.store.registerProject(second);
    await expect(f.admission.admit(first, new AbortController().signal)).rejects.toThrow("overlaps another worker repository");
    expect(f.store.listProjects()).toEqual([first, second]);
  });
});


it("retains a repository binding for its journal-backed Web cleanup even when the task index is absent", async () => {
  const f = await fixture();
  const project = await f.project(1, "original"), replacement = { ...await f.project(1, "replacement"), repoUrl: project.repoUrl };
  f.store.registerProject(project);
  const owner = { projectId: project.projectId, taskId: uuid(2), claimId: uuid(3), worktreeId: uuid(5) };
  const journal = openWebExecutionStore(path.join(f.paths.workerDirectory, "web-executions.sqlite"), { onMigration: () => {} });
  try {
    const task = journal.register({ ...owner, project, serverOrigin: "https://daynight.example", workerId: uuid(4), userId: uuid(6), configuration: { agent: "codex", agentControlMode: "web", model: null, args: [], recoveryLimit: 2 } }, 1);
    expect(f.store.getTask(owner)).toBeNull();
    await expect(f.admission.admit(replacement, new AbortController().signal)).rejects.toThrow("unfinished Web execution");
    const cleanup = journal.beginCleanup(owner, { kind: "terminal", deadline: 100 }, 2);
    const done = journal.completeTask(owner, 3);
    f.store.saveCleanupSchedule(owner, { deadline: 100, failures: 1, nextAttemptAt: 200, stage: "observation", lastError: "retained" }, task);
    await expect(f.admission.admit(replacement, new AbortController().signal)).rejects.toThrow("Outstanding cleanup");
    expect(f.store.getProject(owner)).toEqual(project);
    expect(f.store.getCleanupSchedule(owner)).toBeNull();
    expect(f.store.getCleanupSchedule(owner, done)).toMatchObject({ worktreeId: owner.worktreeId, deadline: cleanup.cleanup!.deadline });
    f.store.deleteCleanupSchedule(owner, done);
    expect(await f.admission.admit(replacement, new AbortController().signal)).toEqual(replacement);
  } finally { journal.close(); }
});

it("does not adopt a Web journal belonging to another Worker when changing a binding", async () => {
  const f = await fixture();
  const project = await f.project(1, "original"), replacement = { ...await f.project(1, "replacement"), repoUrl: project.repoUrl };
  f.store.registerProject(project);
  const owner = { projectId: project.projectId, taskId: uuid(2), claimId: uuid(3), worktreeId: uuid(5) };
  const journal = openWebExecutionStore(path.join(f.paths.workerDirectory, "web-executions.sqlite"), { onMigration: () => {} });
  try {
    const original = journal.register({ ...owner, project, serverOrigin: "https://daynight.example", workerId: uuid(99), userId: uuid(6), configuration: { agent: "codex", agentControlMode: "web", model: null, args: [], recoveryLimit: 2 } }, 1);
    expect(await f.admission.admit(replacement, new AbortController().signal)).toEqual(replacement);
    expect(journal.getTask(owner)).toEqual(original);
  } finally { journal.close(); }
});
