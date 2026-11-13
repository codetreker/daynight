import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";

type Module = "cli" | "server" | "api" | "web" | "e2e";
export type ModuleSelection = Record<Module, boolean>;

const allModules: ModuleSelection = { cli: true, server: true, api: true, web: true, e2e: true };
const nodeInputs = new Set(["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", ".npmrc"]);
const cliManifestPath = "packages/daynight/package.json";
const cliBuildInputs = new Set([
  cliManifestPath,
  "packages/daynight/config.example.yml",
  "packages/daynight/scripts/clean-dist.ts",
  "packages/daynight/scripts/copy-resources.ts",
  "packages/daynight/scripts/package-image-validation.ts",
]);
const webBuildInputs = new Set([
  "packages/daynight-web/package.json",
  "packages/daynight-web/index.html",
  "packages/daynight-web/vite.config.ts",
  "packages/daynight-web/scripts/publish-assets.mts",
]);
const webProductionInput = (path: string): boolean =>
  path.startsWith("packages/daynight-web/src/") || path.startsWith("packages/daynight-web/public/") ||
  webBuildInputs.has(path) || /^packages\/daynight-web\/tsconfig(?:\.[^/]+)?\.json$/.test(path);
const serverBuildInputs = new Set(["packages/daynight-server/go.mod", "packages/daynight-server/go.sum"]);
const serverRuntimeInput = (path: string): boolean =>
  /^(?:packages\/daynight-server\/(?:api|cmd|internal)\/)/.test(path) &&
  !path.endsWith("_test.go") && !path.includes("/testdata/");

export const selectModules = (paths: readonly string[]): ModuleSelection => {
  const selected: ModuleSelection = { cli: false, server: false, api: false, web: false, e2e: false };
  for (const path of paths) {
    if (nodeInputs.has(path)) {
      selected.cli = true;
      selected.web = true;
      selected.api = true;
      selected.e2e = true;
      continue;
    }
    if (path.startsWith("packages/daynight/src/")) {
      selected.cli = true;
      selected.api = true;
      selected.e2e = true;
      continue;
    }
    if (
      path.startsWith("docs/") || path.startsWith(".agents/") || path.startsWith(".claude/") ||
      /(^|\/)(README|AGENTS|CLAUDE)\.md$/.test(path) || path === ".gitignore" ||
      path === ".github/workflows/publish.yml"
    ) continue;
    if (path.startsWith("packages/e2e_tests/")) selected.e2e = true;
    else if (path.startsWith("patches/")) {
      selected.cli = true;
      selected.web = true;
      selected.api = true;
      selected.e2e = true;
    } else if (path.startsWith("packages/daynight/")) {
      selected.cli = true;
      const buildInput = cliBuildInputs.has(path) || /^packages\/daynight\/tsconfig(?:\.[^/]+)?\.json$/.test(path);
      selected.api ||= buildInput;
      selected.e2e ||= buildInput;
    } else if (path.startsWith("scripts/")) selected.cli = true;
    else if (path.startsWith("packages/daynight-server/")) {
      selected.server = true;
      selected.api = true;
      selected.e2e ||= serverBuildInputs.has(path) || serverRuntimeInput(path);
    } else if (path.startsWith("packages/daynight-web/")) {
      selected.web = true;
      selected.api ||= webProductionInput(path);
      selected.e2e ||= webProductionInput(path);
    } else if (path.startsWith("deployment/")) selected.web = true;
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

const pullRequestDiff = async (cwd: string, base: string | undefined, head: string | undefined) => {
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
  const changed = await git(cwd, ["diff", "--name-status", "-z", "--no-renames", comparisonBase, headCommit, "--"]);
  if (changed !== "" && !changed.endsWith("\0")) throw new Error("Git returned an incomplete NUL-delimited change list.");
  const fields = changed === "" ? [] : changed.slice(0, -1).split("\0");
  if (fields.length % 2 !== 0) throw new Error("Git returned an incomplete status/path pair.");
  const changes = fields.filter((_, index) => index % 2 === 0).map((status, index) => ({ status, path: fields[index * 2 + 1]! }));
  return { changes, comparisonBase, head: headCommit };
};

export const pullRequestPaths = async (cwd: string, base: string | undefined, head: string | undefined): Promise<string[]> =>
  (await pullRequestDiff(cwd, base, head)).changes.map(({ path }) => path);

const parseManifest = (source: string): { version: string; inputs: Record<string, unknown> } => {
  const manifest: unknown = JSON.parse(source);
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest) ||
    !("version" in manifest) || typeof manifest.version !== "string") {
    throw new Error("CLI package manifest must be a JSON object with a string version.");
  }
  const { version, ...inputs } = manifest;
  return { version, inputs };
};

export const detectModules = async ({ event, base, head, cwd }: { event: string | undefined; base?: string | undefined; head?: string | undefined; cwd?: string }): Promise<ModuleSelection> => {
  if (event === "push") return { ...allModules };
  if (event !== "pull_request") throw new Error(`Unsupported CI event: ${event}.`);
  if (cwd === undefined) throw new Error("PR change detection requires a repository directory.");
  const diff = await pullRequestDiff(cwd, base, head);
  const manifestChange = diff.changes.find(({ path }) => path === cliManifestPath);
  if (manifestChange?.status === "M") {
    const [beforeSource, afterSource, beforeMode, afterMode] = await Promise.all([
      git(cwd, ["show", `${diff.comparisonBase}:${cliManifestPath}`]),
      git(cwd, ["show", `${diff.head}:${cliManifestPath}`]),
      git(cwd, ["ls-tree", "--format=%(objectmode)", diff.comparisonBase, "--", cliManifestPath]),
      git(cwd, ["ls-tree", "--format=%(objectmode)", diff.head, "--", cliManifestPath]),
    ]);
    const regularFile = (mode: string) => mode.trim() === "100644" || mode.trim() === "100755";
    if (regularFile(beforeMode) && regularFile(afterMode)) {
      const before = parseManifest(beforeSource);
      const after = parseManifest(afterSource);
      if (diff.changes.length === 1 && beforeMode === afterMode && isDeepStrictEqual(before.inputs, after.inputs) && before.version !== after.version) {
        return { cli: false, server: false, api: false, web: false, e2e: false };
      }
    }
  }
  return selectModules(diff.changes.map(({ path }) => path));
};

if (import.meta.main) {
  const selected = await detectModules({ event: process.env.MODULE_EVENT, base: process.env.MODULE_BASE, head: process.env.MODULE_HEAD, cwd: process.cwd() });
  if (process.env.GITHUB_OUTPUT === undefined) throw new Error("Change detection requires GITHUB_OUTPUT.");
  appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(selected).map(([module, value]) => `${module}=${value}\n`).join(""));
  console.log(`Selected modules: ${JSON.stringify(selected)}`);
}
