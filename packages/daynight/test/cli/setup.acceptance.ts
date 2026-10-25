import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { chmod, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import crossSpawn from "cross-spawn";
import { parse } from "yaml";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createInstalledCli, terminateInstalledProcess } from "../fixtures/installed-cli.js";

type Result = { code: number | null; stdout: string; stderr: string };
type Action = { waitFor: string; input: string } | { waitFor: string; signal: "SIGTERM" };
let installed: Awaited<ReturnType<typeof createInstalledCli>>;
let sequence = 0;
const remote = "https://github.com/Setup-Acceptance/Repository.git";
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
  const root = path.join(installed.receipt.root, `guided setup ${sequence++}`);
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
    if (code === "timeout") { await terminateInstalledProcess(child, closed); throw new Error(`Setup command exceeded fifteen seconds: ${stderr}`); }
    if (launchFailure !== undefined) throw launchFailure;
    return { code, stdout, stderr };
  } finally { if (timer !== undefined) clearTimeout(timer); }
};
const pipe = (args: string[], home: string, cwd = home, input?: string): Promise<Result> => capture(crossSpawn(installed.receipt.launcherPath, args, {
  cwd, env: environment(home), windowsHide: true, detached: process.platform !== "win32", stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
}), input);
const terminal = async (args: string[], home: string, actions: Action[], extraEnvironment: NodeJS.ProcessEnv = {}, stderrTerminal = true): Promise<Result> => {
  const result = await capture(spawn("python3", ["-u", path.join(import.meta.dirname, "setup-pty.py")], {
    cwd: home, detached: true, stdio: ["pipe", "pipe", "pipe"],
  }), JSON.stringify({ command: [installed.receipt.launcherPath, ...args], cwd: home, environment: { ...environment(home), ...extraEnvironment }, actions, stderrTerminal }));
  expect(result.code, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as Result;
};
const decoded = async (file: string): Promise<Record<string, unknown>> => parse(await readFile(file, "utf8")) as Record<string, unknown>;

it("defaults production access and retains explicit test-server and automation configuration", async () => {
  const first = await fresh();
  const missing = await pipe(["project", "list", "--json"], first.home);
  expect(missing.code).toBe(1);
  expect(missing.stdout).toBe("");
  expect(missing.stderr).toContain("daynight login");
  expect(missing.stderr).not.toContain("daynight setup");
  expect(await readdir(first.home)).toEqual([]);
  expect((await pipe(["setup"], first.home)).code).toBe(1);
  expect(await readdir(first.home)).toEqual([]);
  const setup = await pipe(["setup", "--server-url", "http://127.0.0.1:8787"], first.home);
  expect(setup.code, setup.stderr).toBe(0);
  expect(await decoded(first.configuration)).toEqual({ serverUrl: "http://127.0.0.1:8787" });
  const review = await pipe(["setup", "--review-repo", remote, "--review-path", path.join(first.root, "review clone")], first.home);
  expect(review.code, review.stderr).toBe(0);
  expect(await decoded(first.configuration)).toMatchObject({ serverUrl: "http://127.0.0.1:8787", repositories: [{ remote, path: path.join(first.root, "review clone") }] });
  const reviewOnly = await fresh();
  const explicitReview = await pipe(["setup", "--review-repo", remote], reviewOnly.home);
  expect(explicitReview.code, explicitReview.stderr).toBe(0);
  expect(await decoded(reviewOnly.configuration)).not.toHaveProperty("serverUrl");
  const invalid = await fresh();
  expect((await pipe(["setup", "--review-path", "clone"], invalid.home)).code).not.toBe(0);
  expect(await readdir(invalid.home)).toEqual([]);
});

it.skipIf(process.platform === "win32")("interactive setup configures only review and leaves saved credentials private", async () => {
  const fixture = await fresh();
  await mkdir(path.dirname(fixture.configuration));
  const secret = "existing-secret";
  await writeFile(fixture.configuration, `# existing credential\nserverToken: ${secret}\n`);
  const result = await terminal(["setup"], fixture.home, [
    { waitFor: reviewPrompt, input: `${remote}\n` },
    { waitFor: pathPrompt, input: "\n" },
  ]);
  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout).toBe("");
  expect(result.stderr).not.toContain("Server URL");
  expect(result.stderr).not.toContain("Server token");
  expect(result.stderr).not.toContain(secret);
  expect(await decoded(fixture.configuration)).toMatchObject({ serverToken: secret, repositories: [{ remote }] });
  expect(await decoded(fixture.configuration)).not.toHaveProperty("serverUrl");
});

it.skipIf(process.platform === "win32")("cancelling interactive review setup preserves the full existing configuration", async () => {
  const fixture = await fresh();
  await mkdir(path.dirname(fixture.configuration));
  const original = "# unchanged\nserverToken: existing-credential\n";
  await writeFile(fixture.configuration, original);
  const result = await terminal(["setup"], fixture.home, [
    { waitFor: reviewPrompt, input: `${remote}\n` },
    { waitFor: pathPrompt, signal: "SIGTERM" },
  ]);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("Setup cancelled");
  expect(await readFile(fixture.configuration, "utf8")).toBe(original);
  expect(await readdir(path.dirname(fixture.configuration))).toEqual(["config.yml"]);
});

it("reads automation credentials for the default origin and prevents secret leakage or insecure transport", async () => {
  const fixture = await fresh();
  const secret = "stdin-credential";
  const configured = await pipe(["setup", "--server-token-stdin"], fixture.home, fixture.home, `${secret}\r\n`);
  expect(configured.code, configured.stderr).toBe(0);
  expect(configured.stdout).toBe("");
  expect(configured.stderr).not.toContain(secret);
  expect(await decoded(fixture.configuration)).toEqual({ serverToken: secret });
  if (process.platform !== "win32") {
    await chmod(fixture.configuration, 0o640);
    const review = await pipe(["setup", "--review-repo", remote], fixture.home);
    expect(review.code, review.stderr).toBe(0);
  }
  const original = await readFile(fixture.configuration, "utf8");
  for (const input of ["", "\n", "invalid token", "one\ntwo\n", "one\n\n", "one\r", "one\u0000two", "one\u007ftwo"]) {
    const result = await pipe(["setup", "--server-token-stdin"], fixture.home, fixture.home, input);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).not.toContain(secret);
    expect(await readFile(fixture.configuration, "utf8")).toBe(original);
  }
  const changed = await pipe(["setup", "--server-url", "https://test.example"], fixture.home);
  expect(changed.code, changed.stderr).toBe(0);
  expect(await decoded(fixture.configuration)).not.toHaveProperty("serverToken");
  const insecure = await fresh();
  const rejected = await pipe(["setup", "--server-url", "http://remote.example", "--server-token-stdin"], insecure.home, insecure.home, secret);
  expect(rejected.code).toBe(1);
  expect(rejected.stderr).toContain("HTTPS");
  expect(rejected.stderr).not.toContain(secret);
  expect(await readdir(insecure.home)).toEqual([]);
});
