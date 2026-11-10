import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import * as pty from "node-pty";
import { parse } from "yaml";
import { expect, it } from "vitest";

const firstId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const secondId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const token = "fixture-private-token";
const initial = `serverUrl: https://service.example\nserverToken: ${token}\nworker:\n  maxConcurrent: 3\n  agent: codex\n`;
const addPrompt = "Run tasks from which existing Daynight Projects?";
const removePrompt = "Remove which existing Daynight Projects from worker configuration?";
const guideUrl = new URL("../../../dist/commands/worker/configuration-guide.js", import.meta.url).href;
const repositoryUrl = new URL("../../../dist/commands/worker/repositories.js", import.meta.url).href;
const configUrl = new URL("../../../dist/commands/worker/config.js", import.meta.url).href;
const promptsUrl = new URL("../../../dist/cli/prompts.js", import.meta.url).href;
const source = `
import {runWorkerRepositoryCommand} from ${JSON.stringify(guideUrl)};
import {readWorkerRepositorySnapshot,configuredWorkerProjectIds,changeWorkerRepositories} from ${JSON.stringify(repositoryUrl)};
import {readWorkerConfiguration} from ${JSON.stringify(configUrl)};
import {createTerminalPrompt} from ${JSON.stringify(promptsUrl)};
const c=JSON.parse(process.argv[1]), date='2026-10-27T00:00:00Z';
const projects=c.projects.map(([id,name,repoUrl])=>({id,name,repoUrl,settings:{version:1n,executionWarningMinutes:60},ownership:{teamId:'dddddddd-dddd-4ddd-8ddd-dddddddddddd',version:1n},createdAt:date,updatedAt:date}));
const context={version:'0.0.0',packageDirectory:c.home,homeDirectory:()=>c.home,workingDirectory:()=>{throw new Error('Unexpected cwd access')},stdout:value=>process.stdout.write(value),stderr:value=>process.stderr.write(value),stdoutBytes:async value=>process.stdout.write(value),prompt:createTerminalPrompt()};
const dependencies={readConfiguration:readWorkerConfiguration,readSnapshot:readWorkerRepositorySnapshot,readProjects:async()=>projects,configuredProjectIds:configuredWorkerProjectIds,change:changeWorkerRepositories};
try{await runWorkerRepositoryCommand({kind:c.kind},context,dependencies);}catch(error){process.stderr.write(String(error.message)+'\\n');process.exitCode=1;}
`;

const withFixture = async (action: (f: { home: string; config: string; terminal: (kind: "add" | "remove", prompt: string, perform: (term: pty.IPty) => Promise<void>) => Promise<{ code: number; output: string }> }) => Promise<void>) => {
  const scratch = path.resolve(import.meta.dirname, "../../../../../.tmp/worker-guide-tty");
  await mkdir(scratch, { recursive: true });
  const home = await mkdtemp(path.join(scratch, "home-"));
  const config = path.join(home, ".daynight", "config.yml");
  await mkdir(path.dirname(config)); await writeFile(config, initial);
  const terminal = async (kind: "add" | "remove", prompt: string, perform: (term: pty.IPty) => Promise<void>) => {
    const data = { home, kind, projects: [[firstId, "First 中文", "https://github.com/example/first.git"], [secondId, "Second", "https://github.com/example/second.git"]] };
    const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => key.toLowerCase() !== "dn_config_dir" && value !== undefined)) as Record<string, string>;
    env.NO_COLOR = "1";
    const term = pty.spawn(process.execPath, ["--input-type=module", "--eval", source, JSON.stringify(data)], { name: "xterm-256color", cols: 120, rows: 30, cwd: home, env });
    let output = "", exited = false;
    let seen!: () => void;
    const promptSeen = new Promise<void>(resolve => { seen = resolve; });
    term.onData(chunk => { output += chunk; if (output.includes(prompt)) seen(); });
    const closed = new Promise<number>(resolve => term.onExit(({ exitCode }) => { exited = true; resolve(exitCode); }));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`Worker selection timed out: ${output}`)), 10_000); });
    try {
      await Promise.race([promptSeen, closed.then(code => { throw new Error(`Worker exited before selection (${code}): ${output}`); }), timeout]);
      await perform(term);
      const code = await Promise.race([closed, timeout]);
      expect(output).not.toContain(token);
      return { code, output };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (!exited) {
        term.kill("SIGKILL");
        let stopTimer: ReturnType<typeof setTimeout> | undefined;
        try { await Promise.race([closed, new Promise<never>((_, reject) => { stopTimer = setTimeout(() => reject(new Error("Worker terminal did not stop.")), 3_000); })]); }
        finally { if (stopTimer !== undefined) clearTimeout(stopTimer); }
      }
    }
  };
  try { await action({ home, config, terminal }); }
  finally { await rm(home, { recursive: true, force: true }); }
};

it.skipIf(process.platform === "win32")("adds and removes both Projects through the real terminal selector", async () => withFixture(async f => {
  expect((await f.terminal("add", addPrompt, async term => term.write("a\r"))).code).toBe(0);
  expect(parse(await readFile(f.config, "utf8")).worker.repositories.map((item: { projectId: string }) => item.projectId)).toEqual([firstId, secondId]);
  expect((await f.terminal("remove", removePrompt, async term => term.write("a\r"))).code).toBe(0);
  expect(parse(await readFile(f.config, "utf8")).worker).toMatchObject({ maxConcurrent: 3, agent: "codex", repositories: [] });
  expect(await readdir(homeState(f.home))).toEqual(["config.yml"]);
}));

const homeState = (home: string) => path.join(home, ".daynight");

it.skipIf(process.platform === "win32")("cancels the terminal selector without changing configuration or starting resources", async () => withFixture(async f => {
  const result = await f.terminal("add", addPrompt, async term => { term.kill("SIGTERM"); });
  expect(result.code).toBe(1);
  expect(result.output).toContain("Worker repository configuration cancelled.");
  expect(await readFile(f.config, "utf8")).toBe(initial);
  expect(await readdir(homeState(f.home))).toEqual(["config.yml"]);
}));

it.skipIf(process.platform === "win32").each(["repository", "unrelated"] as const)("handles a concurrent %s edit while the terminal selector is open", async kind => withFixture(async f => {
  const concurrent = kind === "repository" ? `${initial}  repositories:\n    - projectId: ${secondId}\n      remote: https://github.com/example/second.git\n      path: ../concurrent\n` : `${initial}review:\n  pollIntervalMs: 1800\n`;
  const result = await f.terminal("add", addPrompt, async term => { await writeFile(f.config, concurrent); term.write("a\r"); });
  if (kind === "repository") {
    expect(result.code).toBe(1); expect(result.output).toContain("changed while selecting projects");
    expect(await readFile(f.config, "utf8")).toBe(concurrent);
  } else {
    expect(result.code).toBe(0);
    const saved = parse(await readFile(f.config, "utf8"));
    expect(saved).toMatchObject({ serverToken: token, review: { pollIntervalMs: 1800 }, worker: { maxConcurrent: 3, agent: "codex" } });
    expect(saved.worker.repositories.map((item: { projectId: string }) => item.projectId)).toEqual([firstId, secondId]);
  }
  expect(await readdir(homeState(f.home))).toEqual(["config.yml"]);
}));
