import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createOperation } from "../../../src/api/operation.js";
import { runRepositoryGit } from "../../../src/repository/git.js";
import { removeRecoveryGitWorktree, verifyRecoveryGitContent } from "../../../src/commands/worker/resource-recovery-runtime.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const fixture = async () => {
  const base = path.resolve("../../.tmp/resource-recovery-git"); await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, "case-")); roots.push(root);
  const operation = createOperation({ limits: { totalMs: 30_000 } });
  const git = async (cwd: string, args: string[]) => (await runRepositoryGit(cwd, args, operation)).stdout.trim();
  await git(root, ["init", "-b", "main"]);
  await git(root, ["config", "user.name", "Recovery fixture"]); await git(root, ["config", "user.email", "recovery@example.test"]);
  await writeFile(path.join(root, "tracked"), "original\n"); await writeFile(path.join(root, ".gitignore"), "ignored\n");
  await git(root, ["add", "."]); await git(root, ["commit", "-m", "fixture"]);
  const head = await git(root, ["rev-parse", "HEAD"]); await git(root, ["update-ref", "refs/remotes/origin/main", head]);
  const worktree = path.join(root, "worktree"), branch = "daynight/00000000-0000-4000-8000-000000000001";
  await git(root, ["worktree", "add", "-b", branch, worktree]);
  const binding = { repositoryPath: root, commonDirectory: path.join(root, ".git"), worktreePath: worktree, branch };
  return { root, operation, git, binding };
};

describe("safe resource recovery Git boundary", () => {
  it("removes a clean remote-preserved checkout while retaining its named branch", async () => {
    const f = await fixture();
    try {
      await removeRecoveryGitWorktree(f.binding, f.operation);
      await expect(readFile(path.join(f.binding.worktreePath, "tracked"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(await f.git(f.root, ["rev-parse", `refs/heads/${f.binding.branch}`])).toMatch(/^[a-f0-9]{40}$/);
      expect(await readFile(path.join(f.root, "tracked"), "utf8")).toBe("original\n");
    } finally { f.operation.dispose(); }
  });
  it.each(["tracked", "untracked", "ignored", "unpreserved commit"])("keeps all files when %s content needs preservation", async kind => {
    const f = await fixture();
    try {
      const file = kind === "unpreserved commit" ? "tracked" : kind;
      await writeFile(path.join(f.binding.worktreePath, file), "keep\n");
      if (kind === "unpreserved commit") { await f.git(f.binding.worktreePath, ["add", "tracked"]); await f.git(f.binding.worktreePath, ["commit", "-m", "unpreserved"]); }
      await expect(removeRecoveryGitWorktree(f.binding, f.operation)).rejects.toThrow(/files|reference/);
      expect(await readFile(path.join(f.binding.worktreePath, file), "utf8")).toBe("keep\n");
    } finally { f.operation.dispose(); }
  });
  it("rechecks modifications appearing after preview and never forces a locked checkout", async () => {
    const f = await fixture();
    try {
      await verifyRecoveryGitContent(f.binding, f.operation);
      await writeFile(path.join(f.binding.worktreePath, "tracked"), "changed after preview\n");
      await expect(removeRecoveryGitWorktree(f.binding, f.operation)).rejects.toThrow(/files/);
      await f.git(f.binding.worktreePath, ["checkout", "--", "tracked"]);
      await f.git(f.root, ["worktree", "lock", f.binding.worktreePath]);
      await expect(removeRecoveryGitWorktree(f.binding, f.operation)).rejects.toThrow();
      expect(await readFile(path.join(f.binding.worktreePath, "tracked"), "utf8")).toBe("original\n");
    } finally { f.operation.dispose(); }
  });
});
