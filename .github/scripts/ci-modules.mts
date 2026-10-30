import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";

type Module = "cli" | "server" | "web";
export type ModuleSelection = Record<Module, boolean>;

const allModules: ModuleSelection = { cli: true, server: true, web: true };
const sharedInputs = new Set(["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", ".npmrc"]);
const webPatches = new Set([
  "patches/@dagrejs__dagre@3.1.1.patch",
  "patches/@xyflow__system@0.0.83.patch",
]);

export const selectModules = (paths: readonly string[]): ModuleSelection => {
  const selected = { cli: false, server: false, web: false };
  for (const path of paths) {
    if (sharedInputs.has(path)) return { ...allModules };
    if (path === "packages/daynight/test/fixtures/installed-cli.ts") return { ...allModules };
    if (path.startsWith("packages/daynight/src/")) {
      selected.cli = true;
      continue;
    }
    if (
      path.startsWith("docs/") || path.startsWith(".agents/") || path.startsWith(".claude/") ||
      /(^|\/)(README|AGENTS|CLAUDE)\.md$/.test(path) || path === ".gitignore" ||
      path === ".github/workflows/publish.yml"
    ) continue;
    if (path.startsWith("packages/daynight/")) selected.cli = true;
    else if (path.startsWith("packages/daynight-server/")) selected.server = true;
    else if (path.startsWith("packages/daynight-web/") || path.startsWith("deployment/") || webPatches.has(path)) selected.web = true;
    else return { ...allModules };
  }
  return selected;
};

const git = (cwd: string, args: readonly string[]): Promise<string> => new Promise((resolve, reject) => {
  const child = spawn("git", ["-C", cwd, ...args], { stdio: ["ignore", "pipe", "pipe"] });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  child.on("error", reject);
  child.on("close", (code) => {
    if (code !== 0) reject(new Error(`git ${args[0]} failed (${code}): ${Buffer.concat(stderr).toString("utf8")}`));
    else resolve(Buffer.concat(stdout).toString("utf8"));
  });
});

export const pullRequestPaths = async (cwd: string, base: string | undefined, head: string | undefined): Promise<string[]> => {
  const verifyCommit = async (sha: string | undefined): Promise<string> => {
    if (typeof sha !== "string" || !/^[0-9a-f]{40}$/i.test(sha) || /^0+$/.test(sha)) {
      throw new Error("PR change detection requires existing full 40-character base and head commit SHAs.");
    }
    if ((await git(cwd, ["cat-file", "-t", sha])).trim() !== "commit") throw new Error(`Expected a commit: ${sha}.`);
    return sha;
  };
  const baseCommit = await verifyCommit(base);
  const headCommit = await verifyCommit(head);
  const comparisonBase = (await git(cwd, ["merge-base", baseCommit, headCommit])).trim();
  // Both sides of a rename must retain their module ownership, including moves into documentation.
  const changed = await git(cwd, ["diff", "--name-only", "-z", "--no-renames", comparisonBase, headCommit, "--"]);
  if (changed === "") return [];
  if (!changed.endsWith("\0")) throw new Error("Git returned an incomplete NUL-delimited path list.");
  return changed.slice(0, -1).split("\0");
};

export const detectModules = async ({ event, base, head, cwd }: { event: string | undefined; base?: string | undefined; head?: string | undefined; cwd?: string }): Promise<ModuleSelection> => {
  if (event === "push") return { ...allModules };
  if (event !== "pull_request") throw new Error(`Unsupported CI event: ${event}.`);
  if (cwd === undefined) throw new Error("PR change detection requires a repository directory.");
  return selectModules(await pullRequestPaths(cwd, base, head));
};

if (import.meta.main) {
  const selected = await detectModules({ event: process.env.MODULE_EVENT, base: process.env.MODULE_BASE, head: process.env.MODULE_HEAD, cwd: process.cwd() });
  if (process.env.GITHUB_OUTPUT === undefined) throw new Error("Change detection requires GITHUB_OUTPUT.");
  appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(selected).map(([module, value]) => `${module}=${value}\n`).join(""));
  console.log(`Selected modules: ${JSON.stringify(selected)}`);
}
