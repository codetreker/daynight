import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveWorkerPaths } from "../../../src/commands/worker/paths.js";
import { createWorkerRepositoryAdmission } from "../../../src/commands/worker/repository-admission.js";
import { openWorkerStore } from "../../../src/commands/worker/store.js";
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
  const store = openWorkerStore(paths.databaseFile, { onMigration: () => {} });
  stores.push(store);
  const admission = createWorkerRepositoryAdmission({ paths, store: () => store });
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
