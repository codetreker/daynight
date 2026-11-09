import path from "node:path";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runUpdateCommand, updateSelf } from "../../../src/commands/update/updater.js";
import type { UpdateCommand, UpdateOptions } from "../../../src/commands/update/updater.js";

const missing = (filename: string): Error => Object.assign(new Error(`Missing ${filename}`), { code: "ENOENT" });
const fixture = (platform: NodeJS.Platform = "linux", version = "1.0.0", latest: unknown = "2.0.0") => {
  const targetVersion: unknown = Array.isArray(latest) && latest.length === 1 ? latest[0] : latest;
  const paths = platform === "win32" ? path.win32 : path.posix;
  const prefix = platform === "win32" ? "C:\\Global npm 中文" : "/opt/Global npm 中文";
  const root = platform === "win32" ? paths.join(prefix, "node_modules", "@codetreker", "daynight") : paths.join(prefix, "lib", "node_modules", "@codetreker", "daynight");
  const main = paths.join(root, "dist", "main.js");
  const launcher = paths.join(prefix, platform === "win32" ? "daynight.cmd" : "bin/daynight");
  const node = platform === "win32" ? "C:\\Node 中文\\node.exe" : "/opt/Node 中文/bin/node";
  const npm = platform === "win32" ? paths.resolve(node, "../node_modules/npm/bin/npm-cli.js") : paths.resolve(node, "../../lib/node_modules/npm/bin/npm-cli.js");
  const manifest = (installedVersion: unknown) => JSON.stringify({ name: "@codetreker/daynight", version: installedVersion, bin: { daynight: "dist/main.js" } });
  const contents = new Map([[paths.join(root, "package.json"), manifest(version)], [paths.resolve(npm, "../../package.json"), JSON.stringify({ name: "npm" })]]);
  const links = new Map([[root, root], [main, main], [launcher, main], [node, node], [npm, npm], [prefix, prefix]]);
  const commands: UpdateCommand[] = [];
  const shimTargets = new Map([[launcher, paths.relative(prefix, main)]]);
  let executableVersion = String(targetVersion);
  const run = vi.fn(async (command: UpdateCommand): Promise<string> => {
    commands.push(command);
    if (command.arguments[1] === "view") return JSON.stringify(latest);
    if (command.arguments[1] === "install") { contents.set(paths.join(root, "package.json"), manifest(targetVersion)); return ""; }
    if (command.arguments[0] === main) return `${executableVersion}\n`;
    if (command.arguments[0] === paths.join(root, "dist", "commands", "skill", "refresh-installed.js")) return "";
    throw new Error("Unexpected update command.");
  });
  const options: UpdateOptions = {
    packageDirectory: root, platform, nodeExecutable: node, workingDirectory: prefix, environment: { PATH: "", npm_config_prefix: "another prefix", NPM_CONFIG_USERCONFIG: "custom npmrc" },
    operations: {
      readFile: vi.fn(async (filename) => { const value = contents.get(filename); if (value === undefined) throw missing(filename); return value; }),
      realpath: vi.fn(async (filename) => { const target = links.get(filename); if (target === undefined) throw missing(filename); return target; }),
      readCmdShim: vi.fn(async (filename) => { const target = shimTargets.get(filename); if (target === undefined) throw missing(filename); return target; }),
      run,
    },
  };
  return { options, prefix, root, main, node, npm, launcher, contents, links, commands, paths, manifest, shimTargets, run, setExecutableVersion: (value: string) => { executableVersion = value; } };
};

describe("npm global self-update", () => {
  it.each(["linux", "darwin", "win32"] as const)("updates the current %s prefix, streams installation, and verifies fresh files and executable", async (platform) => {
    const f = fixture(platform);
    await expect(updateSelf(f.options)).resolves.toEqual({ status: "updated", previousVersion: "1.0.0", targetVersion: "2.0.0" });
    expect(f.commands).toEqual([
      { executable: f.node, arguments: [f.npm, "view", "@codetreker/daynight@latest", "version", "--json", "--global", "--prefix", f.prefix, "--prefer-online"], cwd: f.prefix, environment: f.options.environment, timeoutMs: 60_000, output: "capture" },
      { executable: f.node, arguments: [f.npm, "install", "@codetreker/daynight@2.0.0", "--global", "--prefix", f.prefix, "--engine-strict", "--force=false", "--no-audit", "--no-fund"], cwd: f.prefix, environment: f.options.environment, timeoutMs: 600_000, output: "inherit" },
      { executable: f.node, arguments: [f.main, "--version"], cwd: f.prefix, environment: f.options.environment, timeoutMs: 30_000, output: "capture" },
      { executable: f.node, arguments: [f.paths.join(f.root, "dist", "commands", "skill", "refresh-installed.js")], cwd: f.prefix, environment: f.options.environment, timeoutMs: 60_000, output: "inherit", cleanupProcessGroup: true },
    ]);
  });

  it.each([
    ["1.0.0", "1.0.0", "current"], ["2.0.0", "1.0.0", "ahead"], ["1.0.0+local", "1.0.0", "current"], ["1.0.0-beta.10", "1.0.0-beta.2", "ahead"],
  ])("keeps %s when latest is %s", async (current, latest, status) => {
    const f = fixture("linux", current, latest);
    f.options.workingDirectory = f.root;
    await expect(updateSelf(f.options)).resolves.toEqual({ status, previousVersion: current, targetVersion: latest });
    expect(f.commands).toHaveLength(2);
    expect(f.commands[1]!.cwd).toBe(f.root);
    expect(f.commands[1]!.arguments).toEqual([f.paths.join(f.root, "dist", "commands", "skill", "refresh-installed.js")]);
  });

  it("reports a completed npm update separately when skill refresh fails", async () => {
    const f = fixture();
    const run = f.options.operations!.run;
    const denied = new Error("skill parent access denied");
    f.options.operations!.run = async (command) => {
      if (command.arguments[0] === f.paths.join(f.root, "dist", "commands", "skill", "refresh-installed.js")) throw denied;
      return run(command);
    };
    await expect(updateSelf(f.options)).rejects.toMatchObject({ message: expect.stringContaining("package was updated from 1.0.0 to 2.0.0"), cause: denied });
    expect(JSON.parse(f.contents.get(f.paths.join(f.root, "package.json"))!).version).toBe("2.0.0");
  });

  it("repairs a failed skill refresh on the next update without reinstalling the already updated package", async () => {
    const f = fixture(); const run = f.options.operations!.run;
    const refresh = f.paths.join(f.root, "dist", "commands", "skill", "refresh-installed.js");
    let blocked = true;
    f.options.operations!.run = async (command) => {
      if (command.arguments[0] === refresh && blocked) throw new Error("skill parent access denied");
      return run(command);
    };
    await expect(updateSelf(f.options)).rejects.toThrow("package was updated from 1.0.0 to 2.0.0");
    blocked = false;
    await expect(updateSelf(f.options)).resolves.toEqual({ status: "current", previousVersion: "2.0.0", targetVersion: "2.0.0" });
    expect(f.commands.filter((command) => command.arguments[1] === "install")).toHaveLength(1);
    expect(f.commands.at(-1)!.arguments).toEqual([refresh]);
  });

  it("resolves an exact prerelease target before installing", async () => {
    const f = fixture("linux", "1.0.0-beta.2", "1.0.0-beta.10");
    await updateSelf(f.options);
    expect(f.commands[1]!.arguments).toContain("@codetreker/daynight@1.0.0-beta.10");
    expect(f.commands[1]!.arguments).not.toContain("@codetreker/daynight@latest");
  });

  it.each(["2.0.0", "2.0.0-beta.10"])("accepts npm's singleton JSON version array containing %s", async (targetVersion) => {
    const f = fixture("linux", "1.0.0", [targetVersion]);
    await expect(updateSelf(f.options)).resolves.toEqual({ status: "updated", previousVersion: "1.0.0", targetVersion });
    expect(f.commands[1]!.arguments).toContain(`@codetreker/daynight@${targetVersion}`);
  });

  it.each(["/source/packages/daynight", "/project/node_modules/@codetreker/daynight", "/cache/_npx/a/node_modules/@codetreker/daynight", "/global/pnpm/5/node_modules/.pnpm/a/node_modules/@codetreker/daynight"])("rejects source or another manager at %s", async (location) => {
    const f = fixture();
    f.links.set(location, location);
    f.contents.set(path.posix.join(location, "package.json"), f.manifest("1.0.0"));
    f.options.packageDirectory = location;
    await expect(updateSelf(f.options)).rejects.toThrow("current npm global installation");
    expect(f.run).not.toHaveBeenCalled();
  });

  it("rejects npm link after resolving the installed package to its source root", async () => {
    const f = fixture();
    const source = "/source/packages/daynight";
    f.links.set(f.root, source);
    f.contents.set(path.posix.join(source, "package.json"), f.manifest("1.0.0"));
    await expect(updateSelf(f.options)).rejects.toThrow("original package manager");
    expect(f.run).not.toHaveBeenCalled();
  });

  it("rejects a globally shaped Windows local installation without its global launcher", async () => {
    const f = fixture("win32");
    f.shimTargets.delete(f.launcher);
    await expect(updateSelf(f.options)).rejects.toThrow("current npm global installation");
    expect(f.run).not.toHaveBeenCalled();
  });

  it.each(["linux", "win32"] as const)("rejects a %s launcher pointing at another installation", async (platform) => {
    const f = fixture(platform);
    if (platform === "win32") { f.shimTargets.set(f.launcher, "different.js"); f.links.set(f.paths.join(f.prefix, "different.js"), f.paths.join(f.prefix, "different.js")); }
    else f.links.set(f.launcher, "/another/main.js");
    await expect(updateSelf(f.options)).rejects.toThrow("current npm global installation");
    expect(f.run).not.toHaveBeenCalled();
  });

  it("rejects a private source workspace even when it has an installation layout", async () => {
    const f = fixture();
    f.contents.set(path.posix.join(f.root, "package.json"), JSON.stringify({ name: "@codetreker/daynight", private: true, version: "1.0.0", bin: { daynight: "dist/main.js" } }));
    await expect(updateSelf(f.options)).rejects.toThrow("current npm global installation");
    expect(f.run).not.toHaveBeenCalled();
  });

  it("rejects an installation directory as the caller's working directory only when replacement is needed", async () => {
    const f = fixture();
    const cwd = path.posix.join(f.root, "nested");
    f.links.set(cwd, cwd); f.options.workingDirectory = cwd;
    await expect(updateSelf(f.options)).rejects.toThrow("outside its installation");
    expect(f.commands).toHaveLength(1);
  });

  it.each([null, 2, [], ["2.0.0", "2.1.0"], [null], [["2.0.0"]], "latest", "v2.0.0", " 2.0.0", "2.0"])("rejects malformed registry version %j before installing", async (latest) => {
    const f = fixture("linux", "1.0.0", latest);
    await expect(updateSelf(f.options)).rejects.toThrow("latest npm package version");
    expect(f.commands).toHaveLength(1);
  });

  it("rejects malformed registry JSON and preserves metadata errors", async () => {
    const f = fixture();
    f.run.mockResolvedValueOnce("invalid JSON");
    await expect(updateSelf(f.options)).rejects.toThrow("invalid JSON");
    const denial = new Error("registry authentication denied");
    f.run.mockRejectedValueOnce(denial);
    await expect(updateSelf(f.options)).rejects.toBe(denial);
  });

  it("preserves installer errors without running success verification", async () => {
    const f = fixture();
    const denied = Object.assign(new Error("permission denied"), { code: "EACCES" });
    f.run.mockImplementationOnce(async (command) => { f.commands.push(command); return '"2.0.0"'; });
    f.run.mockRejectedValueOnce(denied);
    await expect(updateSelf(f.options)).rejects.toBe(denied);
    expect(f.run).toHaveBeenCalledTimes(2);
  });

  it("requires the fresh manifest to match the installed target", async () => {
    const f = fixture();
    f.run.mockResolvedValueOnce('"2.0.0"').mockResolvedValueOnce("");
    await expect(updateSelf(f.options)).rejects.toThrow("does not match");
    expect(f.run).toHaveBeenCalledTimes(2);
  });

  it("rechecks launcher ownership after installation", async () => {
    const f = fixture();
    f.run.mockImplementationOnce(async () => '"2.0.0"').mockImplementationOnce(async () => {
      f.contents.set(path.posix.join(f.root, "package.json"), f.manifest("2.0.0"));
      f.links.set(f.launcher, "/different/main.js");
      return "";
    });
    await expect(updateSelf(f.options)).rejects.toThrow("current npm global installation");
    expect(f.run).toHaveBeenCalledTimes(2);
  });

  it("requires the new executable to report the exact target", async () => {
    const f = fixture();
    f.setExecutableVersion("1.0.0");
    await expect(updateSelf(f.options)).rejects.toThrow('returned version "1.0.0"; expected 2.0.0');
    expect(f.commands).toHaveLength(3);
  });

  it("locates distribution npm through a PATH symlink while keeping the current Node", async () => {
    const f = fixture();
    f.links.delete(f.npm);
    const distributionNpm = "/usr/share/nodejs/npm/bin/npm-cli.js";
    f.links.set("/usr/bin/npm", distributionNpm);
    f.contents.set("/usr/share/nodejs/npm/package.json", JSON.stringify({ name: "npm" }));
    f.options.environment = { PATH: "/usr/bin" };
    await updateSelf(f.options);
    expect(f.commands[0]!.executable).toBe(f.node);
    expect(f.commands[0]!.arguments[0]).toBe(distributionNpm);
  });

  it("fails before registry access when npm cannot be found", async () => {
    const f = fixture();
    f.links.delete(f.npm);
    await expect(updateSelf(f.options)).rejects.toThrow("Cannot locate npm's JavaScript CLI");
    expect(f.run).not.toHaveBeenCalled();
  });

  it("preserves filesystem access errors rather than treating them as an unsupported installation", async () => {
    const f = fixture();
    const denied = Object.assign(new Error("launcher access denied"), { code: "EACCES" });
    const realpath = f.options.operations!.realpath;
    f.options.operations!.realpath = async (filename) => { if (filename === f.launcher) throw denied; return realpath(filename); };
    await expect(updateSelf(f.options)).rejects.toBe(denied);
    expect(f.run).not.toHaveBeenCalled();
  });
});

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });

describe("update subprocess supervision", () => {
  it.skipIf(process.platform !== "win32").each(["capture", "inherit"] as const)("keeps Windows console handles usable with %s output", async (output) => {
    const { spawn: spawnTerminal } = await import("node-pty");
    const temporary = path.resolve(import.meta.dirname, "../../../../../.tmp/update-console");
    await mkdir(temporary, { recursive: true });
    const directory = await mkdtemp(path.join(temporary, "Console 中文 "));
    directories.push(directory);
    const driver = path.join(directory, "driver.mjs");
    const moduleUrl = new URL("../../../dist/commands/update/updater.js", import.meta.url).href;
    const childScript = "process.stdout.write('update child stdout\\n');process.stderr.write('update child stderr\\n');";
    await writeFile(driver, `import { runUpdateCommand } from ${JSON.stringify(moduleUrl)};
try {
  if (!process.stdin.isTTY || !process.stdout.isTTY || !process.stderr.isTTY) throw new Error('Expected console handles in the update parent.');
  const output = await runUpdateCommand({ executable: process.execPath, arguments: ['--eval', ${JSON.stringify(childScript)}], cwd: process.cwd(), environment: process.env, timeoutMs: 5000, output: ${JSON.stringify(output)} });
  process.stdout.write(output);
} catch (error) { console.error(error); process.exitCode = 1; }
`);
    // Pipes keep detached Windows children working and cannot reproduce console EBADF failures.
    const terminal = spawnTerminal(process.execPath, [driver], { cwd: directory, env: process.env, cols: 120, rows: 30, useConpty: true });
    let transcript = "";
    const listener = terminal.onData((data) => { transcript += data; });
    let exited = false;
    const closed = new Promise<number>((resolve) => terminal.onExit(({ exitCode }) => { exited = true; resolve(exitCode); }));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const code = await Promise.race([closed, new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), 10_000); })]);
      expect(code, transcript).toBe(0);
      expect(transcript).toContain("update child stdout");
      expect(transcript).toContain("update child stderr");
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (!exited) { terminal.kill(); await closed; }
      listener.dispose();
    }
  });

  it.each(["SIGINT", "SIGTERM", "timeout"] as const)("stops the owned command tree on %s and removes signal handlers", async (interruption) => {
    const temporary = path.resolve(import.meta.dirname, "../../../../../.tmp/update-command-tests");
    await mkdir(temporary, { recursive: true });
    const directory = await mkdtemp(path.join(temporary, "Command 中文 "));
    directories.push(directory);
    const script = path.join(directory, "command.cjs");
    const marker = path.join(directory, "heartbeat");
    await writeFile(script, `const fs=require('node:fs');const {spawn}=require('node:child_process');
if(process.argv[2]==='leaf'){setInterval(()=>fs.writeFileSync(process.argv[3],String(Date.now())),10);}
else{spawn(process.execPath,[__filename,'leaf',process.argv[2]],{stdio:'inherit'});process.on('SIGTERM',()=>{});setInterval(()=>{},1000);}`);
    const command: UpdateCommand = { executable: process.execPath, arguments: [script, marker], cwd: directory, environment: process.env, timeoutMs: interruption === "timeout" ? 3_000 : 10_000, output: "capture" };
    const { environment: _environment, ...driverCommand } = command;
    const moduleUrl = new URL("../../../src/commands/update/updater.ts", import.meta.url).href;
    const driver = `import {runUpdateCommand} from ${JSON.stringify(moduleUrl)};
process.on('message',message=>{if(message==='SIGINT'||message==='SIGTERM')process.emit(message);});
const before=[process.listenerCount('SIGINT'),process.listenerCount('SIGTERM')];
try{await runUpdateCommand({...${JSON.stringify(driverCommand)},environment:process.env});process.stdout.write('Unexpected success');process.exitCode=1;}
catch(error){process.stdout.write(error.message+'\\nHandlers restored: '+String(before[0]===process.listenerCount('SIGINT')&&before[1]===process.listenerCount('SIGTERM')));}
if(process.connected)process.disconnect();`;
    const child = spawn(process.execPath, ["--input-type=module", "--eval", driver], { cwd: directory, stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true });
    let output = "";
    child.stdout!.setEncoding("utf8").on("data", (chunk: string) => { output += chunk; });
    child.stderr!.setEncoding("utf8").on("data", (chunk: string) => { output += chunk; });
    const closed = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    try {
      const deadline = Date.now() + 10_000;
      while (true) {
        try { await readFile(marker, "utf8"); break; }
        catch (cause) { if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT")) throw cause; }
        if (Date.now() >= deadline) throw new Error(`Owned command did not start: ${output}`);
        await new Promise((resolve) => { setTimeout(resolve, 20); });
      }
      if (interruption !== "timeout") {
        if (process.platform === "win32") child.send(interruption);
        else child.kill(interruption);
      }
      expect(await closed, output).toBe(0);
      expect(output).toContain(interruption === "timeout" ? "timed out after 3 seconds" : `interrupted by ${interruption}`);
      expect(output).toContain("Handlers restored: true");
      const stopped = await readFile(marker, "utf8");
      await new Promise((resolve) => { setTimeout(resolve, 100); });
      expect(await readFile(marker, "utf8")).toBe(stopped);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        if (child.connected) child.send("SIGTERM");
        await closed;
      }
    }
  }, 30_000);

  it.skipIf(process.platform === "win32").each(["SIGINT", "SIGTERM", "timeout"] as const)("stops Git launched by a skill refresh on %s", async (interruption) => {
    const temporary = path.resolve(import.meta.dirname, "../../../../../.tmp/update-refresh-supervision");
    await mkdir(temporary, { recursive: true });
    const directory = await mkdtemp(path.join(temporary, "Refresh Git 中文 "));
    directories.push(directory);
    const bin = path.join(directory, "bin");
    const home = path.join(directory, "home");
    await mkdir(bin); await mkdir(home); await mkdir(path.join(directory, ".git"));
    const marker = path.join(directory, "git pid");
    const heartbeat = path.join(directory, "heartbeat");
    const fakeGit = path.join(bin, "git");
    await writeFile(fakeGit, `#!${process.execPath}\nconst fs = require('node:fs');fs.writeFileSync(${JSON.stringify(marker)}, String(process.pid));setInterval(() => fs.appendFileSync(${JSON.stringify(heartbeat)}, 'tick\\n'), 10);`);
    await chmod(fakeGit, 0o755);
    const helper = path.resolve(import.meta.dirname, "../../../dist/commands/skill/refresh-installed.js");
    const command = { executable: process.execPath, arguments: [helper], cwd: directory, timeoutMs: interruption === "timeout" ? 3_000 : 10_000, output: "capture", cleanupProcessGroup: true };
    const moduleUrl = new URL("../../../src/commands/update/updater.ts", import.meta.url).href;
    const driver = `import {runUpdateCommand} from ${JSON.stringify(moduleUrl)};process.on('message',signal=>process.emit(signal));try { await runUpdateCommand({...${JSON.stringify(command)},environment:process.env});process.exitCode=1; } catch(error) { process.stdout.write(error.message); }if(process.connected)process.disconnect();`;
    const child = spawn(process.execPath, ["--input-type=module", "--eval", driver], {
      cwd: directory, env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, HOME: home, USERPROFILE: home },
      stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true,
    });
    let output = "";
    child.stdout!.setEncoding("utf8").on("data", (chunk: string) => { output += chunk; });
    child.stderr!.setEncoding("utf8").on("data", (chunk: string) => { output += chunk; });
    const closed = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    let gitPid: number | undefined;
    const ticks = (): Promise<string> => readFile(heartbeat, "utf8").catch((cause: unknown) => {
      if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return "";
      throw cause;
    });
    try {
      const deadline = Date.now() + 5_000;
      while (gitPid === undefined || (await ticks()).length < 10) {
        try { gitPid = Number(await readFile(marker, "utf8")); }
        catch (cause) { if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT")) throw cause; }
        if (Date.now() >= deadline) throw new Error(`The refresh Git fixture did not start: ${output}`);
        await new Promise((resolve) => { setTimeout(resolve, 20); });
      }
      if (interruption !== "timeout") child.send(interruption);
      expect(await closed, output).toBe(0);
      expect(output).toContain(interruption === "timeout" ? "timed out after 3 seconds" : `interrupted by ${interruption}`);
      const stopped = await ticks();
      await new Promise((resolve) => { setTimeout(resolve, 100); });
      expect(await ticks()).toBe(stopped);
    } finally {
      if (child.exitCode === null && child.signalCode === null && child.connected) { child.send("SIGTERM"); await closed; }
      if (gitPid !== undefined) {
        try { process.kill(gitPid, "SIGKILL"); }
        catch (cause) { if (!(cause instanceof Error && "code" in cause && cause.code === "ESRCH")) throw cause; }
      }
    }
  }, 15_000);

  it.skipIf(process.platform === "win32")("cleans inherited descendants after a supervised helper exits", async () => {
    const temporary = path.resolve(import.meta.dirname, "../../../../../.tmp/update-refresh-supervision");
    await mkdir(temporary, { recursive: true });
    const directory = await mkdtemp(path.join(temporary, "Helper close 中文 "));
    directories.push(directory);
    const heartbeat = path.join(directory, "heartbeat");
    const leaf = path.join(directory, "leaf.cjs");
    const helper = path.join(directory, "helper.cjs");
    await writeFile(leaf, `const fs=require('node:fs');setInterval(()=>fs.appendFileSync(${JSON.stringify(heartbeat)},'tick\\n'),10);`);
    await writeFile(helper, `const fs=require('node:fs');const {spawn}=require('node:child_process');const child=spawn(process.execPath,[${JSON.stringify(leaf)}],{stdio:'ignore'});child.unref();process.stdout.write(String(child.pid));const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(heartbeat)})){clearInterval(timer);process.exit(0);}},10);`);
    let pid: number | undefined;
    try {
      const output = await runUpdateCommand({ executable: process.execPath, arguments: [helper], cwd: directory, environment: process.env, timeoutMs: 5_000, output: "capture", cleanupProcessGroup: true });
      pid = Number(output);
      const stopped = await readFile(heartbeat, "utf8");
      await new Promise((resolve) => { setTimeout(resolve, 100); });
      expect(await readFile(heartbeat, "utf8")).toBe(stopped);
    } finally {
      if (pid !== undefined) {
        try { process.kill(pid, "SIGKILL"); }
        catch (cause) { if (!(cause instanceof Error && "code" in cause && cause.code === "ESRCH")) throw cause; }
      }
    }
  });

  it("removes interruption handlers after successful and failed commands", async () => {
    const before = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
    const command: UpdateCommand = { executable: process.execPath, arguments: ["--eval", "process.stdout.write('version')"], cwd: process.cwd(), environment: process.env, timeoutMs: 5_000, output: "capture" };
    await expect(runUpdateCommand(command)).resolves.toBe("version");
    expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(before);
    await expect(runUpdateCommand({ ...command, arguments: ["--eval", "process.exitCode=7"] })).rejects.toThrow("exited with code 7");
    expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(before);
    await expect(runUpdateCommand({ ...command, executable: path.join(process.cwd(), "missing-update-node") })).rejects.toMatchObject({ code: "ENOENT" });
    expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(before);
  });

  it.skipIf(process.platform !== "win32")("rejects a missing Windows termination tool before executing any command", async () => {
    const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toLowerCase() !== "systemroot"));
    await expect(runUpdateCommand({ executable: process.execPath, arguments: ["--eval", "process.exitCode=99"], cwd: process.cwd(), environment, timeoutMs: 5_000, output: "capture" })).rejects.toThrow("SystemRoot must name");
  });
});
