import path from "node:path";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Operation } from "../../../src/api/operation.js";
import type { HerdrCommand } from "../../../src/commands/worker/herdr/command.js";
import { codexProjectTrustArguments } from "../../../src/commands/worker/herdr/arguments.js";
import { resolveWorkerPaths } from "../../../src/commands/worker/paths.js";
import { inspectWorkerEnvironment } from "../../../src/commands/worker/setup-environment.js";

const roots: string[] = [];
const quote = (value: string): string => `'${value.replaceAll("'", "'\"'\"'")}'`;
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => { resolve = complete; });
  return { promise, resolve };
};

const fixture = async () => {
  const scratch = path.resolve(import.meta.dirname, "../../../../../.tmp");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(path.join(scratch, "se-")); roots.push(root);
  const homeDirectory = path.join(root, "home");
  const cwd = path.join(root, "work");
  const codex = path.join(homeDirectory, ".codex");
  const copilot = path.join(homeDirectory, ".copilot");
  await Promise.all([mkdir(codex, { recursive: true }), mkdir(path.join(copilot, "hooks"), { recursive: true }), mkdir(cwd)]);
  const codexAsset = path.join(codex, "herdr-agent-state.sh");
  const copilotAsset = path.join(copilot, "hooks", "herdr-agent-state.sh");
  await Promise.all([writeFile(codexAsset, "HERDR_INTEGRATION_VERSION=10\n"), writeFile(copilotAsset, "HERDR_INTEGRATION_VERSION=4\n")]);
  const hooks = { hooks: { SessionStart: [{ hooks: [{ type: "command", command: `bash ${quote(codexAsset)} session` }] }] } };
  await writeFile(path.join(codex, "hooks.json"), JSON.stringify(hooks));
  const copilotHooks = { sessionStart: [{ type: "command", bash: `bash ${quote(copilotAsset)}` }] };
  const runCommand = vi.fn(async (command: HerdrCommand) => {
    if (command.file === "claude") return { stdout: "2.1.247 (Claude Code)\n", stderr: "" };
    let stdout: string;
    if (command.file === "git") stdout = "git version 2.43.0\n";
    else if (command.file === "herdr") stdout = command.args[0] === "--version" ? "herdr 0.9.5\n" : `claude: current\ncodex: current (v10) (${codexAsset})\ncopilot: current (v4) (${copilotAsset})\n`;
    else if (command.file === "bash") stdout = "GNU bash, version 5.2.0\n";
    else if (command.file === "python3") stdout = "Python 3.12.3\n";
    else if (command.file === "powershell") stdout = "5.1.0\n";
    else if (command.args[0] === "--version") stdout = command.file === "codex" ? "codex-cli 0.164.0\n" : "GitHub Copilot CLI 1.0.103.\n";
    else if (command.args.includes("--help")) stdout = "--no-daemon --dangerously-bypass-approvals-and-sandbox --dangerously-bypass-hook-trust --allow-all --no-ask-user\n";
    else if (command.args.at(-2) === "features" && command.args.at(-1) === "list") stdout = "hooks stable true\n";
    else if (command.file === "copilot" && command.args.join(" ") === "config hooks") stdout = JSON.stringify(copilotHooks);
    else throw new Error(`Unexpected command: ${command.file}`);
    return { stdout, stderr: "" };
  });
  const verifySkill = vi.fn(async () => () => "prompt");
  const paths = { ...resolveWorkerPaths(homeDirectory), herdrDirectory: "/w/h", logsDirectory: "/w/log" };
  const options = { homeDirectory, workingDirectory: cwd, paths, packageDirectory: root, signal: new AbortController().signal };
  const dependencies = { environment: {}, platform: "linux" as const, nodeVersion: "24.19.0", runCommand, verifySkill };
  return { root, homeDirectory, codex, copilot, cwd, hooks, options, dependencies, runCommand, verifySkill };
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("worker setup environment inspection", () => {
  it("inspects both candidate agents without starting a daemon or altering native configuration", async () => {
    const f = await fixture();
    const before = await readFile(path.join(f.codex, "hooks.json"), "utf8");
    const checks = await inspectWorkerEnvironment(f.options, f.dependencies);
    expect(checks.filter(({ status }) => status === "missing")).toEqual([]);
    expect(checks.filter(({ agent }) => agent !== undefined).map(({ label, agent, status }) => ({ label, agent, status }))).toEqual([
      { label: "codex executable", agent: "codex", status: "passed" },
      { label: "codex Herdr integration", agent: "codex", status: "passed" },
      { label: "copilot executable", agent: "copilot", status: "passed" },
      { label: "copilot Herdr integration", agent: "copilot", status: "passed" },
      { label: "claude executable", agent: "claude", status: "passed" },
      { label: "claude Herdr integration", agent: "claude", status: "passed" },
    ]);
    expect(f.runCommand.mock.calls.filter(([command]) => command.file === "herdr").map(([command]) => command.args)).toEqual([["--version"], ["integration", "status"]]);
    expect(f.runCommand.mock.calls.some(([command]) => command.args.some((argument) => ["start", "install", "login", "run"].includes(argument)))).toBe(false);
    expect(f.verifySkill).toHaveBeenCalledWith(f.root);
    expect(await readFile(path.join(f.codex, "hooks.json"), "utf8")).toBe(before);
    await expect(readFile(f.options.paths.configFile)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(f.options.paths.databaseFile)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports every independent missing prerequisite and corrective action", async () => {
    const f = await fixture(); const original = f.runCommand.getMockImplementation()!;
    f.runCommand.mockImplementation(async (command) => {
      if (["git", "python3", "copilot"].includes(command.file)) throw new Error(`${command.file} unavailable`);
      if (command.file === "herdr" && command.args[0] === "integration") return { stdout: "codex: outdated (v9)\ncopilot: not_installed\nclaude: current\n", stderr: "" };
      return original(command);
    });
    const checks = await inspectWorkerEnvironment(f.options, f.dependencies);
    const missing = checks.filter(({ status }) => status === "missing");
    expect(missing.map(({ label }) => label)).toEqual(["Git", "python3 hook runtime", "codex Herdr integration", "copilot executable", "copilot Herdr integration"]);
    expect(missing.every(({ remedy }) => typeof remedy === "string" && remedy.length > 0)).toBe(true);
    expect(checks.find(({ label }) => label === "codex executable")?.status).toBe("passed");
    expect(checks.filter(({ status }) => status === "unverified").map(({ label }) => label)).toEqual(["Task tools and Git transport", "Live Herdr protocol and native execution"]);
  });

  it("rejects outdated Herdr and Node without claiming protocol or native readiness", async () => {
    const f = await fixture(); const original = f.runCommand.getMockImplementation()!;
    f.runCommand.mockImplementation(async (command) => command.file === "herdr" && command.args[0] === "--version" ? { stdout: "herdr 0.8.2\n", stderr: "" } : original(command));
    const checks = await inspectWorkerEnvironment(f.options, { ...f.dependencies, nodeVersion: "20.20.0" });
    expect(checks.find(({ label }) => label === "Herdr")).toMatchObject({ status: "missing", detail: expect.stringContaining("0.9.5") });
    expect(checks.find(({ label }) => label === "Node.js")).toMatchObject({ status: "missing", detail: expect.stringContaining("22") });
    expect(checks.find(({ label }) => label === "Live Herdr protocol and native execution")?.status).toBe("unverified");
  });

  it("reports an overlong private socket while continuing the rest of the inspection", async () => {
    const f = await fixture();
    const paths = resolveWorkerPaths(`/user/${"x".repeat(150)}`, path.posix);
    expect(path.posix.isAbsolute(paths.herdrDirectory)).toBe(true);
    expect(path.posix.isAbsolute(paths.logsDirectory)).toBe(true);
    const checks = await inspectWorkerEnvironment({ ...f.options, paths }, f.dependencies);
    expect(checks.find(({ label }) => label === "Private Herdr endpoint")).toMatchObject({ status: "missing", detail: expect.stringContaining("socket exceeds") });
    expect(checks.find(({ label }) => label === "Git")?.status).toBe("passed");
  });

  it("checks selected effective Codex configuration and reports independent native failures together", async () => {
    const f = await fixture(); const original = f.runCommand.getMockImplementation()!;
    await rm(path.join(f.codex, "herdr-agent-state.sh"));
    await writeFile(path.join(f.codex, "hooks.json"), JSON.stringify({ hooks: { SessionStart: [] } }));
    f.runCommand.mockImplementation(async (command) => {
      if (command.args.includes("--help")) return { stdout: "No isolated execution flag", stderr: "" };
      if (command.args.at(-2) === "features") return { stdout: "hooks stable false\n", stderr: "" };
      return original(command);
    });
    const args = ["--config", "features.hooks=false", "--profile=work", "--no-alt-screen"];
    const checks = await inspectWorkerEnvironment({ ...f.options, configuration: { agent: "codex", model: null, args } }, f.dependencies);
    expect(checks.filter(({ status }) => status === "missing").map(({ label }) => label)).toEqual([
      "codex official hook asset", "codex unattended full access", "codex effective hooks feature", "codex effective SessionStart hook",
    ]);
    expect(f.runCommand.mock.calls.find(([command]) => command.args.at(-2) === "features")?.[0]).toMatchObject({ cwd: await realpath(f.cwd), args: ["--config", "features.hooks=false", "--profile=work", ...codexProjectTrustArguments(await realpath(f.cwd)), "features", "list"] });
    expect(f.runCommand.mock.calls.some(([command]) => command.file !== "codex")).toBe(false);
    expect(checks.at(-1)).toMatchObject({ label: "codex provider authentication", status: "unverified", agent: "codex" });
  });

  it("shares the existing native Copilot hook verification without treating installation as authentication", async () => {
    const f = await fixture();
    const checks = await inspectWorkerEnvironment({ ...f.options, configuration: { agent: "copilot", model: "custom", args: [] } }, f.dependencies);
    expect(checks.filter(({ status }) => status === "missing")).toEqual([]);
    expect(checks.find(({ label }) => label === "copilot effective SessionStart hook")?.status).toBe("passed");
    expect(checks.find(({ label }) => label === "copilot provider authentication")?.status).toBe("unverified");
    expect(f.runCommand.mock.calls.map(([command]) => [command.file, command.args])).toEqual([["copilot", ["--allow-all", "--no-ask-user", "--no-sandbox", "--help"]], ["copilot", ["config", "hooks"]]]);
  });

  it("retains private configuration bytes in files when hook parsing fails", async () => {
    const f = await fixture(); const secret = "private-unparseable-secret";
    await writeFile(path.join(f.codex, "hooks.json"), secret);
    const checks = await inspectWorkerEnvironment({ ...f.options, configuration: { agent: "codex", model: null, args: [] } }, f.dependencies);
    expect(checks.find(({ label }) => label === "codex effective SessionStart hook")).toMatchObject({ status: "missing", detail: expect.stringContaining("not valid JSON") });
    expect(JSON.stringify(checks)).not.toContain(secret);
  });

  it("uses PowerShell rather than Unix hook runtimes on Windows", async () => {
    const f = await fixture();
    const checks = await inspectWorkerEnvironment({ ...f.options, paths: resolveWorkerPaths("C:\\Users\\worker", path.win32) }, { ...f.dependencies, platform: "win32" });
    expect(checks.find(({ label }) => label === "powershell hook runtime")?.status).toBe("passed");
    expect(checks.find(({ label }) => label === "Private Herdr endpoint")?.status).toBe("passed");
    expect(f.runCommand.mock.calls.some(([command]) => ["bash", "python3"].includes(command.file))).toBe(false);
  });

  it("does not start any probes after cancellation", async () => {
    const f = await fixture(); const controller = new AbortController(); const reason = new Error("stop setup"); controller.abort(reason);
    await expect(inspectWorkerEnvironment({ ...f.options, signal: controller.signal }, f.dependencies)).rejects.toBe(reason);
    expect(f.runCommand).not.toHaveBeenCalled();
    expect(f.verifySkill).not.toHaveBeenCalled();
  });

  it.each(["git", "python3"])("preserves %s process-cleanup failures instead of treating them as a missing executable", async (file) => {
    const f = await fixture(); const original = f.runCommand.getMockImplementation()!;
    const failure = new AggregateError([new Error("owned process did not close")], "Prerequisite cleanup remained unconfirmed.");
    f.runCommand.mockImplementation(async (command) => {
      if (command.file === file) throw failure;
      return original(command);
    });
    const inspection = inspectWorkerEnvironment(f.options, f.dependencies);
    if (file === "git") await expect(inspection).rejects.toBe(failure);
    else await expect(inspection).rejects.toMatchObject({ cause: failure });
    expect(f.runCommand.mock.calls.some(([command]) => command.file === "copilot")).toBe(true);
  });

  it("preserves a cleanup failure wrapped by selected Codex profile inspection", async () => {
    const f = await fixture(); const original = f.runCommand.getMockImplementation()!;
    const failure = new AggregateError([new Error("owned native feature probe did not close")], "Prerequisite cleanup remained unconfirmed.");
    f.runCommand.mockImplementation(async (command) => {
      if (command.args.at(-2) === "features") throw failure;
      return original(command);
    });
    await expect(inspectWorkerEnvironment({ ...f.options, configuration: { agent: "codex", model: null, args: ["--profile=work"] } }, f.dependencies)).rejects.toMatchObject({
      message: expect.stringContaining("selected profile"), cause: failure,
    });
  });

  it.each(["git", "python3", "profile"])("reports unconfirmed %s probe cleanup even when setup is cancelled", async (subject) => {
    const f = await fixture(); const original = f.runCommand.getMockImplementation()!;
    const controller = new AbortController();
    const failure = new AggregateError([new Error("owned process remains unconfirmed")], "Prerequisite cleanup remained unconfirmed.");
    f.runCommand.mockImplementation(async (command) => {
      const selected = subject === "profile" ? command.args.at(-2) === "features" : command.file === subject;
      if (selected) { controller.abort(new Error("cancel before failed cleanup")); throw failure; }
      return original(command);
    });
    const configuration = subject === "profile" ? { agent: "codex" as const, model: null, args: ["--profile=work"] } : undefined;
    const inspection = inspectWorkerEnvironment({ ...f.options, signal: controller.signal, ...(configuration === undefined ? {} : { configuration }) }, f.dependencies);
    if (subject === "git") await expect(inspection).rejects.toBe(failure);
    else await expect(inspection).rejects.toMatchObject({ cause: failure });
  });

  it("awaits every launched probe's cleanup before propagating cancellation", async () => {
    const f = await fixture(); const controller = new AbortController();
    const started = deferred(); const cleaning = deferred(); const cleaned = deferred();
    const runCommand = vi.fn(async (command: HerdrCommand, operation: Operation) => {
      started.resolve();
      await new Promise<void>((resolve) => operation.signal.addEventListener("abort", () => { resolve(); }, { once: true }));
      if (command.file === "git") { cleaning.resolve(); await cleaned.promise; }
      operation.check();
      throw new Error("unreachable");
    });
    let settled = false;
    const inspection = inspectWorkerEnvironment({ ...f.options, signal: controller.signal }, { ...f.dependencies, runCommand }).finally(() => { settled = true; });
    await started.promise;
    controller.abort(new Error("cancel during probes"));
    await cleaning.promise;
    await Promise.resolve();
    expect(settled).toBe(false);
    cleaned.resolve();
    await expect(inspection).rejects.toMatchObject({ name: "OperationError", kind: "cancelled" });
    expect(settled).toBe(true);
  });
});
