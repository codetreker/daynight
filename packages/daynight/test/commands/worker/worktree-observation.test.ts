import path from "node:path";
import { execFileSync } from "node:child_process";
import { cpSync } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createOperation } from "../../../src/api/operation.js";
import { createWorkerGitManager } from "../../../src/commands/worker/worktrees.js";
import { WorktreeValidationError } from "../../../src/commands/worker/worktree-errors.js";
import { verifyWorktreeSidecar, verifyWorktreeIdentityMetadata } from "../../../src/commands/worker/worktree-identity.js";
import * as identities from "../../../src/platform/directory-identity.js";

// Only the scheduling boundaries are controlled; metadata, handles and Git are real.
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open), readFile: vi.fn(actual.readFile) };
});
const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
const scratch = path.resolve(import.meta.dirname, "../../../../../.tmp/worktree-observation-tests");
const roots: string[] = [];
const managers: ReturnType<typeof createWorkerGitManager>[] = [];
const operations: ReturnType<typeof createOperation>[] = [];
const operation = () => { const op = createOperation(); operations.push(op); return op; };
const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", timeout: 10000, stdio: "pipe" }).trim();
beforeEach(() => {
  vi.mocked(open).mockImplementation(actual.open);
  vi.mocked(readFile).mockImplementation(actual.readFile);
});
afterEach(async () => {
  vi.restoreAllMocks();
  operations.splice(0).forEach(op => op.dispose());
  await Promise.all(managers.splice(0).map(manager => manager.dispose()));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
const fixture = async () => {
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(path.join(scratch, "o-")); roots.push(root);
  const repository = path.join(root, "repo"); await mkdir(repository);
  git(repository, ["init", "--initial-branch=main"]);
  await writeFile(path.join(repository, "content"), "retained"); git(repository, ["add", "content"]);
  git(repository, ["-c", "user.name=Fixture", "-c", "user.email=test@example.test", "commit", "-m", "seed"]);
  git(repository, ["remote", "add", "origin", "https://example.test/repo.git"]);
  const owner = { projectId: "11111111-1111-4111-8111-111111111111", taskId: "22222222-2222-4222-8222-222222222222", claimId: "33333333-3333-4333-8333-333333333333", worktreeId: "44444444-4444-4444-8444-444444444444" };
  git(repository, ["branch", `daynight/${owner.taskId}`]);
  const project = { projectId: owner.projectId, localPath: repository, repoUrl: "https://example.test/repo.git" };
  const manager = createWorkerGitManager({ temporaryDirectory: path.join(root, "temp") }); managers.push(manager);
  const binding = await manager.prepareWorktree(project, owner, operation());
  const admin = git(binding.worktreePath, ["rev-parse", "--absolute-git-dir"]);
  const marker = path.join(admin, "locked"), sidecar = path.join(admin, "daynight-identity.json");
  const original = await actual.readFile(marker, "utf8");
  const other = `daynight-worker:${JSON.stringify({ ...JSON.parse(original.slice("daynight-worker:".length)), worktreeId: "55555555-5555-4555-8555-555555555555" })}\n`;
  return { root, repository, owner, project, manager, binding, admin, marker, sidecar, original, other };
};

it.each(["before-inspection", "confirmation", "same-bytes", "nonfile", "oversized", "opening", "reading", "runtime", "branch-failure", "sidecar-failure"])("keeps observed identity change unknown: %s", async stage => {
  const f = await fixture();
  let changed = false;
  const change = async () => {
    if (changed) return;
    changed = true;
    if (stage === "nonfile") { await rm(f.marker); await mkdir(f.marker); }
    else if (stage === "same-bytes" || stage === "opening" || stage === "reading") {
      await rename(f.marker, `${f.marker}.original`);
      await writeFile(f.marker, stage === "same-bytes" ? f.original : f.other);
    } else await writeFile(f.marker, stage === "oversized" ? "x".repeat(32769) : f.other);
  };
  if (stage === "branch-failure") git(f.binding.worktreePath, ["checkout", "-b", "changed-branch"]);
  if (stage === "sidecar-failure") await writeFile(f.sidecar, "{", { mode: 0o600 });
  if (stage === "opening" || stage === "reading") {
    vi.mocked(open).mockImplementation(async (...args) => {
      if (String(args[0]) === f.marker && stage === "opening") await change();
      const handle = await actual.open(...args);
      if (String(args[0]) === f.marker && stage === "reading") {
        const stat = handle.stat.bind(handle); let calls = 0;
        vi.spyOn(handle, "stat").mockImplementation((async options => {
          if (++calls === 2) await change();
          return stat(options);
        }) as typeof handle.stat);
      }
      return handle;
    });
  } else if (stage === "branch-failure") {
    vi.mocked(readFile).mockImplementation((async (...args: Parameters<typeof actual.readFile>) => {
      const value = await actual.readFile(...args);
      if (String(args[0]) === path.join(f.binding.worktreePath, ".git")) await change();
      return value;
    }) as typeof readFile);
  } else {
    const native = identities.openDirectoryIdentity;
    vi.spyOn(identities, "openDirectoryIdentity").mockImplementation(async target => {
      if (stage === "runtime" && target === f.binding.worktreePath && !changed) {
        changed = true; const retained = path.join(f.root, "retained-leaf");
        await rename(target, retained); cpSync(retained, target, { recursive: true });
      }
      const lease = await native(target);
      if (target === f.repository) {
        if (stage === "confirmation" || stage === "same-bytes") return { ...lease, verifyPath: async () => { await lease.verifyPath(); await change(); } };
        if (stage !== "runtime" && stage !== "sidecar-failure") await change();
      }
      return lease;
    });
    if (stage === "sidecar-failure") vi.mocked(open).mockImplementation(async (...args) => {
      const handle = await actual.open(...args);
      if (String(args[0]) === f.marker) {
        const close = handle.close.bind(handle);
        vi.spyOn(handle, "close").mockImplementation(async () => { await close(); await change(); });
      }
      return handle;
    });
  }
  const scan = await f.manager.scanWorktrees(f.project, operation());
  expect(changed).toBe(true);
  expect(scan.unknown.length).toBeGreaterThan(0);
  expect(scan.quarantined).toEqual([]);
  expect(scan.validated).toEqual([]);
  expect(await actual.readFile(path.join(f.binding.worktreePath, "content"), "utf8")).toBe("retained");
  if (stage !== "nonfile" && stage !== "oversized" && stage !== "runtime") expect(await actual.readFile(f.marker, "utf8")).toBe(stage === "same-bytes" ? f.original : f.other);
});

it.each(["reverse", "common", "missing-pointer", "missing-leaf"])("keeps a second Git observation conflict unknown: %s", async kind => {
  const f = await fixture();
  const foreign = path.join(f.root, "foreign"); git(f.root, ["clone", "--no-hardlinks", f.repository, foreign]);
  const pointer = path.join(f.binding.worktreePath, ".git"); let changed = false;
  vi.mocked(readFile).mockImplementation((async (...args: Parameters<typeof actual.readFile>) => {
    const value = await actual.readFile(...args);
    if (String(args[0]) === pointer && !changed) {
      changed = true;
      if (kind === "common") await writeFile(path.join(f.admin, "commondir"), `${path.join(foreign, ".git").split(path.sep).join("/")}\n`);
      else if (kind === "missing-leaf") await rm(f.binding.worktreePath, { recursive: true });
      else {
        await rm(pointer);
        if (kind === "reverse") await writeFile(pointer, `gitdir: ${path.join(foreign, ".git").split(path.sep).join("/")}\n`);
      }
    }
    return value;
  }) as typeof readFile);
  const scan = await f.manager.scanWorktrees(f.project, operation());
  expect(changed).toBe(true);
  expect(scan.unknown.length).toBeGreaterThan(0);
  expect(scan.quarantined).toEqual([]);
  expect(await actual.readFile(f.marker, "utf8")).toBe(f.original);
});

it.each(["marker", "sidecar-private", "sidecar-nonfile"])("keeps operation recheck failures outside local validation: %s", async kind => {
  const f = await fixture();
  if (kind === "marker") {
    const entry = await lstat(f.marker, { bigint: true });
    const expected = { bytes: Buffer.from(f.original), dev: entry.dev, ino: entry.ino };
    await writeFile(f.marker, f.other);
    await expect(verifyWorktreeIdentityMetadata(f.admin, { marker: expected, sidecar: null, candidate: null })).rejects.not.toBeInstanceOf(WorktreeValidationError);
  } else {
    await rm(f.sidecar, { force: true });
    if (kind === "sidecar-nonfile") await mkdir(f.sidecar);
    else await writeFile(f.sidecar, "{}", { mode: 0o644 });
    await expect(verifyWorktreeSidecar(f.admin, null)).rejects.not.toBeInstanceOf(WorktreeValidationError);
  }
});

it.each(["branch", "historical", "sidecar", "missing-pointer"])("keeps stable resource-local damage quarantined: %s", async kind => {
  const f = await fixture();
  if (kind === "branch") git(f.binding.worktreePath, ["checkout", "-b", "changed-branch"]);
  else if (kind === "sidecar") await writeFile(f.sidecar, "{", { mode: 0o600 });
  else if (kind === "missing-pointer") await rm(path.join(f.binding.worktreePath, ".git"));
  else {
    await rm(f.sidecar, { force: true });
    const marker = JSON.parse(f.original.slice("daynight-worker:".length));
    await writeFile(f.marker, `daynight-worker:${JSON.stringify({ ...marker, leaf: "0:1" })}\n`);
  }
  const scan = await f.manager.scanWorktrees(f.project, operation());
  expect(scan.unknown).toEqual([]);
  expect(scan.quarantined).toEqual([{ owner: f.owner, error: expect.any(WorktreeValidationError) }]);
  expect(scan.validated).toEqual([]);
  expect(await actual.readFile(path.join(f.binding.worktreePath, "content"), "utf8")).toBe("retained");
});
