import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { Socket } from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { herdrIpcAddress } from "../../../src/commands/worker/herdr/rpc.js";
import { createOperation } from "../../../src/api/operation.js";
import { resolveToolLaunch } from "../../../src/platform/tool-executables.js";
import { createMacProcessControl } from "../../../src/commands/worker/herdr/native-macos.js";
import type { MacProcessIdentity } from "../../../src/commands/worker/herdr/lifecycle-types.js";
import type { WorkerPaths } from "../../../src/commands/worker/paths.js";
import type { ExecutionConfiguration } from "../../../src/commands/worker/types.js";
import { herdrExecutionAgentName } from "../../../src/commands/worker/herdr/agents.js";
import type { HerdrTaskBinding } from "../../../src/commands/worker/herdr/agents.js";
import { executeHistoricalMetadataProbe, executeRawPreparationProbe, historicalWindowsInventoryCommand, preparationProbeMarker, runPreparationProbeSequence } from "./herdr-platform-probes.fixtures.js";
import { decodeWindowsExternalScript, prepareWindowsObserverEnvironment, runWindowsPlatformQuery, windowsExternalScriptQuery, windowsProcessQuery, decodeWindowsProcessQuery, windowsConsoleQuery, decodeWindowsConsoleQuery } from "./windows-platform-query.fixtures.js";

const execute = promisify(execFile);
const packageRoot = path.resolve(import.meta.dirname, "../../..");
const outputRoot = path.resolve(packageRoot, "../../.tmp/herdr-tools/research-platform");
let windowsPreparationProbeAttempted = false;
export const platformSystemEnvironment = (source: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  const entries = Object.entries(source);
  return Object.fromEntries(["SystemRoot", "SystemDrive", "ComSpec", "WINDIR", "OS"].flatMap(key => {
    const value = entries.find(([name]) => name.toLowerCase() === key.toLowerCase())?.[1];
    return value === undefined ? [] : [[key, value]];
  }));
};
const errorText = (error: unknown): string => error instanceof Error ? `${error.message}${error.cause ? `: ${errorText(error.cause)}` : ""}` : String(error);
const closedEndpoint = (endpoint: string): Promise<boolean> => new Promise(resolve => {
  const socket = new Socket(), timer = setTimeout(() => { socket.destroy(); resolve(false); }, 1000);
  socket.once("connect", () => { clearTimeout(timer); socket.destroy(); resolve(false); });
  socket.once("error", (error: NodeJS.ErrnoException) => { clearTimeout(timer); socket.destroy(); resolve(error.code === "ENOENT" || error.code === "ECONNREFUSED"); });
  socket.connect(herdrIpcAddress(endpoint));
});

export const runHerdrToolPlatform = async (agent: "codex" | "copilot", argumentRoundTrip = false) => {
  if (argumentRoundTrip) assert.equal(process.platform, "win32");
  assert.equal(process.versions.node.split(".")[0], "24", "Real Herdr acceptance requires a Node24 driver.");
  const systemEnvironment = platformSystemEnvironment(process.env);
  const binary = argumentRoundTrip ? process.execPath : process.env[agent === "codex" ? "DAYNIGHT_TEST_CODEX" : "DAYNIGHT_TEST_COPILOT"];
  const herdrBinary = process.env.DAYNIGHT_TEST_HERDR;
  if (!binary || !herdrBinary || !path.isAbsolute(binary) || !path.isAbsolute(herdrBinary)) throw new Error("Selected real Herdr validation requires absolute DAYNIGHT_TEST_HERDR, DAYNIGHT_TEST_CODEX and DAYNIGHT_TEST_COPILOT paths.");
  // The actual compiled helper is an artifact under test, not a fixture replacement.
  const { createWorkerHerdr } = await import(new URL("../../../dist/commands/worker/herdr.js", import.meta.url).href) as typeof import("../../../src/commands/worker/herdr.js");
  const { createHerdrRpcClient } = await import(new URL("../../../dist/commands/worker/herdr/rpc.js", import.meta.url).href) as typeof import("../../../src/commands/worker/herdr/rpc.js");
  const { createToolLaunchMapping } = await import(new URL("../../../dist/commands/worker/herdr/tool-launch.js", import.meta.url).href) as typeof import("../../../src/commands/worker/herdr/tool-launch.js");
  const { createHerdrNativeEnvironment } = await import(new URL("../../../dist/commands/worker/herdr/instance.js", import.meta.url).href) as typeof import("../../../src/commands/worker/herdr/instance.js");
  await mkdir(outputRoot, { recursive: true });
  const root = await mkdtemp(path.join(outputRoot, `formal-${agent}-`)), nonce = randomUUID();
  const link = process.platform !== "win32" ? `/tmp/dn-a0bc-platform-${nonce.slice(0, 8)}` : null;
  const route = link ?? root, home = path.join(root, "home"), cwd = path.join(root, "cwd"), tools = path.join(root, "tools");
  const evidenceFile = path.join(outputRoot, `${argumentRoundTrip ? "argv" : "formal"}-${agent}-${nonce}.json`);
  const evidence: Record<string, any> = { agent, nonce, controlledArgumentRoundTrip: argumentRoundTrip, officialNativeIdentification: !argumentRoundTrip, platform: process.platform, architecture: process.arch, driverNode: { version: process.version, executable: process.execPath }, businessPromptsSent: 0, initialInputAttempts: 0, uiInputsSent: 0, requests: [], cleanup: { windowsQueries: [] }, observations: [], evidenceFile };
  const persist = () => writeFile(evidenceFile, `${JSON.stringify(evidence, null, 2)}\n`);
  const inventory = async (): Promise<{ pid: number; parent: number; token: string }[]> => {
    if (process.platform === "linux") {
      const { readdir } = await import("node:fs/promises");
      const rows = await Promise.all((await readdir("/proc")).filter(name => /^\d+$/.test(name)).map(async name => {
        try { const stat = await readFile(`/proc/${name}/stat`, "utf8"), fields = stat.slice(stat.lastIndexOf(")") + 2).split(" "); return fields[0] === "Z" ? null : { pid: Number(name), parent: Number(fields[1]), token: fields[19]! }; } catch { return null; }
      }));
      return rows.filter((row): row is NonNullable<typeof row> => row !== null);
    }
    if (process.platform === "win32") {
      const powershell = path.join(systemEnvironment.SystemRoot!, "System32/WindowsPowerShell/v1.0/powershell.exe");
      const script = "@(Get-CimInstance Win32_Process | ForEach-Object { @{pid=$_.ProcessId;parent=$_.ParentProcessId;token=$_.CreationDate.ToUniversalTime().Ticks.ToString()} }) | ConvertTo-Json -Compress";
      return JSON.parse((await execute(powershell, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { timeout: 10_000 })).stdout);
    }
    return [];
  };
  let ownedProcessTokens: { pid: number; parent: number; token: string }[] = [];
  const cancellation = new AbortController();
  let cleaning = false;
  const cancel = (signal: string) => { evidence.cancelledSignal = signal; cancellation.abort(new Error(`Platform validation cancelled by ${signal}.`)); process.exitCode = 1; };
  const interrupt = () => cancel("SIGINT"), terminate = () => cancel("SIGTERM");
  process.on("SIGINT", interrupt); process.on("SIGTERM", terminate);
  const operations: ReturnType<typeof createOperation>[] = [];
  const operation = (totalMs = 20_000) => { const result = createOperation({ ...(cleaning ? {} : { signal: cancellation.signal }), limits: { totalMs, requestMs: 10_000 } }); operations.push(result); return result; };
  let adapter: ReturnType<typeof createWorkerHerdr> | undefined, binding: HerdrTaskBinding | undefined, daemonPid: number | undefined, linked = false;
  let preparingWorkspace = false, preparationProbeEnvironment: NodeJS.ProcessEnv | undefined;
  const mac = process.platform === "darwin" ? createMacProcessControl() : null;
  let daemonIdentity: MacProcessIdentity | undefined, originals: MacProcessIdentity[] = [];
  const mock = createServer((request, response) => {
    evidence.requests.push({ method: request.method, url: request.url });
    response.setHeader("content-type", "application/json");
    if (request.method === "GET" && request.url?.includes("models")) response.end(JSON.stringify({ object: "list", data: [{ id: "gpt-5.4", object: "model", created: 0, owned_by: "isolated-platform-test" }] }));
    else { response.statusCode = 501; response.end(JSON.stringify({ error: { message: "The isolated platform provider does not execute model requests." } })); }
  });
  const context = { projectId: randomUUID(), taskId: randomUUID(), claimId: randomUUID(), worktreeId: randomUUID(), cwd, agent };
  try {
    if (link) { await symlink(root, link); linked = true; evidence.shortPathAdaptation = { link, target: root }; }
    for (const directory of [home, cwd, tools, path.join(home, "codex"), path.join(home, "copilot"), path.join(route, "h"), path.join(root, "logs")]) await mkdir(directory, { recursive: true, mode: 0o700 });
    await new Promise<void>(resolve => mock.listen(0, "127.0.0.1", resolve));
    const address = mock.address(); if (address === null || typeof address === "string") throw new Error("The isolated model fixture did not bind TCP.");
    const environment = { ...systemEnvironment };
    Object.assign(environment, { HOME: home, USERPROFILE: home, PATH: `${tools}${path.delimiter}${process.platform === "win32" ? [path.join(environment.SystemRoot!, "System32"), path.join(environment.SystemRoot!, "System32/WindowsPowerShell/v1.0")].join(path.delimiter) : "/usr/bin:/bin"}`, TERM: "xterm-256color", LANG: "en_US.UTF-8", XDG_CONFIG_HOME: path.join(home, "config"), XDG_STATE_HOME: path.join(home, "state"), XDG_CACHE_HOME: path.join(home, "cache"), CODEX_HOME: path.join(home, "codex"), CODEX_SQLITE_HOME: path.join(home, "codex"), COPILOT_HOME: path.join(home, "copilot"), COPILOT_CACHE_HOME: path.join(home, "copilot-cache"), COPILOT_OFFLINE: "true", COPILOT_AUTO_UPDATE: "false", COPILOT_ALLOW_ALL: "true", COPILOT_PROVIDER_BASE_URL: `http://127.0.0.1:${address.port}/v1`, COPILOT_PROVIDER_TYPE: "openai", COPILOT_PROVIDER_API_KEY: "fake-loopback-only", COPILOT_PROVIDER_WIRE_API: "responses", COPILOT_MODEL: "gpt-5.4", PROBE_LOOPBACK_KEY: "fake-loopback-only", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(home, "empty-git-config"), CI: "1" });
    const git = process.env.DAYNIGHT_TEST_GIT ?? (process.platform === "win32" ? (await execute("where.exe", ["git.exe"], { timeout: 5000 })).stdout.trim().split(/\r?\n/)[0]! : "/usr/bin/git");
    if (process.platform === "win32") environment.PATH += `${path.delimiter}${path.dirname(git)}`;
    await execute(git, ["init", "--quiet", cwd], { env: { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: environment.GIT_CONFIG_GLOBAL }, timeout: 5000 });
    if (process.platform !== "win32") {
      await symlink(await realpath(herdrBinary), path.join(tools, "herdr"));
      await symlink(process.execPath, path.join(tools, "node"));
    }
    // Each native executable uses its own private home; no account or credential is copied.
    await writeFile(path.join(home, "codex/config.toml"), `model = "gpt-5.4"\nmodel_provider = "platform_test"\ncheck_for_update_on_startup = false\n[model_providers.platform_test]\nname = "Task-owned loopback"\nbase_url = "http://127.0.0.1:${address.port}/v1"\nwire_api = "responses"\nenv_key = "PROBE_LOOPBACK_KEY"\nrequires_openai_auth = false\n[analytics]\nenabled = false\n[feedback]\nenabled = false\n[features]\nhooks = true\nplugins = false\n`, { mode: 0o600 });
    const launchOperation = operation();
    const launch = await resolveToolLaunch({ tool: agent, context: "herdr", choice: { kind: "path", path: binary }, cwd, workerNode: process.execPath, environment }, launchOperation);
    const herdrLaunch = await resolveToolLaunch({ tool: "herdr", context: "herdr", choice: { kind: "path", path: herdrBinary }, cwd, workerNode: process.execPath, environment }, launchOperation);
    evidence.nativeVersion = (await execute(binary, agent === "copilot" && !argumentRoundTrip ? ["--no-auto-update", "--version"] : ["--version"], { cwd, env: environment, timeout: 10_000 })).stdout.trim();
    evidence.frozenArtifacts = { native: launch.artifacts.map(({ sha256 }) => sha256), herdr: herdrLaunch.artifacts.map(({ sha256 }) => sha256) };
    const configuration: ExecutionConfiguration = { agent, model: "gpt-5.4", args: agent === "codex" ? ["--no-alt-screen"] : ["--disable-client-telemetry", "--disable-builtin-mcps"], recoveryLimit: 0, toolLaunch: launch, herdrLaunch };
    const paths: WorkerPaths = { stateDirectory: root, configFile: path.join(root, "config.yml"), workerDirectory: root, databaseFile: path.join(root, "worker.sqlite"), configurationFile: path.join(root, "worker.json"), lockFile: path.join(root, "worker.lock"), herdrDirectory: path.join(route, "h"), logsDirectory: path.join(root, "logs"), temporaryDirectory: path.join(root, "tmp") };
    preparationProbeEnvironment = { ...createHerdrNativeEnvironment(paths, environment), PATH: environment.PATH };
    adapter = createWorkerHerdr({ paths, homeDirectory: home, environment, agentEnvironment: { PATH: environment.PATH! }, herdrLaunch, readExecutionConfiguration: () => configuration, isolatedRun: process.platform === "darwin", onDaemonSpawn: async pid => { daemonPid = pid; } });
    evidence.ready = await adapter.ensureInstance(operation());
    if (mac && daemonPid) daemonIdentity = await mac.capture(daemonPid, "daemon");
    const rpc = createHerdrRpcClient(adapter.paths.apiEndpoint);
    // Install only Herdr's official integration, in the already isolated native home.
    if (!argumentRoundTrip) {
      evidence.integration = await rpc.request("integration.install", { target: agent }, operation());
      evidence.effectiveHooks = agent === "codex" ? JSON.parse(await readFile(path.join(home, "codex/hooks.json"), "utf8")) : (await execute(binary, ["config", "hooks"], { cwd, env: environment, timeout: 10_000 })).stdout;
      if (agent === "codex") evidence.features = (await execute(binary, ["features", "list"], { cwd, env: environment, timeout: 10_000 })).stdout;
    }
    const startup = adapter.createShellStartup();
    preparingWorkspace = true;
    binding = await adapter.tasks.prepareWorkspace(context, "Real native platform validation", operation(), startup ? { shellNonce: startup.nonce } : undefined);
    preparingWorkspace = false;
    const before = await adapter.tasks.processInfo(context, binding, operation()); evidence.shellBefore = before;
    const preparedMapping = await createToolLaunchMapping({ directory: paths.herdrDirectory, owner: context, launch, nativeEnvironment: environment, existingOnly: true }, operation());
    if (preparedMapping) evidence.preparedProcessJournal = await readFile(path.join(path.dirname(preparedMapping.manifestPath), "processes.json"), "utf8").catch(() => null);
    if (mac) evidence.shellIdentityBefore = await mac.capture(before.shellPid, "shell", startup ? { executable: startup.executable, operation: operation(), ready: () => startup.isReady(before.shellPid) } : undefined);
    const shellTokenBefore = (await inventory()).find(process => process.pid === before.shellPid);
    if (argumentRoundTrip) {
      assert.ok(preparedMapping?.windowsCommand);
      const script = path.join(root, "argument-capture.mjs"), output = path.join(root, "captured-arguments.json");
      await writeFile(script, `import {writeFile} from 'node:fs/promises';await writeFile(${JSON.stringify(output)}, JSON.stringify({args:process.argv.slice(2),pid:process.pid,parent:process.ppid,executable:process.execPath,version:process.version,tty:{stdin:process.stdin.isTTY===true,stdout:process.stdout.isTTY===true,stderr:process.stderr.isTTY===true}}));setInterval(()=>{},1000);`);
      const args = ["", "plain", "two words", "中文", "quote\"inside", "single'inside", "slash\\tail\\", "$dollar;`tick&pipe|<>", "\\\\server\\share", "ends\\\""];
      evidence.expectedArguments = args;
      // This controlled Node child proves argument transport, never official agent detection or Session identity.
      evidence.controlledStart = await rpc.request("agent.start", { pane_id: binding.paneId, name: herdrExecutionAgentName(context), kind: agent, args: [script, ...args], timeout_ms: 20_000 }, operation(25_000));
      const deadline = Date.now() + 10_000;
      while (true) {
        try { evidence.argumentRoundTrip = JSON.parse(await readFile(output, "utf8")); break; }
        catch (error) { if (Date.now() >= deadline) throw error; await delay(50); }
      }
      assert.deepEqual(evidence.argumentRoundTrip.args, args);
      assert.equal(evidence.argumentRoundTrip.executable.toLowerCase(), process.execPath.toLowerCase());
      assert.match(evidence.argumentRoundTrip.version, /^v24\./);
      assert.deepEqual(evidence.argumentRoundTrip.tty, { stdin: true, stdout: true, stderr: true });
      const receipt = await preparedMapping.readReceipt(operation());
      assert.ok(receipt);
      assert.equal(receipt.childPid, evidence.argumentRoundTrip.pid);
      assert.equal(receipt.helperPid, evidence.argumentRoundTrip.parent);
      evidence.receipt = receipt;
      await preparedMapping.verifyReceipt([script, ...args], operation());
      await preparedMapping.verifyProcesses({ shellPid: before.shellPid, receipt }, operation());
      const powershell = path.join(environment.SystemRoot!, "System32/WindowsPowerShell/v1.0/powershell.exe");
      const source = path.join(path.dirname(preparedMapping.manifestPath), "codex.ps1"), scriptCommand = windowsExternalScriptQuery(source);
      evidence.externalScript = decodeWindowsExternalScript(await runWindowsPlatformQuery("external-script", { file: powershell, args: ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(scriptCommand, "utf16le").toString("base64")], environment }, operation(), evidence.cleanup.windowsQueries), evidence.cleanup.windowsQueries);
      if (evidence.externalScript.type !== "ExternalScript" || evidence.externalScript.source !== source || !/^5\.1\./.test(evidence.externalScript.version)) {
        evidence.cleanup.windowsQueries.at(-1).errorType = "IdentityMismatch";
        throw new Error("The independent ExternalScript proof does not match the original PS5 mapping.");
      }
      evidence.windowsRootCommand = preparedMapping.windowsCommand;
      evidence.originalShellPreserved = (await adapter.tasks.processInfo(context, binding, operation())).shellPid === before.shellPid;
      evidence.launch = launch;
      return evidence;
    }
    evidence.observation = await adapter.tasks.launch(context, binding, { configuration }, operation(30_000));
    const mapping = await createToolLaunchMapping({ directory: paths.herdrDirectory, owner: context, launch, nativeEnvironment: environment, existingOnly: true }, operation());
    if (!mapping) throw new Error("The production facade did not preserve its original mapping.");
    const receipt = await mapping.readReceipt(operation()); if (!receipt) throw new Error("The production helper produced no native launch receipt."); evidence.receipt = receipt;
    for (let index = 0; index < 4; index++) {
      const snapshot = await rpc.request("session.snapshot", {}, operation());
      const data = snapshot.snapshot as { panes: Record<string, unknown>[]; agents: Record<string, unknown>[] };
      evidence.observations.push({ pane: data.panes.find(pane => pane.pane_id === binding!.paneId), agents: data.agents.filter(agent => agent.pane_id === binding!.paneId), process: await rpc.request("pane.process_info", { pane_id: binding.paneId }, operation()), screen: await rpc.request("pane.read", { pane_id: binding.paneId, source: "visible", format: "text", strip_ansi: true }, operation()) });
      evidence.observation = await adapter.tasks.observe(context, binding, operation());
      if (evidence.observation.nativeSession) break;
      await delay(250);
    }
    if (mac) {
      evidence.shellIdentityAfter = await mac.capture(before.shellPid, "shell");
      originals = await mac.list({ rootPids: [daemonPid!], sessionIds: [] });
    }
    if (process.platform !== "win32") {
      evidence.processRows = (await execute("/bin/ps", ["-ww", "-p", [before.shellPid, receipt.helperPid, receipt.childPid].join(","), "-o", "pid=,ppid=,pgid=,tty=,args="], { timeout: 3000 })).stdout;
      if (process.platform === "linux") evidence.nativeFileDescriptors = await Promise.all([0, 1, 2].map(fd => realpath(`/proc/${receipt.childPid}/fd/${fd}`)));
    } else {
      const observerEnvironment = await prepareWindowsObserverEnvironment(root, process.env);
      const powershell = path.join(environment.SystemRoot!, "System32/WindowsPowerShell/v1.0/powershell.exe");
      const processTargets = [before.shellPid, receipt.helperPid, receipt.childPid];
      const script = windowsProcessQuery(processTargets);
      evidence.windowsProcesses = decodeWindowsProcessQuery(await runWindowsPlatformQuery("processes", { file: powershell, args: ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], environment: observerEnvironment }, operation(), evidence.cleanup.windowsQueries), processTargets, evidence.cleanup.windowsQueries);
      evidence.windowsRootCommand = mapping.windowsCommand;
      const consoleScript = windowsConsoleQuery(receipt.childPid);
      evidence.windowsConsole = decodeWindowsConsoleQuery(await runWindowsPlatformQuery("console", { file: powershell, args: ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(consoleScript, "utf16le").toString("base64")], environment: observerEnvironment }, operation(), evidence.cleanup.windowsQueries), processTargets, evidence.cleanup.windowsQueries);
    }
    evidence.launch = launch; evidence.herdrLaunch = herdrLaunch;
    const allProcesses = await inventory(), descendants = new Set([daemonPid!, before.shellPid, receipt.helperPid, receipt.childPid]);
    for (let changed = true; changed;) { changed = false; for (const process of allProcesses) if (descendants.has(process.parent) && !descendants.has(process.pid)) { descendants.add(process.pid); changed = true; } }
    ownedProcessTokens = allProcesses.filter(process => descendants.has(process.pid));
    if (process.platform !== "darwin") {
      assert.ok(shellTokenBefore, "The original shell must have an OS start token.");
      assert.deepEqual(allProcesses.find(process => process.pid === before.shellPid), shellTokenBefore);
      evidence.shellIdentityPreserved = true;
    }
    evidence.beforeInitialInput = evidence.observation;
    assert.equal(evidence.observation.kind, agent);
    assert.equal(evidence.observation.status, "idle");
    assert.equal(evidence.observation.interactiveReady, true);
    assert.equal(evidence.observation.launchPending, false);
    assert.equal(receipt.file, launch.command.file);
    assert.deepEqual(receipt.prefixArgs, launch.command.prefixArgs);
    const prior = evidence.observations.at(-1);
    assert.equal(prior.pane.workspace_id, binding.workspaceId);
    assert.equal(prior.pane.terminal_id, binding.terminalId);
    assert.ok(prior.process.process_info.foreground_processes.some((process: { pid: number }) => process.pid === receipt.childPid));
    if (mac) {
      assert.deepEqual(evidence.shellIdentityAfter, evidence.shellIdentityBefore);
      evidence.nativeIdentityBefore = await mac.capture(receipt.childPid, "agent");
      evidence.helperIdentityBefore = await mac.capture(receipt.helperPid, "agent");
    }
    if (process.platform !== "win32") {
      const rows = evidence.processRows.trim().split("\n").map((row: string) => row.trim().split(/\s+/));
      assert.equal(rows.length, 3);
      assert.equal(new Set(rows.map((row: string[]) => row[3])).size, 1);
      assert.ok(rows.every((row: string[]) => !["?", "??", "-"].includes(row[3]!)));
      assert.equal(Number(rows.find((row: string[]) => Number(row[0]) === receipt.helperPid)[1]), before.shellPid);
      assert.equal(Number(rows.find((row: string[]) => Number(row[0]) === receipt.childPid)[1]), receipt.helperPid);
      const foreground = prior.process.process_info.foreground_process_group_id;
      assert.ok(rows.filter((row: string[]) => Number(row[0]) !== before.shellPid).every((row: string[]) => Number(row[2]) === foreground));
      evidence.helperExecutable = process.platform === "linux" ? await realpath(`/proc/${receipt.helperPid}/exe`) : (await execute("/bin/ps", ["-p", String(receipt.helperPid), "-o", "comm="], { timeout: 3000 })).stdout.trim();
      assert.equal(await realpath(evidence.helperExecutable), await realpath(process.execPath));
      evidence.nativeExecutable = process.platform === "linux" ? await realpath(`/proc/${receipt.childPid}/exe`) : (await execute("/bin/ps", ["-p", String(receipt.childPid), "-o", "comm="], { timeout: 3000 })).stdout.trim();
      assert.equal(await realpath(evidence.nativeExecutable), await realpath(receipt.file));
      if (process.platform === "linux") assert.ok(evidence.nativeFileDescriptors.every((file: string) => /^\/dev\/pts\/\d+$/.test(file)));
    } else {
      assert.match(evidence.windowsProcesses.version, /^5\.1\./);
      const processes = evidence.windowsProcesses.processes;
      // Both independent WMI observations retain microsecond precision. These
      // tokens are not the production readiness reader's 100 ns FILETIME proof.
      for (const row of processes) assert.equal(row.CreationDateTicks, allProcesses.find(process => process.pid === row.ProcessId)?.token, "The independent WMI process birth must match its original inventory identity.");
      assert.equal(processes.find((process: any) => process.ProcessId === before.shellPid).ExecutablePath.toLowerCase(), mapping.windowsCommand![0]!.toLowerCase());
      evidence.nativeExecutable = processes.find((process: any) => process.ProcessId === receipt.childPid).ExecutablePath;
      assert.equal(evidence.nativeExecutable.toLowerCase(), receipt.file.toLowerCase());
      assert.equal(processes.find((process: any) => process.ProcessId === receipt.helperPid).ParentProcessId, before.shellPid);
      assert.equal(processes.find((process: any) => process.ProcessId === receipt.childPid).ParentProcessId, receipt.helperPid);
      evidence.helperExecutable = processes.find((process: any) => process.ProcessId === receipt.helperPid).ExecutablePath;
      assert.equal(evidence.helperExecutable.toLowerCase(), process.execPath.toLowerCase());
      assert.ok([before.shellPid, receipt.helperPid, receipt.childPid].every(pid => evidence.windowsConsole.processIds.includes(pid)), "The original shell/helper/native must share the native console.");
    }
    evidence.processProofCompleted = true;
    evidence.requestsBeforeInitialInput = [...evidence.requests];
    // Persist the attempt before transport: an unknown result must never replay input.
    cancellation.signal.throwIfAborted();
    assert.equal(evidence.initialInputAttempts, 0);
    evidence.initialInputAttempts++;
    await persist();
    evidence.initialInputReceipt = await adapter.tasks.submitInitialPrompt(context, binding, "Reply OK. This is an isolated platform acceptance check.", operation(15_000));
    assert.equal(evidence.initialInputReceipt.submission, "submitted");
    const identityDeadline = Date.now() + 15_000;
    while (true) {
      evidence.observation = await adapter.tasks.observe(context, binding, operation());
      if (evidence.observation.nativeSession) break;
      if (Date.now() >= identityDeadline) throw new Error("The original official hook did not identify its native Session after the single initial input.");
      await delay(100);
    }
    evidence.receiptAfterInitialInput = await mapping.readReceipt(operation());
    assert.deepEqual(evidence.receiptAfterInitialInput, receipt);
    assert.deepEqual(evidence.observation.binding, binding);
    if (process.platform !== "darwin") assert.deepEqual((await inventory()).find(process => process.pid === before.shellPid), shellTokenBefore);
    evidence.processAfterInitialInput = await rpc.request("pane.process_info", { pane_id: binding.paneId }, operation());
    assert.equal(evidence.processAfterInitialInput.process_info.shell_pid, before.shellPid);
    assert.ok(evidence.processAfterInitialInput.process_info.foreground_processes.some((process: { pid: number }) => process.pid === receipt.childPid));
    if (mac) {
      assert.deepEqual(await mac.capture(before.shellPid, "shell"), evidence.shellIdentityBefore);
      assert.equal(await mac.observe(evidence.nativeIdentityBefore), "same");
      assert.equal(await mac.observe(evidence.helperIdentityBefore), "same");
    } else {
      const current = await inventory();
      for (const pid of [receipt.helperPid, receipt.childPid]) assert.deepEqual(current.find(process => process.pid === pid), ownedProcessTokens.find(process => process.pid === pid));
    }
    evidence.sameOriginalNativeAfterInput = true;
    evidence.afterInitialInput = await rpc.request("session.snapshot", {}, operation());
  } catch (error) { evidence.error = errorText(error); }
  finally {
    cleaning = true;
    if (adapter) {
      if (process.platform !== "darwin") {
        try {
          const processes = await inventory(), descendants = new Set([daemonPid!, evidence.shellBefore?.shellPid, evidence.receipt?.helperPid, evidence.receipt?.childPid].filter((pid): pid is number => typeof pid === "number"));
          for (let changed = true; changed;) { changed = false; for (const process of processes) if (descendants.has(process.parent) && !descendants.has(process.pid)) { descendants.add(process.pid); changed = true; } }
          for (const process of processes) if (descendants.has(process.pid) && !ownedProcessTokens.some(original => original.pid === process.pid && original.token === process.token)) ownedProcessTokens.push(process);
          evidence.cleanup.processCapture = { stage: "before-stop", roots: [daemonPid, evidence.shellBefore?.shellPid, evidence.receipt?.helperPid, evidence.receipt?.childPid].filter((pid): pid is number => typeof pid === "number"), processes: ownedProcessTokens.map(process => ({ pid: process.pid, parentPid: process.parent, startToken: process.token })) };
        } catch (error) { evidence.cleanup.captureError = errorText(error); }
      }
      if (mac && daemonPid) {
        try { originals = await mac.list({ rootPids: [daemonPid], sessionIds: [] }); daemonIdentity ??= await mac.capture(daemonPid, "daemon"); }
        catch (error) { evidence.cleanup.captureError = errorText(error); }
      }
      if (binding) {
        try { await adapter.tasks.stopAndClose(context, binding, operation(12_000)); evidence.cleanup.workspaceClosed = true; } catch (error) { evidence.cleanup.workspaceError = errorText(error); }
      } else evidence.cleanup.workspaceNotAttempted = "The original workspace binding was not confirmed.";
      try { evidence.cleanup.instance = await adapter.stopInstance(operation(12_000)); } catch (error) { evidence.cleanup.instanceError = errorText(error); }
      if (mac && daemonIdentity) {
        const remaining = await Promise.all(originals.map(async identity => ({ pid: identity.pid, observation: await mac.observe(identity) })));
        evidence.cleanup.originalProcesses = remaining;
        if (remaining.some(process => process.observation !== "exited")) {
          evidence.cleanup.exclusiveStop = await mac.stopExclusiveRun({ daemon: daemonIdentity, processes: originals.filter(process => process.pid !== daemonPid).map(process => ({ ...process, role: process.pid === evidence.shellBefore?.shellPid ? "shell" : "agent" })), onDiscovered: async process => { evidence.cleanup.discovered ??= []; evidence.cleanup.discovered.push(process); await persist(); } }, operation(12_000));
        }
      }
      if (process.platform !== "darwin") {
        try {
          const deadline = Date.now() + 5000;
          let alive: typeof ownedProcessTokens;
          do { const current = await inventory(); alive = ownedProcessTokens.filter(original => current.some(process => process.pid === original.pid && process.token === original.token)); if (alive.length) await delay(100); } while (alive.length && Date.now() < deadline);
          evidence.cleanup.originalProcesses = ownedProcessTokens.map(original => ({ pid: original.pid, parentPid: original.parent, startToken: original.token, stage: "after-stop", observation: alive.some(process => process.pid === original.pid) ? "running" : "exited" }));
        } catch (error) { evidence.cleanup.processReadbackError = errorText(error); }
      }
      evidence.cleanup.apiClosed = await closedEndpoint(adapter.paths.apiEndpoint); evidence.cleanup.clientClosed = await closedEndpoint(adapter.paths.clientEndpoint);
    }
    await new Promise<void>(resolve => mock.close(() => resolve())); evidence.cleanup.mockClosed = true;
    if (linked) { await unlink(link!); evidence.cleanup.shortLinkRemoved = true; }
    operations.forEach(operation => operation.dispose());
    let closed = (!adapter || evidence.cleanup.instance?.ownedChildClosed === true && evidence.cleanup.apiClosed && evidence.cleanup.clientClosed && !evidence.cleanup.captureError && !evidence.cleanup.processReadbackError && evidence.cleanup.originalProcesses?.every((process: { observation: string }) => process.observation === "exited")) && evidence.cleanup.windowsQueries.every((query: { closed: boolean; cleanupConfirmed: boolean }) => query.closed && query.cleanupConfirmed);
    if (closed && adapter && preparingWorkspace && evidence.error && process.platform === "win32" && !cancellation.signal.aborted && preparationProbeEnvironment && !windowsPreparationProbeAttempted) {
      windowsPreparationProbeAttempted = true;
      try {
        const inventory = historicalWindowsInventoryCommand(preparationProbeEnvironment);
        const marker = { ...inventory, args: ["-NoProfile", "-NoLogo", "-NonInteractive", "-Command", `[Console]::Out.Write('${preparationProbeMarker}')`] };
        evidence.cleanup.preparationProbes = await runPreparationProbeSequence({ marker, inventory }, async (mode, input, active) => {
          if (mode === "execFile") return executeRawPreparationProbe(input);
          return executeHistoricalMetadataProbe(mode, input, active);
        }, () => cancellation.signal.aborted);
        if (evidence.cleanup.preparationProbes.some((probe: { closed: boolean }) => !probe.closed)) closed = false;
      } catch (error) { evidence.cleanup.preparationProbeSetupError = error instanceof Error ? error.name : "unknown"; closed = false; }
    }
    if (closed) { await rm(root, { recursive: true, force: true }); evidence.cleanup.runtimeDirectoryRemoved = true; }
    else evidence.cleanup.retainedDirectory = root;
    process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", terminate);
    await persist();
    const summary = { schemaVersion: 1, agent, controlledArgumentRoundTrip: argumentRoundTrip, officialNativeIdentification: !argumentRoundTrip, nativeVersion: evidence.nativeVersion, frozenArtifacts: evidence.frozenArtifacts, expectedArguments: evidence.expectedArguments, argumentRoundTrip: evidence.argumentRoundTrip, externalScript: evidence.externalScript, originalShellPreserved: evidence.originalShellPreserved, platform: process.platform, architecture: process.arch, driverNode: evidence.driverNode, helperExecutable: evidence.helperExecutable, endpoints: adapter ? { api: adapter.paths.apiEndpoint, client: adapter.paths.clientEndpoint } : null, shortLink: link, daemonPid, shellPid: evidence.shellBefore?.shellPid, receipt: evidence.receipt ? { helperPid: evidence.receipt.helperPid, childPid: evidence.receipt.childPid, executable: path.basename(evidence.receipt.file) } : null, processProofCompleted: evidence.processProofCompleted, sameOriginalNativeAfterInput: evidence.sameOriginalNativeAfterInput, beforeInitialInput: evidence.beforeInitialInput, initialInputAttempts: evidence.initialInputAttempts, initialInputReceipt: evidence.initialInputReceipt, observation: evidence.observation, requestsBeforeInitialInput: evidence.requestsBeforeInitialInput, requests: evidence.requests, cleanup: evidence.cleanup, error: evidence.error };
    await writeFile(path.join(outputRoot, `acceptance-${argumentRoundTrip ? "argv-" : ""}${agent}-${nonce}.json`), `${JSON.stringify(summary, null, 2)}\n`);
  }
  return evidence;
};
