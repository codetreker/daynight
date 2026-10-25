import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { chmod, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import crossSpawn from "cross-spawn";
import { parse } from "yaml";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createInstalledCli, terminateInstalledProcess } from "../fixtures/installed-cli.js";

type Result = { code: number | null; stdout: string; stderr: string };
type Action = { waitFor: string; input: string; write?: { file: string; contents: string } } | { waitFor: string; signal: "SIGTERM" };
let installed: Awaited<ReturnType<typeof createInstalledCli>>;
let sequence = 0;
const remote = "https://github.com/configuration-acceptance/repository.git";
const reviewPrompt = "Review repository (HTTPS or SSH GitHub address): ";
const pathPrompt = "Review clone path (blank for configured default): ";

beforeAll(async () => { installed = await createInstalledCli(); });
afterAll(async () => { await installed?.cleanup(); });

const environment = (home: string): NodeJS.ProcessEnv => {
  const result = { ...process.env };
  for (const name of Object.keys(result)) if (/^(?:GIT_|GH_|GITHUB_|COPILOT_|NODE_OPTIONS$|DAYNIGHT_)/i.test(name)) delete result[name];
  return { ...result, HOME: home, USERPROFILE: home, NO_COLOR: "1" };
};
const fresh = async (): Promise<{ root: string; home: string; configuration: string }> => {
  const root = path.join(installed.receipt.root, `review configuration ${sequence++}`);
  const home = path.join(root, "home 中文");
  await mkdir(home, { recursive: true });
  return { root, home, configuration: path.join(home, ".daynight/config.yml") };
};
const capture = async (child: ChildProcess, input?: string): Promise<Result> => {
  let stdout = "", stderr = "";
  child.stdout!.setEncoding("utf8").on("data", (value: string) => { stdout += value; });
  child.stderr!.setEncoding("utf8").on("data", (value: string) => { stderr += value; });
  if (input !== undefined) child.stdin!.end(input);
  let launchFailure: Error | undefined;
  child.once("error", (cause) => { launchFailure = cause; });
  const closed = new Promise<number | null>((resolve) => child.once("close", resolve));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const code = await Promise.race([closed, new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), 15_000); })]);
    if (code === "timeout") { await terminateInstalledProcess(child, closed); throw new Error(`Configuration command exceeded fifteen seconds: ${stderr}`); }
    if (launchFailure !== undefined) throw launchFailure;
    return { code, stdout, stderr };
  } finally { if (timer !== undefined) clearTimeout(timer); }
};
const pipe = (args: string[], home: string, cwd = home, input?: string): Promise<Result> => capture(crossSpawn(installed.receipt.launcherPath, args, {
  cwd, env: environment(home), windowsHide: true, detached: process.platform !== "win32", stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
}), input);
const terminal = async (args: string[], home: string, actions: Action[], extraEnvironment: NodeJS.ProcessEnv = {}, stderrTerminal = true): Promise<Result> => {
  const result = await capture(spawn("python3", ["-u", path.join(import.meta.dirname, "review-configuration-pty.py")], {
    cwd: home, detached: true, stdio: ["pipe", "pipe", "pipe"],
  }), JSON.stringify({ command: [installed.receipt.launcherPath, ...args], cwd: home, environment: { ...environment(home), ...extraEnvironment }, actions, stderrTerminal }));
  expect(result.code, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as Result;
};
const decoded = async (file: string): Promise<Record<string, unknown>> => parse(await readFile(file, "utf8")) as Record<string, unknown>;

it("uses direct production login guidance and rejects the removed top-level setup without creating configuration", async () => {
  const fixture = await fresh();
  const missing = await pipe(["project", "list", "--json"], fixture.home);
  expect(missing.code).toBe(1);
  expect(missing.stdout).toBe("");
  expect(missing.stderr).toContain("daynight login");
  expect(missing.stderr).not.toContain("daynight setup");
  const help = await pipe(["--help"], fixture.home);
  expect(help.code, help.stderr).toBe(0);
  expect(help.stdout).not.toMatch(/^  setup\s/m);
  expect(help.stdout).toMatch(/^  login\s/m);
  for (const args of [["setup"], ["setup", "--help"], ["setup", "--server-url", "https://example.test"]]) {
    const removed = await pipe(args, fixture.home);
    expect(removed.code).toBe(2);
    expect(removed.stdout).toBe("");
    expect(removed.stderr).toContain('Unknown command "setup"');
  }
  const completion = await pipe(["completion", "setup", "--help"], fixture.home);
  expect(completion.code, completion.stderr).toBe(0);
  expect(completion.stdout).toContain("--rc-file");
  expect(await readdir(fixture.home)).toEqual([]);
});

it("configures review through add-repo and preserves controlled service configuration", async () => {
  const fixture = await fresh();
  await mkdir(path.dirname(fixture.configuration));
  await writeFile(fixture.configuration, "serverUrl: http://127.0.0.1:8787\nserverToken: configured-secret\n", { mode: 0o600 });
  const review = await pipe(["review", "add-repo", remote, "--path", path.join(fixture.root, "review clone")], fixture.home);
  expect(review.code, review.stderr).toBe(0);
  expect(review.stdout).toContain("Repository github.com/configuration-acceptance/repository added.");
  expect(review.stdout + review.stderr).not.toContain("configured-secret");
  expect(await decoded(fixture.configuration)).toMatchObject({ serverUrl: "http://127.0.0.1:8787", serverToken: "configured-secret", repositories: [{ remote, path: path.join(fixture.root, "review clone") }] });
  const reviewOnly = await fresh();
  const explicitReview = await pipe(["review", "add-repo", remote], reviewOnly.home);
  expect(explicitReview.code, explicitReview.stderr).toBe(0);
  expect(await decoded(reviewOnly.configuration)).not.toHaveProperty("serverUrl");
  expect(await decoded(reviewOnly.configuration)).not.toHaveProperty("serverToken");
  const invalid = await fresh();
  const rejected = await pipe(["review", "list"], invalid.home);
  expect(rejected.code).toBe(1);
  expect(rejected.stderr).toContain("daynight review add-repo <remote>");
  expect(rejected.stderr).not.toContain("daynight setup");
  expect(await readdir(invalid.home)).toEqual([]);
});

it.skipIf(process.platform === "win32")("first review use configures repositories and leaves saved credentials private", async () => {
  const fixture = await fresh();
  await mkdir(path.dirname(fixture.configuration));
  const secret = "existing-secret";
  await writeFile(fixture.configuration, `# existing credential\nserverToken: ${secret}\n`, { mode: 0o640 });
  const result = await terminal(["review", "list"], fixture.home, [
    { waitFor: reviewPrompt, input: `${remote}\n` },
    { waitFor: pathPrompt, input: "\n" },
  ]);
  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout).toContain("github.com/configuration-acceptance/repository");
  expect(result.stderr).not.toContain("Server URL");
  expect(result.stderr).not.toContain("Server token");
  expect(result.stdout + result.stderr).not.toContain(secret);
  expect(await decoded(fixture.configuration)).toMatchObject({ serverToken: secret, repositories: [{ remote }] });
  expect(await decoded(fixture.configuration)).not.toHaveProperty("serverUrl");
  expect((await stat(fixture.configuration)).mode & 0o777).toBe(0o600);
});

it.skipIf(process.platform === "win32")("cancelling first review configuration preserves the full existing configuration", async () => {
  const fixture = await fresh();
  await mkdir(path.dirname(fixture.configuration));
  const original = "# unchanged\nserverToken: existing-credential\n";
  await writeFile(fixture.configuration, original);
  const result = await terminal(["review", "list"], fixture.home, [
    { waitFor: reviewPrompt, input: `${remote}\n` },
    { waitFor: pathPrompt, signal: "SIGTERM" },
  ]);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("Review configuration cancelled");
  expect(await readFile(fixture.configuration, "utf8")).toBe(original);
  expect(await readdir(path.dirname(fixture.configuration))).toEqual(["config.yml"]);
});

it.skipIf(process.platform === "win32")("first review configuration rejects a concurrent repository change without overwriting it", async () => {
  const fixture = await fresh();
  await mkdir(path.dirname(fixture.configuration));
  await writeFile(fixture.configuration, "serverToken: existing-credential\n");
  const concurrent = JSON.stringify({ serverToken: "existing-credential", repositories: [{ remote: "https://github.com/Concurrent/Repository.git", path: path.join(fixture.root, "concurrent clone") }] });
  const result = await terminal(["review", "list"], fixture.home, [
    { waitFor: reviewPrompt, input: `${remote}\n` },
    { waitFor: pathPrompt, write: { file: fixture.configuration, contents: concurrent }, input: "\n" },
  ]);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("Review configuration changed while prompting");
  expect(result.stdout).toBe("");
  expect(await readFile(fixture.configuration, "utf8")).toBe(concurrent);
  expect(await readdir(path.dirname(fixture.configuration))).toEqual(["config.yml"]);
});

it("reads an automation credential from a controlled configuration file without exposing it", async () => {
  const fixture = await fresh();
  const secret = "configured-automation-credential";
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.headers.authorization!);
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ items: [], nextCursor: null }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Missing configured-service listener.");
  await mkdir(path.dirname(fixture.configuration));
  await writeFile(fixture.configuration, `serverUrl: http://127.0.0.1:${address.port}\nserverToken: ${secret}\n`, { mode: 0o600 });
  try {
    const result = await pipe(["project", "list", "--json"], fixture.home);
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([]);
    expect(result.stdout + result.stderr).not.toContain(secret);
    expect(requests).toEqual([`Bearer ${secret}`]);
    const original = await readFile(fixture.configuration, "utf8");
    if (process.platform !== "win32") {
      await chmod(fixture.configuration, 0o640);
      const review = await pipe(["review", "add-repo", remote], fixture.home);
      expect(review.code, review.stderr).toBe(0);
      expect((await stat(fixture.configuration)).mode & 0o777).toBe(0o600);
      expect(await decoded(fixture.configuration)).toMatchObject(parse(original));
    }
    for (const source of ["serverUrl: [\n", "serverUrl: http://remote.example\nserverToken: configured-automation-credential\n", "serverToken: invalid token\n"]) {
      await writeFile(fixture.configuration, source);
      const rejected = await pipe(["project", "list", "--json"], fixture.home);
      expect(rejected.code).toBe(1);
      expect(rejected.stdout).toBe("");
      expect(rejected.stderr).not.toContain(secret);
      expect(await readFile(fixture.configuration, "utf8")).toBe(source);
    }
    expect(requests).toHaveLength(1);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((cause) => cause === undefined ? resolve() : reject(cause)));
  }
});
