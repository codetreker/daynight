import path from "node:path";
import { performance } from "node:perf_hooks";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCopilotRunner } from "../../../src/commands/review/adapters/copilot.js";
import { createProcessSupervisor } from "../../../src/commands/review/processes.js";
import type { CopilotRunOptions, CopilotRunnerOptions } from "../../../src/commands/review/adapters/copilot.js";
import type { PreparedWorktree } from "../../../src/commands/review/adapters/worktrees.js";
import { resolveReviewPaths } from "../../../src/commands/review/paths.js";
import { openStore } from "../../../src/commands/review/store.js";
import type { PreparedReviewSkill } from "../../../src/commands/review/skill.js";
import type { Store } from "../../../src/commands/review/store.js";

const fixtures = path.resolve(import.meta.dirname, "../../../../../.tmp/copilot-tests");
const directories: string[] = [];
const stores = new Set<Store>();
const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const proof = { processesExcluded: true, operationsStopped: true } as const;
const fixtureSource = `import path from 'node:path';
import {mkdirSync, writeFileSync} from 'node:fs';
let prompt=''; for await(const chunk of process.stdin) prompt+=chunk;
const args=process.argv.slice(2);
const pluginRoot=args.find(arg=>arg.startsWith('--plugin-dir=')).slice('--plugin-dir='.length);
if(args.includes('skill')&&args.includes('list')) {
 const discovery=process.env.FIXTURE_DISCOVERY;
 writeFileSync(process.env.FIXTURE_REPORT+'.discovery',JSON.stringify({args,prompt,cwd:process.cwd(),pid:process.pid,pluginRoot,skills:process.env.COPILOT_SKILLS_DIRS}));
 if(discovery==='hang') {setInterval(()=>{},1000);await new Promise(()=>{});}
 if(discovery==='delay') await new Promise(resolve=>setTimeout(resolve,150));
 if(discovery==='descendant') {
   const {spawn}=await import('node:child_process');
   spawn(process.execPath,['-e',"const fs=require('node:fs');setInterval(()=>fs.writeFileSync(process.argv[1],String(Date.now())),10);",process.env.FIXTURE_REPORT+'.leaf'],{stdio:'ignore'});
   await new Promise(resolve=>setTimeout(resolve,100));
 }
 const entry={name:'daynight-review',source:'plugin',enabled:discovery!=='disabled',path:discovery==='shadow'?process.cwd():path.join(pluginRoot,'skills','daynight-review')};
 let output=JSON.stringify(discovery==='missing'?[]:[entry]);
 if(discovery==='malformed') output='{invalid';
 if(discovery==='duplicate') output=JSON.stringify([entry,entry]);
 if(discovery==='oversized') output='x'.repeat(200000);
 if(discovery==='marker') output='PR 101 Review Completed\\n';
 if(discovery==='invalid-utf8') output=Buffer.from([0xc3]);
 if(discovery==='bom') output='\ufeff'+output;
 process.stderr.write('skill diagnostics');
 await new Promise(resolve=>process.stdout.end(output,resolve));process.exit(discovery==='nonzero'?7:0);
}
const id=args.find(x=>x.startsWith('--session-id=')||x.startsWith('--resume=')).split('=')[1];
const mode=process.env.FIXTURE_MODE;
const session=path.join(process.env.COPILOT_HOME,'session-state',id);
if(mode!=='no-history') {mkdirSync(session,{recursive:true});writeFileSync(path.join(session,'opaque.jsonl'),'not valid JSONL');}
writeFileSync(process.env.FIXTURE_REPORT,JSON.stringify({args,prompt,cwd:process.cwd(),env:Object.fromEntries(['COPILOT_SKILLS_DIRS','copilot_skills_dirs','COPILOT_HOME','COPILOT_CACHE_HOME','TMPDIR','TMP','TEMP','HOME','GH_CONFIG_DIR','GIT_DIR','GIT_WORK_TREE','GIT_CONFIG_COUNT','GIT_CONFIG_KEY_0','GIT_CONFIG_VALUE_0','GIT_CONFIG_KEY_99','GIT_CONFIG_PARAMETERS','GIT_TRACE','GIT_CURL_VERBOSE','GIT_NO_REPLACE_OBJECTS','GIT_GRAFT_FILE','GH_TOKEN','COPILOT_GITHUB_TOKEN'].map(k=>[k,process.env[k]]))}));
const marker='PR 101 Review Completed';
if(mode==='hang') {process.stdout.write(marker+'\\n');setInterval(()=>{},1000);}
else if(mode==='stderr') process.stderr.write(marker+'\\n');
else if(mode==='wrong-pr') process.stdout.write('PR 102 Review Completed\\n');
else if(mode==='prefix') process.stdout.write('done: '+marker+'\\n');
else if(mode==='leading-space') process.stdout.write(' '+marker+'\\n');
else if(mode==='trailing-space') process.stdout.write(marker+' \\n');
else if(mode==='fence') process.stdout.write('~~~\\n'+marker+'\\n~~~\\n');
else if(mode==='later') process.stdout.write(marker+'\\nnot finished\\n');
else if(mode==='spaces-after') process.stdout.write(marker+'\\n \\n');
else if(mode==='invalid-utf8') process.stdout.write(Buffer.concat([Buffer.from([0xc3]),Buffer.from('\\n'+marker+'\\n')]));
else if(mode==='bom') process.stdout.write('\\ufeff'+marker+'\\n');
else if(mode==='truncated-utf8') process.stdout.write(Buffer.concat([Buffer.from(marker+'\\n'),Buffer.from([0xc3])]));
else if(mode==='large-after') process.stdout.write(marker+'\\n'+'x'.repeat(200000));
else if(mode==='large-before') process.stdout.write('x'.repeat(200000)+'\\n'+marker+'\\n');
else if(mode==='no-newline') process.stdout.write(marker);
else if(mode==='crlf') {
 const output=Buffer.from('中文 progress\\r\\n'+marker+'\\r\\n\\r\\n');
 for(let i=0;i<output.length;i++) await new Promise(r=>process.stdout.write(output.subarray(i,i+1),r));
}
else if(mode==='missing') process.stdout.write('incomplete\\n');
else {process.stdout.write(marker+'\\n\\n');process.stderr.write('independent diagnostics\\n');}
if(mode==='nonzero') process.exitCode=7;
`;

const fixture = () => {
  mkdirSync(fixtures, { recursive: true });
  const directory = mkdtempSync(path.join(fixtures, "Copilot, 中文 "));
  directories.push(directory);
  const paths = resolveReviewPaths(path.join(directory, "home"));
  mkdirSync(paths.stateDirectory, { recursive: true });
  const worktreePath = path.join(directory, "repo", ".worktrees", "pr-101");
  mkdirSync(worktreePath, { recursive: true });
  const script = path.join(directory, "agent fixture.mjs");
  writeFileSync(script, fixtureSource);
  const report = path.join(directory, "report.json");
  const skillDirectory = path.join(directory, "plugin, root", "skills", "daynight-review");
  mkdirSync(skillDirectory, { recursive: true });
  const skill: PreparedReviewSkill = { name: "daynight-review", digest: "a".repeat(64), rootDirectory: path.dirname(path.dirname(skillDirectory)), directory: skillDirectory, entrypoint: path.join(skillDirectory, "SKILL.md") };
  writeFileSync(skill.entrypoint, "fixture skill");
  const supervise = (input: Partial<CopilotRunOptions> = {}): CopilotRunOptions => {
    const supervisor = createProcessSupervisor({ graceMs: 500 });
    return { publisherId: "fixture-publisher", publicationIdentityFormat: "line", ...input, onProcess: (child, attempt) => { if (input.excludeProcess === undefined) supervisor.onProcess(child, attempt); input.onProcess?.(child, attempt); },
      stopProcess: input.stopProcess === undefined ? supervisor.stop : input.stopProcess,
      excludeProcess: input.excludeProcess === undefined ? supervisor.exclude : input.excludeProcess };
  };
  const store = openStore(paths.databaseFile);
  stores.add(store);
  const repository = { host: "github.com", githubId: "42" };
  const pr = { ...repository, number: 101 };
  store.registerRepository({ ...repository, remote: "https://github.com/owner/repo.git", localPath: path.join(directory, "repo") });
  store.initializeRepository(repository, 100, 1);
  store.observePullRequest(repository, { number: 101, state: "open", draft: false, headSha: "a".repeat(40), baseSha: "b".repeat(40), baseRef: "main" }, 2);
  const review = store.reserveReview(pr, { reviewId: uuid(1), sessionId: uuid(500), maxAttempts: 3 }, 3)!;
  store.registerWorktree(pr, worktreePath);
  store.pinReviewBase(review.id, "b".repeat(40), 4);
  const worktree: PreparedWorktree = { kind: "prepared", path: worktreePath, headSha: "a".repeat(40), baseSha: "b".repeat(40), mergeBaseSha: "c".repeat(40),
    gitEnvironment: { GIT_NO_REPLACE_OBJECTS: "1", GIT_GRAFT_FILE: path.join(directory, "empty-graft"), GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.sparseCheckout", GIT_CONFIG_VALUE_0: "false" } };
  const sessionDirectory = path.join(paths.copilotDirectory, "session-state", uuid(500));
  const run = (mode = "success", overrides: Partial<CopilotRunnerOptions> = {}, input: Partial<CopilotRunOptions> = {}) => createCopilotRunner({
    skill, paths, processOwner: uuid(700), timeoutMs: 10_000, terminationGraceMs: 100, now: () => 10,
    command: { file: process.execPath, args: [script] }, environment: { ...process.env, FIXTURE_REPORT: report, FIXTURE_MODE: mode }, ...overrides,
  }).run(store, review.id, worktree, supervise(input));
  const retry = () => {
    const running = store.getReview(review.id)!;
    store.retryReview({ reviewId: review.id, attempt: running.attemptCount }, proof, { error: "Incomplete attempt", retryAt: 20 }, 20);
    return store.reserveReview(pr, { reviewId: uuid(2), sessionId: uuid(999), maxAttempts: 3 }, 20)!;
  };
  return { directory, skill, supervise, paths, script, report, store, repository, pr, review, worktree, sessionDirectory, run, retry };
};

afterEach(() => {
  vi.restoreAllMocks();
  for (const store of stores) store.close();
  stores.clear();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Copilot persisted sessions and direct attempts", () => {
  it("launches the platform's copilot PATH wrapper with the prompt confined to stdin", async () => {
    const f = fixture();
    const tools = path.join(f.directory, "tools with spaces");
    mkdirSync(tools);
    if (process.platform === "win32") {
      writeFileSync(path.join(tools, "copilot.cmd"), '@echo off\r\n"%FIXTURE_NODE%" "%FIXTURE_SCRIPT%" %*\r\n');
    } else {
      writeFileSync(path.join(tools, "copilot"), '#!/bin/sh\nexec "$FIXTURE_NODE" "$FIXTURE_SCRIPT" "$@"\n', { mode: 0o755 });
    }
    const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toUpperCase() !== "PATH"));
    const environment = { ...inherited, PATH: `${tools}${path.delimiter}${process.env.PATH!}`, FIXTURE_NODE: process.execPath, FIXTURE_SCRIPT: f.script, FIXTURE_REPORT: f.report };
    const previous = { id: uuid(99), revision: 2, headSha: "d".repeat(40), baseRef: 'branch $(literal) & | %PATH% "quote"' };
    const outcome = await createCopilotRunner({ skill: f.skill, paths: f.paths, processOwner: uuid(700), timeoutMs: 10_000, environment, now: () => 10 })
      .run(f.store, f.review.id, f.worktree, f.supervise({ previousReview: previous }));
    expect(outcome).toMatchObject({ completed: true, directProcessClosed: true, captureComplete: true, errors: [] });
    const report = JSON.parse(readFileSync(f.report, "utf8")) as { args: string[]; prompt: string; cwd: string };
    expect(realpathSync(report.cwd)).toBe(realpathSync(f.worktree.path));
    expect(report.args).toEqual(["-C", f.worktree.path, `--plugin-dir=${f.skill.rootDirectory}`, `--session-id=${uuid(500)}`, "-s", "--output-format", "text", "--stream", "on", "--no-color",
      "--no-ask-user", "--no-auto-update", "--allow-all-tools", "--log-dir", path.dirname(outcome.stdoutLogPath)]);
    expect(report.prompt).toContain(JSON.stringify(previous));
    expect(report.prompt).toContain("explicitly invoke /daynight-review");
    expect(report.prompt).toContain("even when resumed conversation history already contains an older skill");
    expect(report.prompt).toContain(`Daynight skill bundle: ${JSON.stringify({ name: f.skill.name, digest: f.skill.digest, entrypoint: f.skill.entrypoint })}`);
    expect(report.prompt).toContain(f.worktree.headSha);
    expect(report.prompt).toContain("\nPR 101 Review Completed\n");
    expect(report.args.join(" ")).not.toContain("$(literal)");
  });

  it("persists intent before launch, streams independent logs, and leaves final lifecycle state to the caller", async () => {
    const f = fixture();
    let observed = false;
    const outcome = await f.run("success", {}, { onProcess: (child, attempt) => {
      observed = true;
      expect(f.store.getReview(f.review.id)).toMatchObject({ status: "running", attemptCount: 1, processId: child.pid, stdoutLogPath: expect.any(String), stderrLogPath: expect.any(String) });
      expect(attempt).toEqual({ reviewId: f.review.id, attempt: 1 });
    } });
    expect(observed).toBe(true);
    expect(outcome).toMatchObject({ completed: true, directProcessClosed: true, captureComplete: true, sessionMode: "create", exitCode: 0, signal: null, errors: [] });
    expect(readFileSync(outcome.stdoutLogPath, "utf8")).toBe("PR 101 Review Completed\n\n");
    expect(readFileSync(outcome.stderrLogPath, "utf8")).toBe("independent diagnostics\n");
    expect(f.store.getReview(f.review.id)?.status).toBe("running");
    expect(f.store.getPullRequest(f.pr)).toMatchObject({ sessionId: uuid(500), sessionEstablished: true, completedRevision: 0 });
  });

  it.each([
    { name: "default", options: {}, arguments: [] },
    { name: "model", options: { model: "auto" }, arguments: ["--model", "auto"] },
    { name: "opaque model", options: { model: 'future/model $(literal) & | %PATH% "quote"' }, arguments: ["--model", 'future/model $(literal) & | %PATH% "quote"'] },
    { name: "effort", options: { reasoningEffort: "high" }, arguments: ["--reasoning-effort", "high"] },
    { name: "both", options: { model: "auto", reasoningEffort: 'future effort $(literal) & | %PATH% "quote"' }, arguments: ["--model", "auto", "--reasoning-effort", 'future effort $(literal) & | %PATH% "quote"'] },
  ])("passes independent settings as formal-review arguments while keeping discovery unchanged: $name", async ({ options, arguments: extraArguments }) => {
    const f = fixture();
    const outcome = await f.run("success", options);
    expect(outcome).toMatchObject({ completed: true, sessionMode: "create", errors: [] });
    const report = JSON.parse(readFileSync(f.report, "utf8")) as { args: string[] };
    expect(report.args).toEqual(["-C", f.worktree.path, `--plugin-dir=${f.skill.rootDirectory}`, `--session-id=${uuid(500)}`, "-s", "--output-format", "text", "--stream", "on", "--no-color",
      "--no-ask-user", "--no-auto-update", "--allow-all-tools", "--log-dir", path.dirname(outcome.stdoutLogPath), ...extraArguments]);
    const discovery = JSON.parse(readFileSync(`${f.report}.discovery`, "utf8")) as { args: string[]; prompt: string };
    expect(discovery).toMatchObject({
      args: ["-C", f.worktree.path, `--plugin-dir=${f.skill.rootDirectory}`, "--no-auto-update", "skill", "list", "--json"], prompt: "",
    });
  });

  it("preserves Copilot's nonzero result and diagnostics for configured model and reasoning effort", async () => {
    const f = fixture();
    const outcome = await f.run("nonzero", { model: "opaque-unavailable-model", reasoningEffort: "unsupported-effort" });
    expect(outcome).toMatchObject({ completed: false, directProcessClosed: true, captureComplete: true, exitCode: 7, signal: null, interruption: null });
    expect(readFileSync(outcome.stderrLogPath, "utf8")).toBe("independent diagnostics\n");
    const report = JSON.parse(readFileSync(f.report, "utf8")) as { args: string[] };
    expect(report.args.slice(-4)).toEqual(["--model", "opaque-unavailable-model", "--reasoning-effort", "unsupported-effort"]);
  });

  it("passes immutable review context over stdin and preserves auth while isolating Git and runtime paths", async () => {
    const f = fixture();
    const outcome = await f.run("success", { environment: { ...process.env, FIXTURE_REPORT: f.report,
      COPILOT_SKILLS_DIRS: "unexpected,inherited", copilot_skills_dirs: "another,inherited", HOME: "original-home", GH_CONFIG_DIR: "original-gh-config", GH_TOKEN: "fixture-secret", COPILOT_GITHUB_TOKEN: "copilot-fixture-secret",
      GIT_DIR: "wrong-repo", GIT_WORK_TREE: "wrong-worktree", GIT_CONFIG_COUNT: "100", GIT_CONFIG_KEY_99: "dangerous", GIT_CONFIG_PARAMETERS: "wrong", GIT_TRACE: "1", GIT_CURL_VERBOSE: "1" } },
    { previousReview: { id: uuid(99), revision: 2, headSha: "d".repeat(40), baseRef: "previous $(literal) & | %PATH% \"quote\"" } });
    expect(outcome.completed).toBe(true);
    const report = JSON.parse(readFileSync(f.report, "utf8")) as { args: string[]; prompt: string; cwd: string; env: Record<string, string> };
    expect(report.args).toContain(`--session-id=${uuid(500)}`);
    expect(report.args).not.toContain("-p");
    expect(report.args).toEqual(expect.arrayContaining(["-C", f.worktree.path, "-s", "--output-format", "text", "--stream", "on", "--no-color", "--no-ask-user", "--no-auto-update", "--allow-all-tools", "--log-dir"]));
    expect(report.prompt).toContain(f.review.id);
    expect(report.prompt).toContain(f.worktree.mergeBaseSha);
    expect(report.prompt).toContain(uuid(99));
    expect(report.prompt).toContain("$(literal) & | %PATH%");
    expect(report.prompt).toContain("Never submit REQUEST_CHANGES");
    expect(report.prompt).toContain('Captured publishing actor node ID: "fixture-publisher"');
    expect(report.prompt).toContain('Existing publication identity format: "line"');
    expect(report.prompt).toContain("a token embedded in other prose is insufficient");
    expect(report.prompt).toContain("do not publish under another identity");
    expect(report.prompt).toContain("Confirm a matching existing APPROVED review immediately without re-evaluating later title or description edits");
    expect(report.prompt).toContain("its unresolved threads do not block this same-round confirmation");
    expect(report.prompt).toContain("at least one real resolvable native review thread");
    expect(report.prompt).toContain("A top-level review body alone is insufficient");
    expect(report.prompt).toContain("native file-level thread on the principal changed file");
    expect(report.prompt).toContain("do not invent a code defect or line");
    expect(report.prompt).toContain("Publish APPROVE only when both PR-quality gates pass and no Critical or Major defect remains");
    expect(report.prompt).toContain("commit_id");
    expect(report.prompt).toContain("APPROVE");
    expect(report.prompt).toContain("Open, non-Draft");
    expect(report.prompt).toContain(`PR 101 Review Completed`);
    expect(report.env).toMatchObject({ HOME: "original-home", GH_CONFIG_DIR: "original-gh-config", GH_TOKEN: "fixture-secret", COPILOT_GITHUB_TOKEN: "copilot-fixture-secret",
      COPILOT_HOME: f.paths.copilotDirectory, COPILOT_CACHE_HOME: f.paths.cacheDirectory, TMPDIR: f.paths.temporaryDirectory,
      GIT_NO_REPLACE_OBJECTS: "1", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.sparseCheckout", GIT_CONFIG_VALUE_0: "false" });
    for (const name of ["COPILOT_SKILLS_DIRS", "copilot_skills_dirs", "GIT_DIR", "GIT_WORK_TREE", "GIT_CONFIG_KEY_99", "GIT_CONFIG_PARAMETERS", "GIT_TRACE", "GIT_CURL_VERBOSE"]) expect(report.env).not.toHaveProperty(name);
    expect(report.args.join(" ")).not.toContain("fixture-secret");
    expect(report.prompt).not.toContain("fixture-secret");
  });

  it("limits migrated identity recovery to existing publications while keeping new publication bodies strict", async () => {
    const f = fixture();
    const outcome = await f.run("success", {}, { publicationIdentityFormat: "legacy" });
    expect(outcome.completed).toBe(true);
    const report = JSON.parse(readFileSync(f.report, "utf8")) as { prompt: string };
    expect(report.prompt).toContain('Existing publication identity format: "legacy"');
    expect(report.prompt).toContain("permits legacy matching only to recover an already existing publication");
    expect(report.prompt).toContain("Require token boundaries so a longer identity cannot match");
    expect(report.prompt).toContain("include the stable review identity as its own exact line in the review body");
    expect(report.prompt).toContain("Confirm a matching existing APPROVED review immediately without re-evaluating later title or description edits");
    expect(report.prompt).toContain('Captured publishing actor node ID: "fixture-publisher"');
  });

  it("resumes exactly the persisted session after an incomplete attempt with fresh retained logs", async () => {
    const f = fixture();
    const model = "future-provider/model-v9";
    const reasoningEffort = "xhigh";
    const first = await f.run("missing", { model, reasoningEffort });
    const firstReport = JSON.parse(readFileSync(f.report, "utf8")) as { args: string[] };
    expect(firstReport.args.slice(-4)).toEqual(["--model", model, "--reasoning-effort", reasoningEffort]);
    f.retry();
    const second = await f.run("success", { model, reasoningEffort });
    expect(first.completed).toBe(false);
    expect(second).toMatchObject({ completed: true, sessionMode: "resume", sessionId: first.sessionId, attempt: { reviewId: first.attempt.reviewId, attempt: 2 } });
    const report = JSON.parse(readFileSync(f.report, "utf8")) as { args: string[] };
    expect(report.args).toContain(`--resume=${first.sessionId}`);
    expect(report.args.slice(-4)).toEqual(["--model", model, "--reasoning-effort", reasoningEffort]);
    expect(report.args.some((arg) => arg.startsWith("--session-id"))).toBe(false);
    expect(second.stdoutLogPath).not.toBe(first.stdoutLogPath);
    expect(readFileSync(first.stdoutLogPath, "utf8")).toBe("incomplete\n");
  });

  it("resumes a first-launch history directory after a crash without inspecting its contents", async () => {
    const f = fixture();
    mkdirSync(f.sessionDirectory, { recursive: true });
    writeFileSync(path.join(f.sessionDirectory, "events.jsonl"), Buffer.from([0xff, 0xfe]));
    const outcome = await f.run("success", { model: "auto", reasoningEffort: "high" });
    expect(outcome).toMatchObject({ completed: true, sessionMode: "resume" });
    const report = JSON.parse(readFileSync(f.report, "utf8")) as { args: string[] };
    expect(report.args).toContain(`--resume=${uuid(500)}`);
    expect(report.args.slice(-4)).toEqual(["--model", "auto", "--reasoning-effort", "high"]);
    expect(readFileSync(path.join(f.sessionDirectory, "events.jsonl"))).toEqual(Buffer.from([0xff, 0xfe]));
  });

  it("reuses the same session for a later revision and supplies the old unfinished identity", async () => {
    const f = fixture();
    const first = await f.run("missing", { model: "auto", reasoningEffort: "high" });
    const previous = f.store.getReview(f.review.id)!;
    f.store.observePullRequest(f.repository, { number: 101, state: "open", draft: false, headSha: "d".repeat(40), baseSha: "e".repeat(40), baseRef: "release" }, 20);
    f.store.retryReview(first.attempt, proof, { error: "Old target", retryAt: 20 }, 20);
    const next = f.store.reserveReview(f.pr, { reviewId: uuid(2), sessionId: uuid(999), maxAttempts: 3 }, 20)!;
    f.store.pinReviewBase(next.id, "e".repeat(40), 21);
    const outcome = await createCopilotRunner({ skill: f.skill, paths: f.paths, processOwner: uuid(700), timeoutMs: 10_000, model: "auto", reasoningEffort: "high", command: { file: process.execPath, args: [f.script] },
      environment: { ...process.env, FIXTURE_REPORT: f.report }, now: () => 30 }).run(f.store, next.id,
    { ...f.worktree, headSha: "d".repeat(40), baseSha: "e".repeat(40) }, f.supervise({ previousReview: previous }));
    expect(outcome).toMatchObject({ completed: true, sessionMode: "resume", sessionId: uuid(500), attempt: { reviewId: next.id, attempt: 1 } });
    const report = JSON.parse(readFileSync(f.report, "utf8")) as { prompt: string; args: string[] };
    expect(report.args.slice(-4)).toEqual(["--model", "auto", "--reasoning-effort", "high"]);
    expect(report.prompt).toContain(f.review.id);
    expect(report.prompt).toContain(next.id);
    expect(report.prompt).toContain('"revision":2');
    expect(report.prompt).toContain('"baseBranch":"release"');
  });

  it("blocks missing established history before consuming an attempt or launching", async () => {
    const f = fixture();
    f.store.markSessionEstablished(f.pr);
    await expect(f.run()).rejects.toThrow("missing its history");
    expect(f.store.getReview(f.review.id)).toMatchObject({ attemptCount: 0, status: "preparing" });
  });

  it("rejects a non-directory session and a mismatched prepared target", async () => {
    const f = fixture();
    mkdirSync(path.dirname(f.sessionDirectory), { recursive: true });
    writeFileSync(f.sessionDirectory, "not history");
    await expect(f.run()).rejects.toThrow("must be a directory");
    await expect(createCopilotRunner({ skill: f.skill, paths: f.paths, processOwner: uuid(700), timeoutMs: 100 }).run(f.store, f.review.id, { ...f.worktree, headSha: "wrong" }, f.supervise())).rejects.toThrow("does not match persisted");
  });

  it("consumes a failed spawn attempt and permits a new attempt to create the same absent history", async () => {
    const f = fixture();
    const failed = await f.run("success", { command: { file: path.join(f.directory, "missing-executable") } });
    expect(failed).toMatchObject({ completed: false, directProcessClosed: true, sessionMode: "create", launchFailure: "command-not-found" });
    expect(failed.errors.length).toBeGreaterThan(0);
    expect(f.store.getReview(f.review.id)?.attemptCount).toBe(1);
    f.retry();
    expect(await f.run()).toMatchObject({ completed: true, sessionMode: "create" });
  });

  it("confirms a supervised failed spawn without creating process uncertainty", async () => {
    const f = fixture();
    const processes = createProcessSupervisor({ graceMs: 500 });
    const outcome = await f.run("success", { command: { file: path.join(f.directory, "missing-supervised-executable") } }, {
      onProcess: processes.onProcess, stopProcess: processes.stop, excludeProcess: processes.exclude,
    });
    expect(outcome).toMatchObject({ completed: false, directProcessClosed: true, launchFailure: "command-not-found" });
    await expect(processes.exclude(f.store.getReview(f.review.id)!, outcome)).resolves.toEqual({ processesExcluded: true });
    expect(processes.safeToReleaseLock).toBe(true);
  });

  it("classifies an unavailable native wrapper in the formal phase after successful discovery", async () => {
    const f = fixture(); const supervisor = createProcessSupervisor({ graceMs: 500 });
    const wrapper = path.join(f.directory, process.platform === "win32" ? "vanishing agent.cmd" : "vanishing agent");
    writeFileSync(wrapper, process.platform === "win32"
      ? '@echo off\r\n"%FIXTURE_NODE%" "%FIXTURE_SCRIPT%" %*\r\n'
      : '#!/bin/sh\nexec "$FIXTURE_NODE" "$FIXTURE_SCRIPT" "$@"\n', { mode: 0o755 });
    let phases = 0;
    const outcome = await f.run("success", { command: { file: wrapper }, environment: { ...process.env,
      FIXTURE_NODE: process.execPath, FIXTURE_SCRIPT: f.script, FIXTURE_REPORT: f.report } }, {
      onProcess: (child, attempt) => { supervisor.onProcess(child, attempt); if (phases++ === 0) child.once("close", () => { rmSync(wrapper); }); },
      stopProcess: supervisor.stop, excludeProcess: supervisor.exclude,
    });
    expect(outcome).toMatchObject({ completed: false, directProcessClosed: true, launchFailure: "command-not-found", processExclusionFailure: null });
    expect(f.store.getReview(f.review.id)?.attemptCount).toBe(1);
    expect(existsSync(f.report)).toBe(false);
    await expect(supervisor.exclude(f.store.getReview(f.review.id)!, outcome)).resolves.toEqual({ processesExcluded: true });
    expect(supervisor.safeToReleaseLock).toBe(true);
  });

  it("uses fresh log files after a rejected prelaunch intent without consuming the budget", async () => {
    const f = fixture();
    const original = f.store.startAttempt;
    const spy = vi.spyOn(f.store, "startAttempt").mockImplementationOnce(() => { throw new Error("launch was canceled"); });
    await expect(f.run()).rejects.toThrow("launch was canceled");
    expect(f.store.getReview(f.review.id)?.attemptCount).toBe(0);
    spy.mockImplementation(original);
    expect(await f.run()).toMatchObject({ completed: true, attempt: { attempt: 1 } });
  });
});

describe("Copilot skill discovery and phase ownership", () => {
  it("excludes discovery before clearing its identity and starting the formal review under one attempt", async () => {
    const f = fixture();
    const supervisor = createProcessSupervisor({ graceMs: 500 });
    const phases: { pid: number; identity: string }[] = [];
    let exclusionDone = false;
    const outcome = await f.run("success", {}, {
      onProcess: (child, attempt) => {
        supervisor.onProcess(child, attempt);
        const current = f.store.getReview(f.review.id)!;
        expect(current.attemptCount).toBe(1);
        if (phases.length === 1) expect(exclusionDone).toBe(true);
        phases.push({ pid: child.pid!, identity: current.processIdentity! });
      },
      excludeProcess: async (current, processOutcome) => {
        expect(phases).toHaveLength(1);
        expect(current.processId).toBe(phases[0]!.pid);
        expect(processOutcome).toMatchObject({ directProcessClosed: true, captureComplete: true });
        expect(existsSync(f.report)).toBe(false);
        const result = await supervisor.exclude(current, processOutcome);
        expect(f.store.getReview(f.review.id)?.processId).toBe(phases[0]!.pid);
        exclusionDone = true;
        return result;
      },
    });
    expect(outcome.completed).toBe(true);
    expect(phases).toHaveLength(2);
    expect(phases[1]!.pid).not.toBe(phases[0]!.pid);
    expect(phases.map((phase) => phase.identity.split(":").at(-1))).toEqual(["skill-list", "review"]);
    expect(f.store.getReview(f.review.id)).toMatchObject({ attemptCount: 1, processId: phases[1]!.pid });
    const discovery = JSON.parse(readFileSync(`${f.report}.discovery`, "utf8")) as { args: string[]; cwd: string; prompt: string; pluginRoot: string; skills?: string };
    expect(discovery.args).toEqual(["-C", f.worktree.path, `--plugin-dir=${f.skill.rootDirectory}`, "--no-auto-update", "skill", "list", "--json"]);
    expect(realpathSync(discovery.cwd)).toBe(realpathSync(f.worktree.path));
    expect(discovery.prompt).toBe("");
    expect(discovery.pluginRoot).toBe(f.skill.rootDirectory);
    expect(discovery).not.toHaveProperty("skills");
    const formal = JSON.parse(readFileSync(f.report, "utf8")) as { args: string[] };
    expect(formal.args).toContain(`--plugin-dir=${discovery.pluginRoot}`);
    const logs = path.dirname(outcome.stdoutLogPath);
    expect(JSON.parse(readFileSync(path.join(logs, "skill-list.stdout.log"), "utf8"))).toMatchObject([{ name: "daynight-review", path: f.skill.directory }]);
    expect(readFileSync(path.join(logs, "skill-list.stderr.log"), "utf8")).toBe("skill diagnostics");
    expect(readFileSync(outcome.stdoutLogPath, "utf8")).toBe("PR 101 Review Completed\n\n");
    await supervisor.exclude(f.store.getReview(f.review.id)!, outcome);
  });

  it.each(["nonzero", "malformed", "missing", "disabled", "shadow", "duplicate", "invalid-utf8", "bom", "oversized", "marker"])("fails discovery %s after one attempt with full capture and no main process", async (discovery) => {
    const f = fixture();
    const outcome = await f.run("success", { maxDiscoveryBytes: 1024,
      environment: { ...process.env, FIXTURE_REPORT: f.report, FIXTURE_DISCOVERY: discovery } });
    expect(outcome).toMatchObject({ completed: false, directProcessClosed: true, captureComplete: true, lastNonemptyLine: null, processExclusionFailure: null });
    expect(outcome.errors.length).toBeGreaterThan(0);
    expect(f.store.getReview(f.review.id)).toMatchObject({ status: "running", attemptCount: 1, processId: null, processIdentity: null });
    expect(f.store.getPullRequest(f.pr)?.sessionEstablished).toBe(false);
    expect(existsSync(f.report)).toBe(false);
    expect(readFileSync(outcome.stdoutLogPath, "utf8")).toBe("");
  });

  it("retains failed capture separately from JSON validation and never starts the main process", async () => {
    const f = fixture();
    const outcome = await f.run("success", {}, { onProcess: (child) => { child.stdout!.destroy(new Error("discovery capture failed")); } });
    expect(outcome).toMatchObject({ completed: false, captureComplete: false });
    expect(outcome.errors.some((error) => error.message === "discovery capture failed")).toBe(true);
    expect(existsSync(f.report)).toBe(false);
  });

  it("retains discovery identity and forbids the main process when exclusion fails", async () => {
    const f = fixture(); const error = new Error("discovery descendants could not be excluded");
    const outcome = await f.run("success", {}, { excludeProcess: async () => { throw error; } });
    expect(outcome.processExclusionFailure).toBe(error);
    expect(f.store.getReview(f.review.id)).toMatchObject({ attemptCount: 1, processId: expect.any(Number), processIdentity: expect.stringContaining(":skill-list") });
    expect(existsSync(f.report)).toBe(false);
  });

  it("clears an excluded preflight when aborted between phases and never launches the review", async () => {
    const f = fixture(); const abort = new AbortController(); const supervisor = createProcessSupervisor({ graceMs: 500 });
    const outcome = await f.run("success", {}, { signal: abort.signal, onProcess: supervisor.onProcess,
      excludeProcess: async (current, evidence) => { const result = await supervisor.exclude(current, evidence); abort.abort(); return result; } });
    expect(outcome).toMatchObject({ completed: false, interruption: "aborted", directProcessClosed: true, captureComplete: true });
    expect(f.store.getReview(f.review.id)).toMatchObject({ attemptCount: 1, processId: null, processIdentity: null });
    expect(existsSync(f.report)).toBe(false);
    await expect(supervisor.exclude(f.store.getReview(f.review.id)!, outcome)).resolves.toEqual({ processesExcluded: true });
  });

  it("forbids the formal review when the process identity changes during exclusion", async () => {
    const f = fixture();
    const outcome = await f.run("success", {}, { excludeProcess: async (current) => {
      const attempt = { reviewId: current.id, attempt: current.attemptCount };
      f.store.clearProcess(attempt, { processId: current.processId, processIdentity: current.processIdentity }, proof);
      f.store.recordProcess(attempt, { pid: 12345, identity: "replacement" });
      return proof;
    } });
    expect(outcome.processExclusionFailure?.message).toContain("process identity changed");
    expect(f.store.getReview(f.review.id)).toMatchObject({ attemptCount: 1, processId: 12345, processIdentity: "replacement" });
    expect(existsSync(f.report)).toBe(false);
  });

  it("cancels active discovery and keeps the formal review unlaunched", async () => {
    const f = fixture(); const abort = new AbortController();
    const outcome = await f.run("success", { environment: { ...process.env, FIXTURE_REPORT: f.report, FIXTURE_DISCOVERY: "hang" } },
      { signal: abort.signal, onProcess: () => { abort.abort(); } });
    expect(outcome).toMatchObject({ completed: false, interruption: "aborted", directProcessClosed: true });
    expect(existsSync(f.report)).toBe(false);
  });

  it("shares one deadline across discovery, exclusion and formal review", async () => {
    const f = fixture(); const supervisor = createProcessSupervisor({ graceMs: 500 });
    // Controlled phase costs keep host process startup from changing the remaining-budget assertion.
    let monotonicTime = 1_000;
    vi.spyOn(performance, "now").mockImplementation(() => monotonicTime);
    const timers = vi.spyOn(globalThis, "setTimeout");
    const phases: string[] = [];
    const outcome = await f.run("hang", { timeoutMs: 700, environment: { ...process.env, FIXTURE_REPORT: f.report, FIXTURE_MODE: "hang" } },
      { onProcess: (child, attempt) => {
        supervisor.onProcess(child, attempt);
        const phase = child.spawnargs.some((arg) => arg.startsWith("--session-id=")) ? "review" : "discovery";
        phases.push(phase);
        if (phase === "discovery") monotonicTime += 150;
      }, stopProcess: supervisor.stop, excludeProcess: async (current, evidence) => {
        const result = await supervisor.exclude(current, evidence);
        monotonicTime += 100;
        return result;
      } });
    expect(phases).toEqual(["discovery", "review"]);
    expect(outcome).toMatchObject({ completed: false, interruption: "timeout", directProcessClosed: true });
    expect(timers.mock.calls.map((call) => call[1])).toEqual(expect.arrayContaining([700, 450]));
    await supervisor.exclude(f.store.getReview(f.review.id)!, outcome);
  });

  it("rechecks the deadline after discovery exclusion before launching the review", async () => {
    const f = fixture(); const supervisor = createProcessSupervisor({ graceMs: 500 });
    const outcome = await f.run("success", { timeoutMs: 300 }, { onProcess: supervisor.onProcess,
      excludeProcess: async (current, evidence) => { const result = await supervisor.exclude(current, evidence); await new Promise((resolve) => { setTimeout(resolve, 350); }); return result; } });
    expect(outcome).toMatchObject({ completed: false, interruption: "timeout", directProcessClosed: true });
    expect(f.store.getReview(f.review.id)?.processId).toBeNull();
    expect(existsSync(f.report)).toBe(false);
  });

  it.skipIf(process.platform === "win32")("excludes real discovery descendants before starting the formal review", async () => {
    const f = fixture();
    const outcome = await f.run("success", { environment: { ...process.env, FIXTURE_REPORT: f.report, FIXTURE_DISCOVERY: "descendant" } });
    expect(outcome.completed).toBe(true);
    const stopped = readFileSync(`${f.report}.leaf`, "utf8");
    await new Promise((resolve) => { setTimeout(resolve, 80); });
    expect(readFileSync(`${f.report}.leaf`, "utf8")).toBe(stopped);
    expect(existsSync(f.report)).toBe(true);
  });
});

describe("Copilot completion protocol", () => {
  it.each(["success", "crlf", "no-newline", "large-before"])("accepts a complete normal capture with exact final marker: %s", async (mode) => {
    const outcome = await fixture().run(mode);
    expect(outcome).toMatchObject({ completed: true, captureComplete: true, exitCode: 0, lastNonemptyLine: "PR 101 Review Completed" });
  });

  it.each(["stderr", "wrong-pr", "prefix", "leading-space", "trailing-space", "fence", "later", "spaces-after", "missing", "large-after", "nonzero", "no-history", "invalid-utf8", "truncated-utf8", "bom"])("rejects an incomplete or invalid result: %s", async (mode) => {
    expect(await fixture().run(mode)).toMatchObject({ completed: false, directProcessClosed: true });
  });

  it("rejects stream capture errors even if a valid marker was written", async () => {
    const f = fixture();
    const outcome = await f.run("success", {}, { onProcess: (child) => { if (child.spawnargs.some((arg) => arg.startsWith("--session-id="))) child.stdout!.destroy(new Error("capture failed")); } });
    expect(outcome.completed).toBe(false);
    expect(outcome.captureComplete).toBe(false);
    expect(outcome.errors.some((error) => error.message === "capture failed")).toBe(true);
  });

  it("bounds a hung direct process without asserting descendant exclusion", async () => {
    const outcome = await fixture().run("hang", { timeoutMs: 500 });
    expect(outcome).toMatchObject({ completed: false, directProcessClosed: true, interruption: "timeout" });
    expect(outcome).not.toHaveProperty("processesExcluded");
  });

  it("aborts an active direct process and rejects cancellation before launch without consuming budget", async () => {
    const f = fixture();
    const controller = new AbortController();
    const outcome = await f.run("hang", {}, { signal: controller.signal, onProcess: (child) => { if (child.spawnargs.some((arg) => arg.startsWith("--session-id="))) controller.abort(); } });
    expect(outcome).toMatchObject({ completed: false, interruption: "aborted", directProcessClosed: true });
    const other = fixture();
    await expect(other.run("success", {}, { signal: AbortSignal.abort() })).rejects.toThrow();
    expect(other.store.getReview(other.review.id)?.attemptCount).toBe(0);
  });
});
