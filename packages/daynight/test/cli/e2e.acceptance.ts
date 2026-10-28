import { execFileSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import crossSpawn from "cross-spawn";
import { parse, parseDocument } from "yaml";
import { expect, it } from "vitest";

const workspace = path.resolve(import.meta.dirname, "../../../..");
const packageDirectory = path.join(workspace, "packages/daynight");
const helpers = path.resolve(import.meta.dirname, "../fixtures/e2e");
const existingState = path.resolve(import.meta.dirname, "../fixtures/review-state-v1");
type Pull = { number: number; state: "open" | "closed"; draft: boolean; merged_at: string | null; head: { sha: string }; base: { ref: string; sha: string }; ci: "PENDING" | "FAILURE" | "SUCCESS" | null; title: string; body: string };
type Skill = { rootDirectory: string; directory: string; entrypoint: string; digest: string; contents: string; contentSha256: string };
type Discovery = { args: string[]; cwd: string; skill: Skill };
type Agent = Discovery & { session: string; target: { pullRequest: number; reviewId: string; revision: number; headSha: string; baseBranch: string }; head: string; reconciled: boolean; reviewFile: string; prompt: string; repositoryStatus: string };
type Publication = { number: number; event: string; commit_id: string; body: string; publisher: string; comments?: unknown[] };
type Request = { version: number; endpoint: string; method: string };
type PullRow = { desired_revision: number; completed_revision: number; session_id: string; cleanup_pending: number; worktree_path: string | null; state: string };

it("runs the packed and installed CLI through a persistent native Git and SQLite review lifecycle", async () => {
  const temporary = path.join(workspace, ".tmp");
  mkdirSync(temporary, { recursive: true });
  rmSync(path.join(temporary, "e2e-evidence.json"), { force: true });
  const directory = mkdtempSync(path.join(temporary, "Installed CLI 中文 "));
  try {
    const home = path.join(directory, "home, 中文");
    const stateDirectory = path.join(home, ".daynight");
    const bin = path.join(directory, "executables");
    const consumer = path.join(directory, "consumer install");
    const repository = path.join(directory, "review repository 中文");
    const origin = path.join(directory, "origin.git");
    const secondCwd = path.join(directory, "different cwd 中文");
    for (const location of [stateDirectory, bin, consumer, secondCwd]) mkdirSync(location, { recursive: true });
    const fakeGh = path.join(bin, process.platform === "win32" ? "gh.exe" : "gh");
    copyFileSync(process.execPath, fakeGh);
    chmodSync(fakeGh, 0o755);
    const nodeOptions = `--import=${pathToFileURL(path.join(helpers, "preload.mjs")).href}`;
    const environment: NodeJS.ProcessEnv = { ...process.env };
    for (const name of Object.keys(environment)) {
      if (/^(?:GH_|GITHUB_|COPILOT_|GIT_|NODE_OPTIONS$|DAYNIGHT_)/i.test(name)) delete environment[name];
    }
    Object.assign(environment, {
      HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, "config"),
      PATH: `${bin}${path.delimiter}${process.env.PATH}`, NODE_OPTIONS: nodeOptions,
      DAYNIGHT_E2E_DIRECTORY: directory, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(directory, "gitconfig"),
      GIT_TERMINAL_PROMPT: "0", NO_COLOR: "1", GH_PROMPT_DISABLED: "1",
      COPILOT_SKILLS_DIRS: path.join(directory, "inherited unrelated skills"),
    });
    const git = (args: readonly string[], input?: string): string => execFileSync("git", [...args], {
      cwd: directory, env: environment, encoding: "utf8", timeout: 30_000, ...(input === undefined ? {} : { input }),
    }).trim();
    git(["init", "--bare", "--initial-branch=main", origin]);
    git(["config", "--file", environment.GIT_CONFIG_GLOBAL!, "protocol.allow", "never"]);
    git(["config", "--file", environment.GIT_CONFIG_GLOBAL!, "protocol.file.allow", "always"]);
    git(["config", "--file", environment.GIT_CONFIG_GLOBAL!, `url.${pathToFileURL(origin).href}.insteadOf`, "https://github.com/fixture/review-project.git"]);
    const commit = (contents: string, parent?: string): string => {
      const blob = git(["--git-dir", origin, "hash-object", "-w", "--stdin"], contents);
      const tree = git(["--git-dir", origin, "mktree"], `100644 blob ${blob}\treview.txt\n`);
      return git(["--git-dir", origin, "hash-object", "-t", "commit", "-w", "--stdin"],
        `tree ${tree}\n${parent === undefined ? "" : `parent ${parent}\n`}author Fixture <fixture@example.invalid> 1700000000 +0000\ncommitter Fixture <fixture@example.invalid> 1700000000 +0000\n\n${contents}\n`);
    };
    const base = commit("base\n");
    const first = commit("first review\n", base);
    const second = commit("second review\n", first);
    const third = commit("third review\n", second);
    const updatedBase = commit("base advanced\n", base);
    git(["--git-dir", origin, "update-ref", "refs/heads/main", base]);
    git(["--git-dir", origin, "update-ref", "refs/heads/release", base]);
    git(["--git-dir", origin, "update-ref", "refs/pull/11/head", first]);
    git(["--git-dir", origin, "update-ref", "refs/pull/12/head", third]);
    const pull = (number: number, sha: string, draft = false): Pull => ({ number, state: "open", draft, merged_at: null, head: { sha }, base: { ref: "main", sha: base }, ci: null, title: "Review lifecycle fixture", body: number === 12 ? "unclear" : "A focused lifecycle fixture." });
    const old = pull(10, first);
    const current = pull(11, first, true);
    const pulls = [old];
    let version = 0;
    const resolvedThreadIds: string[] = [];
    const publishState = (): number => {
      const next = path.join(directory, `${randomUUID()}.json`);
      writeFileSync(next, JSON.stringify({ version: ++version, pulls, resolvedThreadIds }));
      renameSync(next, path.join(directory, "api.json"));
      return version;
    };
    publishState();
    const readRecords = <T>(kind: string): T[] => {
      const folder = path.join(directory, kind);
      return existsSync(folder) ? readdirSync(folder).filter((file) => file.endsWith(".json")).map((file) => JSON.parse(readFileSync(path.join(folder, file), "utf8")) as T) : [];
    };
    const agents = () => readRecords<Agent>("agents");
    const discoveries = () => readRecords<Discovery>("discoveries");
    const publications = () => readRecords<Publication>("publications");
    const threads = () => readRecords<{ id: string; number: number; reviewId: string; subjectType?: string; line?: number }>("threads");
    const resolveThreads = (number: number): void => {
      for (const thread of threads().filter((item) => item.number === number)) if (!resolvedThreadIds.includes(thread.id)) resolvedThreadIds.push(thread.id);
    };
    const databaseFile = path.join(stateDirectory, "state.sqlite");
    const query = <T>(sql: string): T | undefined => {
      if (!existsSync(databaseFile)) return undefined;
      const database = new Database(databaseFile, { readonly: true });
      try {
        if (database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'repositories'").get() === undefined) return undefined;
        return database.prepare(sql).get() as T | undefined;
      } finally { database.close(); }
    };
    const pr = (number = 11) => query<PullRow>(`SELECT * FROM pull_requests WHERE number = ${number}`);
    let running: ChildProcess | undefined;
    let completion: Promise<number | null> | undefined;
    let output = "";
    let failure: unknown;
    const waitFor = async (condition: () => boolean, description: string, timeout = 90_000): Promise<void> => {
      const deadline = Date.now() + timeout;
      while (!condition()) {
        if (failure !== undefined) throw failure;
        if (running !== undefined && running.exitCode !== null) throw new Error(`Installed CLI exited during ${description}: ${output}`);
        if (Date.now() > deadline) throw new Error(`Timed out waiting for ${description}. CLI output:\n${output}`);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    };
    const pnpm = (args: string[], cwd: string): void => {
      const result = crossSpawn.sync("pnpm", args, { cwd, stdio: "inherit", env: { ...process.env, NO_COLOR: "1", XDG_CACHE_HOME: path.join(temporary, "cache") }, timeout: 120_000 });
      if (result.error) throw result.error;
      if (result.status !== 0) throw new Error(`pnpm ${args[0]} exited with ${String(result.status)}.`);
    };
    const tarball = path.join(directory, "daynight.tgz");
    const modules = parse(readFileSync(path.join(workspace, "node_modules/.modules.yaml"), "utf8")) as { storeDir: string };
    const storeDirectory = path.dirname(modules.storeDir);
    pnpm(["pack", "--out", tarball], packageDirectory);
    writeFileSync(path.join(consumer, "package.json"), JSON.stringify({ name: "daynight-installed-acceptance", private: true, dependencies: { "@codetreker/daynight": `file:${tarball.replaceAll("\\", "/")}` } }));
    pnpm(["install", "--prod", "--ignore-scripts", "--ignore-workspace", "--no-frozen-lockfile", "--store-dir", storeDirectory, "--reporter", "append-only"], consumer);
    const installedBin = path.join(consumer, "node_modules/.bin", process.platform === "win32" ? "daynight.cmd" : "daynight");
    expect(existsSync(installedBin)).toBe(true);
    const installedPackage = path.join(consumer, "node_modules", "@codetreker", "daynight");
    const installed = JSON.parse(readFileSync(path.join(installedPackage, "package.json"), "utf8")) as { name: string; version: string; bin: { daynight: string; dn: string } };
    expect(installed.name).toBe("@codetreker/daynight");
    expect(installed.bin).toEqual({ daynight: "dist/main.js", dn: "dist/main.js" });
    expect(installed.version).toBe((JSON.parse(readFileSync(path.join(packageDirectory, "package.json"), "utf8")) as { version: string }).version);
    const skillRelativeDirectory = "commands/review/skills/daynight-review";
    const sourceSkillDirectory = path.join(packageDirectory, "src", skillRelativeDirectory);
    const installedSkillDirectory = path.join(installedPackage, "dist", skillRelativeDirectory);
    const bundleFiles = (folder: string): Record<string, Buffer> => Object.fromEntries(readdirSync(folder, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile()).map((entry) => {
        const filename = path.join(entry.parentPath, entry.name);
        return [path.relative(folder, filename).replaceAll("\\", "/"), readFileSync(filename)];
      }));
    const originalBundle = bundleFiles(sourceSkillDirectory);
    expect(originalBundle["SKILL.md"]).toBeDefined();
    expect(bundleFiles(installedSkillDirectory)).toEqual(originalBundle);
    const publicSkillRelativeDirectory = "commands/skill/skills/using-daynight";
    const publicBundle = bundleFiles(path.join(packageDirectory, "src", publicSkillRelativeDirectory));
    expect(publicBundle["SKILL.md"]).toBeDefined();
    for (const reference of ["handbook", "run-task", "autopilot-managed-task", "task-execution", "create-task", "handoff", "goal", "task-content"]) expect(publicBundle[`references/${reference}.md`]).toBeDefined();
    expect(bundleFiles(path.join(installedPackage, "dist", publicSkillRelativeDirectory))).toEqual(publicBundle);
    const installedSkillFile = path.join(installedSkillDirectory, "SKILL.md");
    const originalSkillContents = originalBundle["SKILL.md"]!.toString("utf8");
    const updatedSkillContents = `${originalSkillContents}\n<!-- Installed acceptance: updated bundle for the next daemon. -->\n`;
    const listingExecutables = path.join(directory, "listing executables");
    mkdirSync(listingExecutables);
    linkSync(fakeGh, path.join(listingExecutables, process.platform === "win32" ? "node.exe" : "node"));
    if (process.platform !== "win32") {
      for (const name of ["dirname", "sed", "uname"]) {
        const executable = execFileSync("/bin/sh", ["-c", 'command -v "$1"', "listing-launcher", name], { env: environment, encoding: "utf8", timeout: 5_000 }).trim();
        copyFileSync(executable, path.join(listingExecutables, name));
      }
    }
    const list = (alias: "list" | "ls", listingHome = home): string => {
      const result = crossSpawn.sync(installedBin, ["review", alias], {
        cwd: secondCwd, encoding: "utf8", windowsHide: true, timeout: 30_000,
        env: { ...environment, PATH: listingExecutables, NODE_OPTIONS: "", HOME: listingHome, USERPROFILE: listingHome, XDG_CONFIG_HOME: path.join(listingHome, "config") },
      });
      if (result.error) throw result.error;
      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).toBe("");
      return result.stdout;
    };
    const helpHome = path.join(directory, "help-only home 中文");
    const information = (args: string[], launcher = installedBin): string => {
      const result = crossSpawn.sync(launcher, args, {
        cwd: secondCwd, encoding: "utf8", windowsHide: true, timeout: 30_000,
        env: { ...environment, PATH: listingExecutables, NODE_OPTIONS: "", HOME: helpHome, USERPROFILE: helpHome, XDG_CONFIG_HOME: path.join(helpHome, "config") },
      });
      if (result.error) throw result.error;
      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).toBe("");
      return result.stdout;
    };
    const rootHelp = information([]);
    expect(rootHelp).toContain("Usage: daynight <command>");
    expect(rootHelp).toMatch(/^  review\s/m);
    expect(rootHelp).toMatch(/^  update\s/m);
    expect(rootHelp).toMatch(/^  completion\s/m);
    expect(information(["--help"])).toBe(rootHelp);
    expect(information(["--version"])).toBe(`${installed.version}\n`);
    const shortBin = path.join(consumer, "node_modules/.bin", process.platform === "win32" ? "dn.cmd" : "dn");
    expect(information([], shortBin)).toBe(rootHelp);
    expect(information(["--help"], shortBin)).toBe(rootHelp);
    expect(information(["--version"], shortBin)).toBe(`${installed.version}\n`);
    expect(information(["task", "create", "--help"], shortBin)).toBe(information(["task", "create", "--help"]));
    for (const shell of ["bash", "zsh"]) expect(information(["completion", shell], shortBin)).toBe(information(["completion", shell]));
    const reviewHelp = information(["review"]);
    expect(reviewHelp).toContain("Usage: daynight review <command>");
    expect(information(["review", "--help"])).toBe(reviewHelp);
    expect(information(["review", "run", "--help"])).toContain("Usage: daynight review run");
    expect(information(["update", "--help"])).toContain("Usage: daynight update");
    const completionHelp = information(["completion"]);
    expect(completionHelp).toContain("Usage: daynight completion <command>");
    expect(information(["completion", "setup", "--help"])).toContain("--rc-file <path>");
    expect(information(["completion", "--help"])).toBe(completionHelp);
    expect(information(["completion", "bash"])).toContain("complete -F _daynight_completion 'daynight'");
    expect(information(["completion", "zsh"])).toContain("compdef _daynight 'daynight'");
    expect(existsSync(helpHome)).toBe(false);
    const existingHome = path.join(directory, "existing client home 中文");
    const existingDirectory = path.join(existingHome, ".daynight");
    mkdirSync(existingDirectory, { recursive: true });
    const existingConfig = path.join(existingDirectory, "config.yml");
    const existingDatabase = path.join(existingDirectory, "state.sqlite");
    const existingContents = readFileSync(path.join(existingState, "config.yml"), "utf8");
    writeFileSync(existingConfig, existingContents);
    const seed = new Database(existingDatabase);
    try {
      seed.exec(readFileSync(path.join(existingState, "schema.sql"), "utf8"));
      const parameters = {
        repositoryPath: path.join(existingHome, "fixture-checkout"),
        worktreePath: path.join(existingHome, "fixture-checkout", ".worktrees", "pr-17"),
        stdoutLogPath: path.join(existingDirectory, "logs", "completed.stdout.log"),
        stderrLogPath: path.join(existingDirectory, "logs", "completed.stderr.log"),
      };
      for (const statement of readFileSync(path.join(existingState, "state.sql"), "utf8").split(";").filter((sql) => sql.trim() !== "")) {
        seed.prepare(statement).run(parameters);
      }
    } finally { seed.close(); }
    const existingSnapshot = (): unknown => {
      const database = new Database(existingDatabase, { readonly: true, fileMustExist: true });
      try {
        return {
          schemaVersion: database.pragma("user_version", { simple: true }),
          schema: database.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name").all(),
          repositories: database.prepare("SELECT * FROM repositories ORDER BY host, github_id").all(),
          pullRequests: database.prepare("SELECT * FROM pull_requests ORDER BY host, github_id, number").all(),
          reviews: database.prepare("SELECT * FROM reviews ORDER BY id").all(),
        };
      } finally { database.close(); }
    };
    const beforeExistingListing = existingSnapshot();
    expect(beforeExistingListing).toMatchObject({ schemaVersion: 1 });
    const reusedListing = list("list", existingHome);
    expect(list("ls", existingHome)).toBe(reusedListing);
    expect(reusedListing).toContain("github.com/fixture/review-project\nLast observed: 2026-10-19T12:00:00.000Z");
    expect(reusedListing).toMatch(/^#17\s+Open\s+Completed\s+1$/m);
    expect(reusedListing).toMatch(/^#18\s+Draft\s+Paused\s+-$/m);
    expect(reusedListing).not.toMatch(/^#19\s/m);
    expect(reusedListing).toMatch(/^#20\s+Open\s+Retry waiting\s+2$/m);
    expect(reusedListing).toContain("Retry at: 2026-10-19T12:00:30.000Z\n  Error: Fixture agent interrupted");
    expect(readFileSync(existingConfig, "utf8")).toBe(existingContents);
    expect(existingSnapshot()).toEqual(beforeExistingListing);
    expect(readdirSync(existingDirectory).sort()).toEqual(["config.yml", "state.sqlite"]);
    expect(readRecords<Request>("requests")).toHaveLength(0);
    expect(agents()).toHaveLength(0);
    expect(publications()).toHaveLength(0);
    const databaseSnapshot = (polling = false): unknown => {
      const database = new Database(databaseFile, { readonly: true, fileMustExist: true });
      try {
        return database.transaction(() => {
          const repositories = database.prepare("SELECT * FROM repositories ORDER BY host, github_id").all() as Record<string, unknown>[];
          const pullRequests = database.prepare("SELECT * FROM pull_requests ORDER BY host, github_id, number").all() as Record<string, unknown>[];
          if (polling) {
            for (const row of repositories) delete row.last_poll_at;
            for (const row of pullRequests) delete row.observed_at;
          }
          return { schema: database.pragma("user_version", { simple: true }), repositories, pullRequests,
            reviews: database.prepare("SELECT * FROM reviews ORDER BY id").all(),
            publications: database.prepare("SELECT * FROM review_publications ORDER BY review_id").all() };
        }).deferred();
      } finally { database.close(); }
    };
    const register = (args: string[], registrationHome = home): void => {
      const result = crossSpawn.sync(installedBin, ["review", "add-repo", ...args], {
        cwd: directory, env: { ...environment, HOME: registrationHome, USERPROFILE: registrationHome, XDG_CONFIG_HOME: path.join(registrationHome, "config") },
        encoding: "utf8", windowsHide: true, timeout: 30_000,
      });
      if (result.error) throw result.error;
      expect(result.status, result.stderr).toBe(0);
    };
    const configFile = path.join(stateDirectory, "config.yml");
    register(["https://github.com/fixture/review-project.git", "--path", path.relative(directory, repository)]);
    expect(parse(readFileSync(configFile, "utf8"))).toMatchObject({
      review: {
        repositoryRoot: "~/daynights",
        repositories: [{ remote: "https://github.com/fixture/review-project.git", path: repository }],
      },
    });
    expect(readdirSync(stateDirectory)).toEqual(["config.yml"]);
    expect(existsSync(repository)).toBe(false);
    expect(readRecords<Request>("requests")).toHaveLength(0);
    expect(agents()).toHaveLength(0);
    expect(publications()).toHaveLength(0);
    const registrationHome = path.join(directory, "registration home 中文");
    const registrationState = path.join(registrationHome, ".daynight");
    const registrationConfigFile = path.join(registrationState, "config.yml");
    const defaultRepository = path.join(registrationHome, "daynights/github.com/fixture/default-project");
    register(["https://github.com/fixture/default-project.git"], registrationHome);
    const registrationConfig = parseDocument(readFileSync(registrationConfigFile, "utf8"));
    expect(registrationConfig.toJS()).toMatchObject({
      review: {
        repositoryRoot: "~/daynights",
        repositories: [{ remote: "https://github.com/fixture/default-project.git", path: defaultRepository }],
      },
    });
    const changedRoot = path.join(registrationHome, "future repositories 中文");
    registrationConfig.setIn(["review", "repositoryRoot"], changedRoot);
    writeFileSync(registrationConfigFile, registrationConfig.toString());
    register(["https://github.com/fixture/future-project.git"], registrationHome);
    expect(parse(readFileSync(registrationConfigFile, "utf8"))).toMatchObject({
      review: {
        repositoryRoot: changedRoot,
        repositories: [
          { remote: "https://github.com/fixture/default-project.git", path: defaultRepository },
          { remote: "https://github.com/fixture/future-project.git", path: path.join(changedRoot, "github.com/fixture/future-project") },
        ],
      },
    });
    expect(readdirSync(registrationState)).toEqual(["config.yml"]);
    expect(existsSync(path.join(registrationHome, "daynights"))).toBe(false);
    expect(existsSync(changedRoot)).toBe(false);
    expect(readRecords<Request>("requests")).toHaveLength(0);
    expect(agents()).toHaveLength(0);
    expect(publications()).toHaveLength(0);
    const uninitializedConfiguration = readFileSync(registrationConfigFile, "utf8");
    const uninitializedListing = list("list", registrationHome);
    expect(list("ls", registrationHome)).toBe(uninitializedListing);
    expect(uninitializedListing).toContain("github.com/fixture/default-project\nLast observed: never\nNot initialized.");
    expect(uninitializedListing).toContain("github.com/fixture/future-project\nLast observed: never\nNot initialized.");
    expect(readFileSync(registrationConfigFile, "utf8")).toBe(uninitializedConfiguration);
    expect(readdirSync(registrationState)).toEqual(["config.yml"]);
    expect(readRecords<Request>("requests")).toHaveLength(0);
    expect(agents()).toHaveLength(0);
    expect(publications()).toHaveLength(0);
    const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
    if (process.platform === "win32") writeFileSync(path.join(bin, "copilot.cmd"), `@"${process.execPath}" "${path.join(helpers, "copilot.mjs")}" %*\r\n`);
    else {
      writeFileSync(path.join(bin, "copilot"), `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(path.join(helpers, "copilot.mjs"))} "$@"\n`);
      chmodSync(path.join(bin, "copilot"), 0o755);
    }
    const copilotModel = "configured-review-model";
    const copilotReasoningEffort = "high";
    const lifecycleConfig = parseDocument(readFileSync(configFile, "utf8"));
    for (const [key, value] of Object.entries({ copilotModel, copilotReasoningEffort, pollIntervalMs: 200, maxConcurrentWorker: 1, agentTimeoutMs: 60000, maxAttempts: 3, retryDelayMs: 100 })) lifecycleConfig.setIn(["review", key], value);
    writeFileSync(configFile, lifecycleConfig.toString());
    const start = (cwd: string): void => {
      rmSync(path.join(directory, "stop"), { force: true });
      rmSync(path.join(directory, "crash"), { force: true });
      output = ""; failure = undefined;
      running = crossSpawn(installedBin, ["review", "run"], { cwd, env: environment, detached: process.platform !== "win32", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      running.stdout!.on("data", (data: Buffer) => { output += data.toString(); process.stdout.write(data); });
      running.stderr!.on("data", (data: Buffer) => { output += data.toString(); process.stderr.write(data); });
      running.on("error", (error) => { failure = error; });
      completion = new Promise((resolve) => running!.once("close", resolve));
    };
    const awaitClose = async (description: string, timeout = 30_000): Promise<number | null> => {
      let timer: NodeJS.Timeout | undefined;
      try {
        return await Promise.race([completion!, new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Installed CLI did not ${description}:\n${output}`)), timeout);
        })]);
      } finally { clearTimeout(timer); }
    };
    const forceStopOwnedTree = async (): Promise<void> => {
      if (running?.pid === undefined) throw new Error("No owned CLI process tree is available to stop.");
      if (process.platform === "win32") execFileSync("taskkill", ["/PID", String(running.pid), "/T", "/F"], { env: environment, timeout: 30_000, stdio: "pipe" });
      else process.kill(-running.pid, "SIGKILL");
      await awaitClose("close after its owned process tree was forcibly stopped");
      running = undefined;
    };
    const abruptStopWhenQuiescent = async (): Promise<void> => {
      const lock = JSON.parse(readFileSync(path.join(stateDirectory, "instance.lock"), "utf8")) as { pid: number };
      writeFileSync(path.join(directory, "crash"), "exit after direct children have closed\n");
      const code = await awaitClose("exit abruptly after its direct child processes closed");
      running = undefined;
      rmSync(path.join(directory, "crash"));
      expect(code, output).toBe(73);
      const receipt = JSON.parse(readFileSync(path.join(directory, "crash-receipt.json"), "utf8")) as { pid: number; exitCode: number; resources: string[] };
      expect(receipt.pid).toBe(lock.pid);
      expect(receipt.exitCode).toBe(73);
      expect(receipt.resources).not.toContain("ProcessWrap");
    };
    const refusedStartup = (description: string): void => {
      const result = crossSpawn.sync(installedBin, ["review", "run"], { cwd: secondCwd, env: environment, encoding: "utf8", windowsHide: true, timeout: 30_000 });
      if (result.error) throw result.error;
      expect(result.status, description).toBe(1);
      expect(result.stderr).toContain("Cannot acquire instance lock");
      expect(result.stderr).toContain("is still running");
    };
    const stop = async (): Promise<void> => {
      writeFileSync(path.join(directory, "stop"), "stop\n");
      const code = await awaitClose("stop cleanly");
      expect(code, output).toBe(0);
      running = undefined;
      expect(existsSync(path.join(stateDirectory, "instance.lock"))).toBe(false);
    };
    const observedWithoutReview = async (stateVersion: number, expectedAgents: number): Promise<void> => {
      await waitFor(() => readRecords<Request>("requests").filter((item) => item.version === stateVersion && item.endpoint.includes("state=open")).length >= 2, `two complete polls for fixture version ${stateVersion}`);
      expect(agents()).toHaveLength(expectedAgents);
    };
    const completed = async (revision: number, number = 11): Promise<void> => {
      await waitFor(() => pr(number)?.completed_revision === revision, `PR ${number} completed revision ${revision}`);
      expect(pr(number)?.desired_revision).toBe(revision);
    };
    const scenarios: string[] = ["packed-skill-bundle-exact-bytes", "client-and-review-help-without-state", "completion-generation-without-state", "pre-refactor-schema-v1-reuse", "config-only-registration", "relative-registration-path", "default-root-registration", "registration-path-fixed-after-root-change", "review-list-before-initialization"];
    try {
      execFileSync(process.execPath, ["--input-type=module", "--eval", `
        import assert from "node:assert/strict";
        import { spawn } from "node:child_process";
        import { once } from "node:events";
        const child = spawn(process.execPath, ["--eval", "process.stdin.resume()"], { stdio: ["pipe", "ignore", "ignore"] });
        await once(child, "spawn");
        assert(process.getActiveResourcesInfo().includes("ProcessWrap"));
        const closed = once(child, "close");
        child.stdin.end();
        await closed;
        do { await new Promise(setImmediate); } while (process.getActiveResourcesInfo().includes("ProcessWrap"));
        assert(!process.getActiveResourcesInfo().includes("ProcessWrap"));
      `], { env: environment, timeout: 5_000, stdio: "pipe" });
      // The native fake must run its preload before resolving the absent API main.
      expect(JSON.parse(execFileSync(fakeGh, ["api", "repos/fixture/review-project"], { env: environment, encoding: "utf8" }))).toEqual({ id: 4242 });
      start(directory);
      await waitFor(() => query<{ start_pr_no: number }>("SELECT start_pr_no FROM repositories")?.start_pr_no === 10, "permanent initial cutoff");
      expect(git(["-C", repository, "config", "--local", "--get", "remote.origin.url"])).toBe("https://github.com/fixture/review-project.git");
      refusedStartup("a second installed CLI must refuse the active instance lock");
      expect(agents()).toHaveLength(0);
      await abruptStopWhenQuiescent();
      const lockFile = path.join(stateDirectory, "instance.lock");
      expect(existsSync(lockFile)).toBe(true);
      const staleOwner = JSON.parse(readFileSync(lockFile, "utf8")) as { owner: string };
      expect(agents()).toHaveLength(0);
      const recoveredVersion = publishState();
      start(secondCwd);
      await observedWithoutReview(recoveredVersion, 0);
      expect(JSON.parse(readFileSync(lockFile, "utf8")).owner).not.toBe(staleOwner.owner);
      expect(query<{ start_pr_no: number }>("SELECT start_pr_no FROM repositories")?.start_pr_no).toBe(10);
      scenarios.push("singleton-refusal", "abrupt-stop-retains-lock", "automatic-stale-lock-recovery", "restart-preserves-initial-cutoff");
      pulls.push(current);
      await observedWithoutReview(publishState(), 0);
      current.head.sha = second;
      git(["--git-dir", origin, "update-ref", "refs/pull/11/head", second]);
      await observedWithoutReview(publishState(), 0);
      scenarios.push("initial-cutoff", "draft-and-draft-head-skip");
      const draftConfiguration = readFileSync(configFile, "utf8");
      const draftSnapshot = databaseSnapshot(true);
      const liveLock = readFileSync(path.join(stateDirectory, "instance.lock"), "utf8");
      const draftListing = list("list");
      expect(draftListing).toContain("github.com/fixture/review-project\nLast observed: ");
      expect(draftListing).not.toContain("Tracking PRs above");
      expect(draftListing).toMatch(/^#11\s+Draft\s+Paused\s+-$/m);
      expect(draftListing).not.toMatch(/^#10\s/m);
      expect(query("SELECT * FROM pull_requests WHERE number = 10")).toBeUndefined();
      expect(readFileSync(configFile, "utf8")).toBe(draftConfiguration);
      expect(readFileSync(path.join(stateDirectory, "instance.lock"), "utf8")).toBe(liveLock);
      expect(databaseSnapshot(true)).toEqual(draftSnapshot);
      expect(agents()).toHaveLength(0);
      expect(publications()).toHaveLength(0);
      scenarios.push("review-list-live-draft");
      current.draft = false; current.ci = "PENDING";
      const pendingCiVersion = publishState();
      await observedWithoutReview(pendingCiVersion, 0);
      await waitFor(() => readRecords<Request>("requests").filter((item) => item.version === pendingCiVersion && item.endpoint === "graphql").length >= 2, "pending CI checks");
      expect(query<{ count: number }>("SELECT count(*) AS count FROM reviews")?.count).toBe(0);
      expect(pr()?.session_id).toBeNull();
      expect(pr()?.worktree_path).toBeNull();
      current.ci = "FAILURE";
      const failedCiVersion = publishState();
      await observedWithoutReview(failedCiVersion, 0);
      await waitFor(() => readRecords<Request>("requests").filter((item) => item.version === failedCiVersion && item.endpoint === "graphql").length >= 2, "failed CI checks");
      expect(query<{ count: number }>("SELECT count(*) AS count FROM reviews")?.count).toBe(0);
      current.ci = "SUCCESS"; publishState();
      await completed(3);
      scenarios.push("pending-ci-waits", "failed-ci-waits", "passing-ci-admits");
      const initialAgents = agents();
      expect(initialAgents).toHaveLength(2);
      expect(initialAgents.filter((item) => item.reconciled)).toHaveLength(1);
      expect(initialAgents.map((item) => item.session)).toEqual([initialAgents[0]!.session, initialAgents[0]!.session]);
      expect(initialAgents.flatMap((item) => item.args).filter((argument) => argument.startsWith("--session-id="))).toHaveLength(1);
      expect(initialAgents.flatMap((item) => item.args).filter((argument) => argument.startsWith("--resume="))).toHaveLength(1);
      const initialSkill = initialAgents[0]!.skill;
      expect(initialSkill.contents).toBe(originalSkillContents);
      expect(initialAgents[1]!.skill).toEqual(initialSkill);
      expect(initialSkill.rootDirectory).toBe(path.join(stateDirectory, "cache", "review-skills", initialSkill.digest));
      expect(initialSkill.digest).toMatch(/^[a-f0-9]{64}$/);
      expect(initialSkill.rootDirectory).not.toBe(environment.COPILOT_SKILLS_DIRS);
      expect(initialSkill.entrypoint).toBe(path.join(initialSkill.directory, "SKILL.md"));
      expect(bundleFiles(initialSkill.directory)).toEqual(originalBundle);
      expect(initialSkill.directory).toBe(path.join(initialSkill.rootDirectory, "skills", "daynight-review"));
      expect(JSON.parse(readFileSync(path.join(initialSkill.rootDirectory, "plugin.json"), "utf8"))).toMatchObject({ name: "daynight-review-bundle", version: "1.0.0" });
      scenarios.push("skill-discovery-before-create-and-resume", "skill-plugin-clears-inherited-custom-directories", "skill-snapshot-outside-reviewed-checkout", "skill-plugin-path-with-comma-spaces-unicode");
      expect(publications()).toHaveLength(1);
      expect(publications()[0]).toMatchObject({ number: 11, event: "COMMENT", commit_id: second });
      expect(publications()[0]!.comments).toHaveLength(1);
      scenarios.push("ready-review", "inline-comment", "missing-marker-session-reconciliation");
      const session = pr()!.session_id;
      const replacement = path.join(installedSkillDirectory, "SKILL.md.next");
      writeFileSync(replacement, updatedSkillContents, { flag: "wx" });
      renameSync(replacement, installedSkillFile);
      expect(readFileSync(installedSkillFile, "utf8")).toBe(updatedSkillContents);
      expect(readFileSync(path.join(sourceSkillDirectory, "SKILL.md"), "utf8")).toBe(originalSkillContents);
      await observedWithoutReview(publishState(), 2);
      expect(pr()!.desired_revision).toBe(3);
      scenarios.push("unresolved-native-thread-blocks-fresh-round", "same-round-marker-reconciliation-with-open-thread");
      resolveThreads(11);
      current.head.sha = third; current.ci = "PENDING";
      git(["--git-dir", origin, "update-ref", "refs/pull/11/head", third]);
      await observedWithoutReview(publishState(), 2);
      current.ci = "SUCCESS"; publishState();
      await completed(4);
      scenarios.push("new-head-ci-waits");
      expect(publications().filter((item) => item.event === "APPROVE")).toHaveLength(1);
      scenarios.push("new-head-approval");
      git(["--git-dir", origin, "update-ref", "refs/heads/main", updatedBase]);
      current.base.sha = updatedBase;
      await observedWithoutReview(publishState(), 3);
      current.base = { ref: "release", sha: base }; publishState();
      await completed(5);
      scenarios.push("base-tip-does-not-trigger", "base-branch-triggers");
      expect(agents()).toHaveLength(4);
      expect(agents().every((item) => item.skill.digest === initialSkill.digest && item.skill.contents === originalSkillContents)).toBe(true);
      scenarios.push("running-daemon-retains-captured-skill-after-installed-update");
      await stop();
      expect(pr()!.session_id).toBe(session);
      old.draft = false; old.head.sha = third;
      current.head.sha = second;
      git(["--git-dir", origin, "update-ref", "refs/pull/11/head", second]); publishState();
      start(secondCwd);
      await completed(6);
      const resumedUpdatedAgent = agents().find((item) => item.target.pullRequest === 11 && item.target.revision === 6)!;
      expect(resumedUpdatedAgent.session).toBe(session);
      expect(resumedUpdatedAgent.args).toContain(`--resume=${session}`);
      expect(resumedUpdatedAgent.skill.contents).toBe(updatedSkillContents);
      expect(resumedUpdatedAgent.skill.digest).not.toBe(initialSkill.digest);
      expect(resumedUpdatedAgent.skill.rootDirectory).toBe(path.join(stateDirectory, "cache", "review-skills", resumedUpdatedAgent.skill.digest));
      expect(bundleFiles(resumedUpdatedAgent.skill.directory)).toEqual({ ...originalBundle, "SKILL.md": Buffer.from(updatedSkillContents) });
      scenarios.push("same-session-restart-loads-updated-skill-snapshot");
      expect(query<{ start_pr_no: number }>("SELECT start_pr_no FROM repositories")?.start_pr_no).toBe(10);
      expect(pr()!.session_id).toBe(session);
      expect(query("SELECT * FROM pull_requests WHERE number = 10")).toBeUndefined();
      expect(agents().filter((item) => item.target.pullRequest === 11).every((item) => item.session === session)).toBe(true);
      scenarios.push("orderly-stop-lock-release", "different-cwd-restart", "persistent-cutoff-and-session", "force-push-review");
      const additional = pull(12, third); pulls.push(additional); publishState();
      await completed(1, 12);
      scenarios.push("no-ci-review");
      expect(pr(12)!.session_id).not.toBe(session);
      const descriptionReviews = publications().filter((item) => item.number === 12);
      expect(descriptionReviews).toHaveLength(1);
      expect(readRecords<Publication>("reviews").filter((item) => item.number === 12)).toHaveLength(1);
      expect(descriptionReviews[0]).toMatchObject({ event: "COMMENT", commit_id: third, body: expect.stringContaining("PR-wide description/scope issue") });
      expect(descriptionReviews[0]).not.toHaveProperty("comments");
      const descriptionAgents = agents().filter((item) => item.target.pullRequest === 12);
      expect(descriptionAgents).toHaveLength(2);
      expect(descriptionAgents.filter((item) => item.reconciled)).toHaveLength(1);
      expect(new Set(descriptionAgents.map((item) => item.session)).size).toBe(1);
      expect(threads().filter((item) => item.number === 12)).toHaveLength(1);
      const descriptionThread = threads().find((item) => item.number === 12)!;
      expect(descriptionThread).toMatchObject({ subjectType: "FILE" });
      expect(descriptionThread).not.toHaveProperty("line");
      additional.body = "Clarify the lifecycle fixture description without changing its commits.";
      await observedWithoutReview(publishState(), agents().length);
      expect(pr(12)!.desired_revision).toBe(1);
      scenarios.push("file-level-description-thread", "pending-file-thread-retry-reconciliation", "description-edit-waits-for-thread-resolution");
      const beforeResolution = agents().length;
      resolveThreads(12); publishState();
      await completed(2, 12);
      expect(agents()).toHaveLength(beforeResolution + 1);
      expect(publications().filter((item) => item.number === 12)).toHaveLength(2);
      expect(publications().filter((item) => item.number === 12 && item.event === "APPROVE")).toHaveLength(1);
      const sameHeadAgents = agents().filter((item) => item.target.pullRequest === 12);
      expect(sameHeadAgents.every((item) => item.target.headSha === third)).toBe(true);
      expect(new Set(sameHeadAgents.map((item) => item.session)).size).toBe(1);
      await observedWithoutReview(publishState(), beforeResolution + 1);
      additional.body = "Edited after approval; retain the existing approval.";
      await observedWithoutReview(publishState(), beforeResolution + 1);
      expect(pr(12)!.desired_revision).toBe(2);
      scenarios.push("description-only-resolution-admits-one-same-head-round", "approved-description-edit-preserves-approval");
      const completedConfiguration = readFileSync(configFile, "utf8");
      const completedSnapshot = databaseSnapshot(true);
      const completedLock = readFileSync(path.join(stateDirectory, "instance.lock"), "utf8");
      const completedAgents = agents().length;
      const completedPublications = publications().length;
      const completedListing = list("list");
      const aliasListing = list("ls");
      const withoutPollTime = (text: string): string => text.replace(/^Last observed: .*$/gm, "Last observed: <daemon poll time>");
      expect(withoutPollTime(aliasListing)).toBe(withoutPollTime(completedListing));
      expect(completedListing).toMatch(/^#11\s+Open\s+Completed\s+1$/m);
      expect(completedListing).toMatch(/^#12\s+Open\s+Completed\s+1$/m);
      expect(readFileSync(configFile, "utf8")).toBe(completedConfiguration);
      expect(readFileSync(path.join(stateDirectory, "instance.lock"), "utf8")).toBe(completedLock);
      expect(databaseSnapshot(true)).toEqual(completedSnapshot);
      expect(agents()).toHaveLength(completedAgents);
      expect(publications()).toHaveLength(completedPublications);
      scenarios.push("review-list-live-completed");
      current.state = "closed"; current.merged_at = "2026-01-01T00:00:00Z";
      additional.state = "closed"; publishState();
      await waitFor(() => pr()!.worktree_path === null && pr(12)!.worktree_path === null, "merged and closed worktree cleanup");
      expect(existsSync(path.join(repository, ".worktrees/pr-11"))).toBe(false);
      expect(existsSync(path.join(repository, ".worktrees/pr-12"))).toBe(false);
      expect(git(["-C", repository, "worktree", "list", "--porcelain"])).not.toContain("pr-11");
      expect(git(["-C", repository, "worktree", "list", "--porcelain"])).not.toContain("pr-12");
      const administrativeWorktrees = path.join(repository, ".git/worktrees");
      expect(existsSync(administrativeWorktrees) ? readdirSync(administrativeWorktrees) : []).toEqual([]);
      expect(pr()!.state).toBe("merged");
      expect(pr(12)!.state).toBe("closed");
      expect(existsSync(path.join(stateDirectory, "copilot/session-state", session))).toBe(true);
      scenarios.push("separate-pr-session", "merged-cleanup", "closed-unmerged-cleanup", "history-retained");
      await stop();
      const closedConfiguration = readFileSync(configFile, "utf8");
      const closedSnapshot = databaseSnapshot();
      const requestsBeforeListing = readRecords<Request>("requests").length;
      const closedListing = list("list");
      expect(list("ls")).toBe(closedListing);
      expect(closedListing).toContain("No tracked ongoing PRs.");
      expect(closedListing).not.toMatch(/^#(?:10|11|12)\s/m);
      expect(readFileSync(configFile, "utf8")).toBe(closedConfiguration);
      expect(databaseSnapshot()).toEqual(closedSnapshot);
      expect(existsSync(path.join(stateDirectory, "instance.lock"))).toBe(false);
      expect(readRecords<Request>("requests")).toHaveLength(requestsBeforeListing);
      expect(agents()).toHaveLength(completedAgents);
      expect(publications()).toHaveLength(completedPublications);
      scenarios.push("review-list-closed-snapshot");
      const calls = agents();
      const discoveryCalls = discoveries();
      expect(calls).toHaveLength(8);
      for (const item of calls) {
        for (const [flag, value] of [["--model", copilotModel], ["--reasoning-effort", copilotReasoningEffort]] as const) {
          expect(item.args.filter((argument) => argument === flag)).toHaveLength(1);
          const index = item.args.indexOf(flag);
          expect(item.args.slice(index, index + 2)).toEqual([flag, value]);
        }
      }
      expect(discoveryCalls).toHaveLength(calls.length);
      expect(discoveryCalls.every((item) => item.args.slice(-3).join(" ") === "skill list --json" && item.args.includes("--no-auto-update") && item.args[item.args.indexOf("-C") + 1] === item.cwd && !item.args.some((argument) => /^--(?:session-id|resume)=/.test(argument) || /^--(?:model|reasoning-effort)(?:=|$)/.test(argument)))).toBe(true);
      expect([...discoveryCalls, ...calls].every((item) => item.args.includes(`--plugin-dir=${item.skill.rootDirectory}`))).toBe(true);
      expect(discoveryCalls.map((item) => ({ cwd: item.cwd, skill: item.skill })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))))
        .toEqual(calls.map((item) => ({ cwd: item.cwd, skill: item.skill })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))));
      expect(calls.every((item) => item.skill.contentSha256 === createHash("sha256").update(item.skill.contents).digest("hex") && item.prompt.includes("/daynight-review") && item.prompt.includes(JSON.stringify(item.skill.entrypoint)) && item.prompt.includes(item.skill.digest))).toBe(true);
      expect(calls.every((item) => item.repositoryStatus === "")).toBe(true);
      expect(readFileSync(initialSkill.entrypoint, "utf8")).toBe(originalSkillContents);
      scenarios.push("per-attempt-discovery-separated-from-review-invocations", "review-create-and-resume-read-current-snapshot", "reviewed-checkout-remains-clean");
      expect(calls.every((item) => item.head === item.target.headSha && item.cwd === path.join(repository, ".worktrees", `pr-${item.target.pullRequest}`))).toBe(true);
      expect(calls.every((item) => item.prompt.includes("Never submit REQUEST_CHANGES") && item.reviewFile.endsWith("\n"))).toBe(true);
      expect(publications().every((item) => item.publisher === "copilot-fixture" && (item.event === "COMMENT" || item.event === "APPROVE"))).toBe(true);
      writeFileSync(path.join(temporary, "e2e-evidence.json"), JSON.stringify({ success: true, packageVersion: installed.version,
        installedBin: path.relative(directory, installedBin).replaceAll("\\", "/"), packagePacked: true, consumerInstall: "registry",
        sqlite: "real", git: "real-local-origin", github: "controlled-native-executable", copilot: "controlled-default-command-shim",
        liveCopilotExercised: false, liveGitHubExercised: false, scenarios,
        receipts: { agentInvocations: calls.length, skillDiscoveryInvocations: discoveryCalls.length, configuredCopilotModel: copilotModel, modelArgumentInvocations: calls.length,
          configuredCopilotReasoningEffort: copilotReasoningEffort, reasoningEffortArgumentInvocations: calls.length, bundledSkillFiles: Object.keys(originalBundle), skillDigests: [initialSkill.digest, resumedUpdatedAgent.skill.digest],
          originalSkillSha256: initialSkill.contentSha256, updatedSkillSha256: resumedUpdatedAgent.skill.contentSha256,
          runningDaemonSkillPreserved: true, sameSessionUpdatedSkillAfterRestart: true, reviewedCheckoutClean: true,
          publications: publications().length, commentReviews: publications().filter((item) => item.event === "COMMENT").length,
          approvingReviews: publications().filter((item) => item.event === "APPROVE").length, nativeThreads: threads().length,
          sameHeadReviewAfterResolution: true, approvedDescriptionEditsPreserved: true, sameSessionAfterRestart: true, cleanShutdowns: 2, cleanedWorktrees: 2,
          singletonRefusals: 1, abruptStops: 1, automaticStaleLockRecoveries: 1 },
      }, null, 2));
    } finally {
      if (running !== undefined) {
        writeFileSync(path.join(directory, "stop"), "stop\n");
        try { await awaitClose("stop during fixture cleanup", 10_000); running = undefined; }
        catch { await forceStopOwnedTree(); }
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 180_000);
