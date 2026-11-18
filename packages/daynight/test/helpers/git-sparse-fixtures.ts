import path from "node:path";
import { appendFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { expect } from "vitest";
import { commit, createGitTestFixtures, rawGit } from "./git-fixtures.js";
import type { GitFixtureFactory } from "./git-fixtures.js";
import type { GitSnapshotEntry } from "./git-objects.js";

export type SparseMode = { cone: boolean; sparseIndex: boolean; worktreeConfig: boolean };
const sparseExtra = (value: string, added = false): GitSnapshotEntry[] => [
  { path: "hidden.txt", mode: "100644", contents: value },
  { path: "hidden/hidden.txt", mode: "100644", contents: value },
  { path: "visible/visible.txt", mode: "100644", contents: "visible\n" },
  ...(added ? [{ path: "hidden/new.txt", mode: "100644" as const, contents: "new hidden path\n" }] : []),
];
export const createSparseGitTestFixtures = (name: string) => createGitTestFixtures(name, (upstream, initialBase) => {
  const base = commit(upstream, "base sparse\n", initialBase, sparseExtra("base hidden\n"));
  const head = commit(upstream, "PR sparse\n", base, sparseExtra("initial hidden change\n"));
  rawGit(upstream, ["update-ref", "refs/heads/main", base]); rawGit(upstream, ["update-ref", "refs/pull/101/head", head]);
});
export const createSparseFixture = async (fixture: GitFixtureFactory, mode: SparseMode) => {
  const f = fixture();
  const [base, head] = rawGit(f.upstream, ["rev-parse", "refs/heads/main", "refs/pull/101/head"]).split("\n");
  if (base === undefined || head === undefined) throw new Error("Expected sparse source revisions.");
  f.update({ headSha: head, baseSha: base });
  const local = await f.manager.ensureRepository(f.configuration);
  const patterns = mode.cone ? ["visible"] : ["/file.txt", "/.gitattributes", "/visible/"];
  rawGit(local.root, ["sparse-checkout", "set", mode.cone ? "--cone" : "--no-cone", mode.sparseIndex ? "--sparse-index" : "--no-sparse-index", ...patterns]);
  if (!mode.worktreeConfig) {
    appendFileSync(path.join(local.commonDirectory, "config"),
      `\n[core]\n\tsparseCheckout = true\n\tsparseCheckoutCone = ${mode.cone}\n[index]\n\tsparse = ${mode.sparseIndex}\n`);
    rawGit(local.root, ["config", "--local", "extensions.worktreeConfig", "false"]);
  }
  const effective = Object.fromEntries(rawGit(local.root, ["config", "--bool", "--get-regexp",
    "^(core[.]sparsecheckout(cone)?|index[.]sparse|extensions[.]worktreeconfig)$",
  ]).split("\n").map(line => line.split(" ")));
  expect(effective).toMatchObject({
    "core.sparsecheckout": "true", "core.sparsecheckoutcone": String(mode.cone),
    "index.sparse": String(mode.sparseIndex), "extensions.worktreeconfig": String(mode.worktreeConfig),
  });
  if (mode.sparseIndex) expect(rawGit(local.root, ["ls-files", "--sparse", "--stage"]).split("\n").some((entry) => entry.startsWith("040000 "))).toBe(true);
  const snapshot = () => {
    const files: Record<string, Buffer> = {}; const directories: string[] = [];
    const walk = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entry.name === ".git" || entry.name === ".worktrees") continue;
        const target = path.join(directory, entry.name); const relative = path.relative(local.root, target);
        if (entry.isDirectory()) { directories.push(relative); walk(target); }
        else files[relative] = readFileSync(target);
      }
    };
    walk(local.root);
    return { files, directories: directories.sort(), head: readFileSync(path.join(local.commonDirectory, "HEAD")), index: readFileSync(path.join(local.commonDirectory, "index")),
      skipBits: rawGit(local.root, ["ls-files", "--sparse", "-v"]),
      refs: rawGit(local.root, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads", "refs/remotes", "refs/tags"]),
      metadata: Object.fromEntries(["config", "config.worktree", path.join("info", "sparse-checkout")].map((name) => {
        const target = path.join(local.commonDirectory, name); return [name, existsSync(target) ? readFileSync(target) : null];
      })) };
  };
  expect(existsSync(path.join(local.root, "hidden", "hidden.txt"))).toBe(false);
  return { ...f, local, sparseHead: head, sparseExtra, snapshot };
};
