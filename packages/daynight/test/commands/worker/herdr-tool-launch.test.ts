import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOperation, type Operation } from "../../../src/api/operation.js";
import { resolveToolLaunch } from "../../../src/platform/tool-executables.js";
import { inspectControllerJob } from "../../../src/commands/controller/windows-job.js";
import { createToolLaunchMapping, posixToolMappingRc } from "../../../src/commands/worker/herdr/tool-launch.js";
import * as launchInventory from "../../../src/commands/worker/herdr/tool-launch-inventory.js";
import { advanceToolStartRequest, reserveToolStartRequest } from "../../../src/commands/worker/herdr/tool-launch-start.js";
import { captureMappingProcessProof, parseLinuxProcessBirth } from "../../../src/commands/worker/herdr/tool-launch-process-proof.js";
import { parseWindowsMappingProcessInventory, windowsMappingProcessInventoryCommand } from "../../../src/commands/worker/herdr/tool-launch-lifecycle.js";
import { hasUnconfirmedHerdrCommandCleanup, runHerdrCommand } from "../../../src/commands/worker/herdr/command.js";
import * as commands from "../../../src/commands/worker/herdr/command.js";
import * as processProofs from "../../../src/commands/worker/herdr/tool-launch-process-proof.js";
import * as windowsJobs from "../../../src/commands/controller/windows-job.js";

const roots: string[] = [], operations: Operation[] = [];
const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
const operation = (): Operation => { const value = createOperation({ limits: { totalMs: 10_000 } }); operations.push(value); return value; };
const owner = { projectId: "00000000-0000-4000-8000-000000000001", taskId: "00000000-0000-4000-8000-000000000002", claimId: "00000000-0000-4000-8000-000000000003", worktreeId: "00000000-0000-4000-8000-000000000004" };
const childEntry = path.resolve(import.meta.dirname, "../../../dist/commands/worker/herdr/tool-launch-child.js");
const fixture = async (platform?: NodeJS.Platform) => {
  const scratch = path.resolve(import.meta.dirname, "../../../../../.tmp/herdr-tools/mapping-tests");
  await mkdir(scratch, { recursive: true });
  const directory = await mkdtemp(path.join(scratch, "owner ' $; 中文-")); roots.push(directory);
  const launch = await resolveToolLaunch({ tool: "codex", context: "herdr", choice: { kind: "path", path: process.execPath }, environment: process.env, cwd: directory }, operation());
  const input = { directory, owner, launch, nativeEnvironment: { ...process.env, ...(platform === "win32" ? { SystemRoot: process.env.SystemRoot ?? "C:\\Windows" } : {}), PATH: "/native/path", CODEX_HOME: "/native/home" }, childEntry, ...(platform === undefined ? {} : { platform }) };
  const mapping = await createToolLaunchMapping(input, operation());
  if (mapping === null) throw new Error("A new mapping was not created.");
  return { directory, launch, input, mapping };
};
const execute = async (file: string, args: string[], environment = process.env) => {
  const child = spawn(file, args, { env: environment, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
  const timer = setTimeout(() => child.kill("SIGKILL"), 8_000);
  try { const [code, signal] = await once(child, "close"); return { code, signal, stdout, stderr, pid: child.pid }; }
  finally { clearTimeout(timer); }
};
const windowsInventoryDiagnostics = async (environment: NodeJS.ProcessEnv) => {
  const command = windowsMappingProcessInventoryCommand(environment), prefix = command.args.slice(0, -2);
  const marker = "$ErrorActionPreference='Stop'; [Console]::Out.Write('daynight-stdout'); [Console]::Error.Write('daynight-stderr'); Write-Output 'daynight-pipeline'";
  const args = (script: string, encoded = false): string[] => [...prefix, encoded ? "-EncodedCommand" : "-Command", encoded ? Buffer.from(script, "utf16le").toString("base64") : script];
  const results: Record<string, unknown> = {};
  let cleanupUnconfirmed = false;
  const probe = async (name: string, run: () => Promise<{ stdout: string; stderr: string; code?: number | null; signal?: string | null }>, inventory = false) => {
    if (cleanupUnconfirmed) { results[name] = { skipped: "An earlier probe has unconfirmed cleanup." }; return; }
    try {
      const result = await run();
      let output: unknown = result.stdout.slice(0, 256);
      if (inventory) {
        try { const rows = parseWindowsMappingProcessInventory(result.stdout, result.stderr); output = { count: rows.length, containsCurrentProcess: rows.some(row => row.pid === process.pid) }; }
        catch (error) { output = error instanceof Error ? error.message : String(error); }
      }
      results[name] = { code: result.code === undefined ? 0 : result.code, signal: result.signal ?? null, stdoutBytes: Buffer.byteLength(result.stdout), stderrBytes: Buffer.byteLength(result.stderr), output, stderr: result.stderr.slice(0, 2048) };
    } catch (error) {
      cleanupUnconfirmed = hasUnconfirmedHerdrCommandCleanup(error);
      if (!(error instanceof Error)) { results[name] = { error: String(error), cleanupUnconfirmed }; return; }
      const details = error as Error & Record<string, unknown>;
      const metadata: Record<string, unknown> = {};
      for (const key of ["code", "exitCode", "signal", "killed"] as const) if (key in details) metadata[key] = details[key];
      for (const key of ["stdout", "stderr"] as const) if (typeof details[key] === "string") {
        const output = details[key];
        metadata[`${key}Bytes`] = Buffer.byteLength(output);
        if (key === "stderr") metadata.stderr = output.slice(0, 2048);
      }
      results[name] = { name: error.name, message: error.message.slice(0, 2048), cleanupUnconfirmed, ...metadata };
    }
  };
  const runner = async (commandArgs: readonly string[]) => {
    const budget = createOperation({ limits: { totalMs: 4000, requestMs: 2500 } });
    try { return await runHerdrCommand({ ...command, args: commandArgs }, budget, undefined, { cleanupWithinDeadline: true }); }
    finally { budget.dispose(); }
  };
  const direct = (commandArgs: readonly string[]) => new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    execFile(command.file, commandArgs, { env: command.environment, windowsHide: true, timeout: 2500, killSignal: "SIGKILL", maxBuffer: 64 * 1024, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error !== null) reject(Object.assign(error, { stdout, stderr }));
      else resolve({ stdout, stderr });
    });
  });
  const rawSpawn = async (detached: boolean, stdin: "ignore" | "pipe") => {
    const child = spawn(command.file, args(marker), { env: command.environment, detached, windowsHide: true, stdio: [stdin, "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout!.on("data", chunk => { stdout += chunk; }); child.stderr!.on("data", chunk => { stderr += chunk; });
    child.stdin?.end();
    const timer = setTimeout(() => child.kill("SIGKILL"), 2500);
    try { const [code, signal] = await once(child, "close"); return { code: code as number | null, signal: signal as string | null, stdout, stderr }; }
    finally { clearTimeout(timer); }
  };
  // Only fixed markers, PID/PPID output summaries and bounded errors are recorded.
  // A working alternate probe does not replace the original production failure.
  await probe("runner-command-marker", () => runner(args(marker)));
  await probe("runner-encoded-marker", () => runner(args(marker, true)));
  await probe("spawn-detached-ignore-marker", () => rawSpawn(true, "ignore"));
  await probe("spawn-attached-ignore-marker", () => rawSpawn(false, "ignore"));
  await probe("spawn-detached-pipe-marker", () => rawSpawn(true, "pipe"));
  await probe("execFile-command-marker", () => direct(args(marker)));
  await probe("execFile-encoded-marker", () => direct(args(marker, true)));
  await probe("runner-encoded-inventory", () => runner(args(command.args.at(-1)!, true)), true);
  await probe("execFile-command-inventory", () => direct(command.args), true);
  await probe("execFile-encoded-inventory", () => direct(args(command.args.at(-1)!, true)), true);
  return results;
};
afterEach(async () => { Object.defineProperty(process, "platform", platformDescriptor); vi.restoreAllMocks(); operations.splice(0).forEach(value => value.dispose()); await Promise.all(roots.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

const windowsProof = (pid: number, parentPid: number, startedAt: string): processProofs.MappingProcessProof => ({ pid, parentPid, processGroupId: null, startedAt, commandHash: "a".repeat(64) });
const windowsTree = async (proofs: processProofs.MappingProcessProof[], rows = proofs) => {
  const f = await fixture("win32");
  Object.defineProperty(process, "platform", { ...platformDescriptor, value: "win32" });
  const capture = vi.spyOn(processProofs, "captureMappingProcessProof").mockImplementation(async id => {
    const proof = proofs.find(value => value.pid === id);
    if (proof === undefined) throw new Error("An unexpected process proof was requested.");
    return { ...proof };
  });
  vi.spyOn(processProofs, "inspectMappingProcessForCleanup").mockResolvedValue("running");
  const query = vi.spyOn(commands, "runHerdrCommand").mockResolvedValue({ stdout: JSON.stringify(rows.map(row => ({ ProcessId: row.pid, ParentProcessId: row.parentPid }))), stderr: "" });
  return { ...f, capture, query, journal: path.join(path.dirname(f.mapping.manifestPath), "processes.json") };
};
const controlledReceipt = (f: Awaited<ReturnType<typeof fixture>>, helperPid: number, childPid: number) => ({ schemaVersion: 1 as const, owner, nonce: f.mapping.nonce, selectionKey: f.mapping.selectionKey, logicalArgvDigest: "b".repeat(64), file: f.launch.command.file, prefixArgs: [...f.launch.command.prefixArgs], helperPid, childPid });

describe("owned Herdr launch mapping", () => {
  it.each(["inventory", "readiness"] as const)("keeps Windows %s metadata attached while the owned command runner joins its output", async consumer => {
    const f = await fixture("win32"), shell = windowsProof(501, 1, "2026-11-12T00:00:00.1234000Z");
    const output = consumer === "inventory" ? JSON.stringify([{ ProcessId: 501, ParentProcessId: 1 }]) : JSON.stringify({ executable: f.mapping.windowsCommand![0], startToken: "123456789" });
    const start = vi.spyOn(commands, "spawnHerdrProcess").mockImplementation((_file, _args, options) => spawn(process.execPath, ["-e", `process.stdout.write(${JSON.stringify(options.detached === false ? output : "")})`], options));
    const runner = commands.runHerdrCommand;
    vi.spyOn(commands, "runHerdrCommand").mockImplementation((command, active, provided, options) => runner(command, active, provided ?? start, options));
    if (consumer === "readiness") await writeFile(path.join(path.dirname(f.mapping.manifestPath), "shell-ready.json"), JSON.stringify({ nonce: f.mapping.nonce, pid: shell.pid, executable: f.mapping.windowsCommand![0], startToken: "123456789" }), { mode: 0o600 });
    Object.defineProperty(process, "platform", { ...platformDescriptor, value: "win32" });
    vi.spyOn(processProofs, "captureMappingProcessProof").mockResolvedValue(shell);
    vi.spyOn(processProofs, "inspectMappingProcessForCleanup").mockResolvedValue("running");
    if (consumer === "inventory") expect(await f.mapping.captureProcesses([shell.pid], operation())).toEqual([shell.pid]);
    else await f.mapping.verifyReady(shell.pid, operation());
    expect(start).toHaveBeenCalledOnce();
    expect(start.mock.calls[0]![2]).toMatchObject({ detached: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  });

  it.each(["2026-11-12T00:00:00.1233000Z", "2026-11-12T00:00:00.1234000Z", "unproved-birth"])("does not register a Windows descendant without strictly later birth (%s)", async startedAt => {
    const root = windowsProof(501, 1, "2026-11-12T00:00:00.1234000Z"), child = windowsProof(502, root.pid, startedAt), f = await windowsTree([root, child]);
    await expect(f.mapping.captureProcesses([root.pid], operation())).rejects.toThrow(/birth|parent/);
    expect(JSON.parse(await readFile(f.journal, "utf8")).proofs).toEqual([root]);
  });

  it.each(["prepare", "cleanup"] as const)("does not register an unrelated foreground PID using its stale Windows PPID during %s", async phase => {
    const root = windowsProof(501, 1, "2026-11-12T00:00:00.1234000Z"), child = windowsProof(502, root.pid, "2026-11-12T00:00:00.1233000Z"), f = await windowsTree([root, child]);
    if (phase === "cleanup") await writeFile(f.journal, JSON.stringify({ nonce: f.mapping.nonce, proofs: [root] }), { mode: 0o600 });
    await expect(f.mapping.captureProcesses(phase === "cleanup" ? [child.pid] : [root.pid, child.pid], operation(), phase === "cleanup")).rejects.toThrow(/birth|parent/);
    expect(JSON.parse(await readFile(f.journal, "utf8")).proofs).toEqual([root]);
  });

  it("rejects an additional Windows foreground process whose parent is outside the original tree", async () => {
    const root = windowsProof(501, 1, "2026-11-12T00:00:00.1234000Z"), child = windowsProof(502, 999, "2026-11-12T00:00:00.1235000Z"), f = await windowsTree([root, child]);
    await expect(f.mapping.captureProcesses([root.pid, child.pid], operation())).rejects.toThrow(/parent/);
    expect(JSON.parse(await readFile(f.journal, "utf8")).proofs).toEqual([root]);
  });

  it("does not invent a Windows cleanup root from foreground PIDs when the original journal is missing", async () => {
    const root = windowsProof(501, 1, "2026-11-12T00:00:00.1234000Z"), f = await windowsTree([root]);
    await expect(f.mapping.captureProcesses([root.pid], operation(), true)).rejects.toThrow(/root|journal/);
    expect(f.capture).not.toHaveBeenCalled();
    await expect(readFile(f.journal, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["before-replaced", "after-replaced", "before-stopped", "after-stopped", "after-command-changed"])("keeps a Windows candidate unknown when its original parent is %s", async transition => {
    const root = windowsProof(501, 1, "2026-11-12T00:00:00.1234000Z"), child = windowsProof(502, root.pid, "2026-11-12T00:00:00.1235000Z"), f = await windowsTree([root, child]);
    let parents = 0;
    f.capture.mockImplementation(async id => {
      if (id === child.pid) return child;
      const changed = ++parents >= (transition.startsWith("before") ? 2 : 3);
      if (changed && transition.endsWith("stopped")) throw new Error("The controlled parent stopped.");
      if (changed && transition.endsWith("command-changed")) return { ...root, commandHash: "c".repeat(64) };
      return changed ? { ...root, startedAt: "2026-11-12T00:00:00.1236000Z" } : root;
    });
    await expect(f.mapping.captureProcesses([root.pid], operation())).rejects.toThrow(/parent|identity/);
    expect(JSON.parse(await readFile(f.journal, "utf8")).proofs).toEqual([root]);
  });

  it("registers a Windows multilevel tree in parent order despite reversed inventory and foreground rows", async () => {
    const root = windowsProof(501, 1, "2026-11-12T00:00:00.1234000Z"), child = windowsProof(502, root.pid, "2026-11-12T00:00:00.1235000Z"), grandchild = windowsProof(503, child.pid, "2026-11-12T00:00:00.1236000Z"), f = await windowsTree([root, child, grandchild], [grandchild, child, root]);
    expect(await f.mapping.captureProcesses([root.pid, grandchild.pid, child.pid], operation())).toEqual(expect.arrayContaining([root.pid, child.pid, grandchild.pid]));
    expect(JSON.parse(await readFile(f.journal, "utf8")).proofs).toEqual([root, child, grandchild]);
  });

  it("rejects a Windows helper receipt whose process predates the original shell", async () => {
    const root = windowsProof(501, 1, "2026-11-12T00:00:00.1234000Z"), helper = windowsProof(502, root.pid, "2026-11-12T00:00:00.1233000Z"), child = windowsProof(503, helper.pid, "2026-11-12T00:00:00.1235000Z"), f = await windowsTree([root, helper, child]);
    await writeFile(f.journal, JSON.stringify({ nonce: f.mapping.nonce, proofs: [root] }), { mode: 0o600 });
    await expect(f.mapping.verifyProcesses({ shellPid: root.pid, receipt: controlledReceipt(f, helper.pid, child.pid) }, operation())).rejects.toThrow(/birth|parent/);
    expect(JSON.parse(await readFile(f.journal, "utf8")).proofs).toEqual([root]);
  });

  it.each(["older-parent-instance", "equal-birth", "missing-parent"] as const)("preserves an invalid historical Windows responsibility journal without terminating its Job or PIDs (%s)", async invalid => {
    const root = windowsProof(501, 1, "2026-11-12T00:00:00.1234000Z"), helper = windowsProof(502, invalid === "missing-parent" ? 999 : root.pid, invalid === "equal-birth" ? root.startedAt : "2026-11-12T00:00:00.1233000Z"), child = windowsProof(503, helper.pid, "2026-11-12T00:00:00.1235000Z"), f = await windowsTree([root, helper, child]);
    const journal = JSON.stringify({ nonce: f.mapping.nonce, proofs: [root, helper, child] });
    await writeFile(f.journal, journal, { mode: 0o600 });
    const receipt = controlledReceipt(f, helper.pid, child.pid), { childPid: _child, ...intent } = receipt, directory = path.dirname(f.mapping.manifestPath);
    await writeFile(path.join(directory, "launch-intent.json"), JSON.stringify(intent), { mode: 0o600 });
    await writeFile(path.join(directory, "launch-receipt.json"), JSON.stringify(receipt), { mode: 0o600 });
    const alive = new Set([root.pid, helper.pid, child.pid]), job = vi.spyOn(windowsJobs, "inspectControllerJob").mockResolvedValue([]), kill = vi.spyOn(process, "kill").mockImplementation(id => { alive.delete(id); return true; });
    f.query.mockImplementation(async () => ({ stdout: JSON.stringify([... [root, helper, child].filter(row => alive.has(row.pid)).map(row => ({ ProcessId: row.pid, ParentProcessId: row.parentPid })), { ProcessId: 999, ParentProcessId: 1 }]), stderr: "" }));
    await expect(f.mapping.stopProcesses(operation())).rejects.toThrow(/birth|parent/);
    expect(job).not.toHaveBeenCalled(); expect(kill).not.toHaveBeenCalled();
    expect(await readFile(f.journal, "utf8")).toBe(journal);
  });

  it("retains a valid Windows descendant as cleanup responsibility after its original parent exits", async () => {
    const root = windowsProof(501, 1, "2026-11-12T00:00:00.1234000Z"), child = windowsProof(502, root.pid, "2026-11-12T00:00:00.1235000Z"), f = await windowsTree([root, child]);
    await writeFile(f.journal, JSON.stringify({ nonce: f.mapping.nonce, proofs: [root, child] }), { mode: 0o600 });
    vi.mocked(processProofs.inspectMappingProcessForCleanup).mockImplementation(async proof => proof.pid === root.pid ? "stopped" : "running");
    let running = true;
    const kill = vi.spyOn(process, "kill").mockImplementation(() => { running = false; return true; });
    f.query.mockImplementation(async () => ({ stdout: JSON.stringify(running ? [{ ProcessId: child.pid, ParentProcessId: root.pid }] : [{ ProcessId: 999, ParentProcessId: 1 }]), stderr: "" }));
    await f.mapping.stopProcesses(operation());
    expect(kill).toHaveBeenCalledExactlyOnceWith(child.pid, "SIGKILL");
  });
  it("isolates system PowerShell metadata queries from inherited module paths without changing the native environment", () => {
    const environment = { SystemRoot: "C:\\Windows", PSModulePath: "C:\\PowerShell7\\Modules", pSmOdUlEpAtH: "C:\\OtherModules", PATH: "/frozen/native/path", CODEX_HOME: "/native/home" };
    const command = windowsMappingProcessInventoryCommand(environment);
    expect(command.file).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    expect(command.environment).toEqual({ SystemRoot: environment.SystemRoot, PATH: environment.PATH, CODEX_HOME: environment.CODEX_HOME });
    expect(environment.PSModulePath).toBe("C:\\PowerShell7\\Modules");
    expect(environment.pSmOdUlEpAtH).toBe("C:\\OtherModules");
  });

  it.each(["", " \r\n", "null", "[]", "{}", '[{"ProcessId":0,"ParentProcessId":0}]', '[{"ProcessId":2,"ParentProcessId":-1}]', '[{"ProcessId":2,"ParentProcessId":0},{"ProcessId":2,"ParentProcessId":0}]', '[{"ProcessId":"2","ParentProcessId":0}]', '[{"ProcessId":2}]', '[{"ProcessId":2,"ParentProcessId":0}] trailing diagnostic'])("keeps invalid Windows process output unknown: %j", stdout => {
    expect(() => parseWindowsMappingProcessInventory(stdout)).toThrow("Windows process inventory");
  });

  it("accepts complete Windows process arrays and excludes only the idle pseudo-process", () => {
    expect(parseWindowsMappingProcessInventory('[{"ProcessId":0,"ParentProcessId":0},{"ProcessId":12,"ParentProcessId":4},{"ProcessId":4,"ParentProcessId":0}]')).toEqual([{ pid: 12, parentPid: 4, group: null }, { pid: 4, parentPid: 0, group: null }]);
    expect(parseWindowsMappingProcessInventory('[{"ProcessId":12,"ParentProcessId":4}]')).toEqual([{ pid: 12, parentPid: 4, group: null }]);
  });

  it("retains bounded command stderr and the JSON cause when a Windows inventory is incomplete", () => {
    let failure: unknown;
    try { parseWindowsMappingProcessInventory("", `fixed-stderr-marker:${"x".repeat(4096)}:omitted-tail`); }
    catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(Error);
    const error = failure as Error;
    expect(error.cause).toBeInstanceOf(SyntaxError);
    expect(error.message).toContain("stdoutBytes=0");
    expect(error.message).toContain("stderrBytes=4129");
    expect(error.message).toContain("fixed-stderr-marker:");
    expect(error.message).not.toContain("omitted-tail");
    expect(error.message.length).toBeLessThan(2300);
  });

  it.skipIf(process.platform !== "win32")("reads the real Windows process inventory despite inherited incompatible PowerShell module paths", async () => {
    const f = await fixture(), native = spawn(process.execPath, ["-e", "process.stdout.write('ready');setInterval(()=>{},1000);"], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
    const closed = once(native, "close"), timer = setTimeout(() => native.kill("SIGKILL"), 8_000);
    try {
      await once(native.stdout!, "data");
      const environment = { ...f.input.nativeEnvironment, PSModulePath: path.join(f.directory, "incompatible-modules"), pSmOdUlEpAtH: path.join(f.directory, "other-incompatible-modules") };
      const mapping = (await createToolLaunchMapping({ ...f.input, nativeEnvironment: environment, existingOnly: true }, operation()))!;
      try {
        expect(await mapping.captureProcesses([native.pid!], operation())).toContain(native.pid);
        native.kill("SIGKILL"); await closed;
        expect(await mapping.confirmStopped(operation())).toBe(true);
      } catch (cause) { throw new Error(`Windows process inventory command diagnostics: ${JSON.stringify(await windowsInventoryDiagnostics(environment))}`, { cause }); }
      expect(environment.PSModulePath).toBe(path.join(f.directory, "incompatible-modules"));
      expect(environment.PATH).toBe("/native/path");
    } finally { clearTimeout(timer); native.kill("SIGKILL"); await closed; }
  }, 60_000);

  it("distinguishes Linux process births within one wall-clock second and rejects malformed proc identities", () => {
    const boot = "12345678-1234-4234-8234-123456789abc";
    const stat = (start: string) => `23 (native name (child)) S 17 23 23 0 -1 4194304 12 0 0 0 0 0 0 0 20 0 1 0 ${start} 123456 42`;
    expect(parseLinuxProcessBirth(23, stat("567890"), `${boot}\n`)).toEqual({ token: `${boot}:567890`, parentPid: 17, processGroupId: 23 });
    expect(parseLinuxProcessBirth(23, stat("567891"), boot).token).not.toBe(`${boot}:567890`);
    expect(() => parseLinuxProcessBirth(24, stat("567890"), boot)).toThrow();
    expect(() => parseLinuxProcessBirth(23, stat("not-a-token"), boot)).toThrow();
    expect(() => parseLinuxProcessBirth(23, stat("567890"), "unknown-boot")).toThrow();
  });

  it.skipIf(process.platform === "win32")("admits only a native child continuously owned by the original shell and helper", async () => {
    const f = await fixture(), args = ["-e", "process.stdout.write('ready');setInterval(()=>{},1000);"];
    const script = "const {spawn}=require('node:child_process');process.stdin.once('data',()=>{const child=spawn(process.execPath,JSON.parse(process.argv[1]),{stdio:['ignore','inherit','inherit']});child.on('close',code=>process.exit(code??1));});";
    const shell = spawn(process.execPath, ["-e", script, JSON.stringify([childEntry, f.mapping.manifestPath, "codex", "--", ...args])], { detached: true, stdio: ["pipe", "pipe", "pipe"] });
    let errors = ""; shell.stderr!.on("data", chunk => { errors += chunk; });
    const closed = once(shell, "close");
    const kill = () => { try { if (shell.pid !== undefined) process.kill(-shell.pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; } };
    const timer = setTimeout(kill, 4_000);
    try {
      await f.mapping.captureProcesses([shell.pid!], operation());
      const ready = Promise.race([once(shell.stdout!, "data"), closed.then(() => { throw new Error(`The mapped native process exited before readiness: ${errors}`); })]); shell.stdin!.write("go"); await ready;
      const receipt = await f.mapping.verifyReceipt(args, operation());
      await f.mapping.verifyProcesses({ shellPid: shell.pid!, receipt, foregroundPids: [receipt.helperPid, receipt.childPid] }, operation());
      const recovered = (await createToolLaunchMapping({ ...f.input, existingOnly: true }, operation()))!;
      await recovered.verifyProcesses({ shellPid: shell.pid!, receipt }, operation());
      await expect(recovered.verifyProcesses({ shellPid: process.pid, receipt }, operation())).rejects.toThrow("original shell");
      await expect(recovered.verifyProcesses({ shellPid: receipt.helperPid }, operation())).rejects.toThrow("original shell");
      await expect(recovered.verifyProcesses({ shellPid: shell.pid!, receipt, foregroundPids: [process.pid] }, operation())).rejects.toThrow("foreground");
      await expect(recovered.verifyProcesses({ shellPid: shell.pid!, receipt: { ...receipt, helperPid: process.pid } }, operation())).rejects.toThrow("helper");
    } finally { clearTimeout(timer); if (shell.exitCode === null && shell.signalCode === null) kill(); await closed; }
  });

  it.skipIf(process.platform === "win32").each(["intent", "receipt", "helper-only", "native-orphan"] as const)("keeps an orphan launch unknown when its declared roles lack durable birth proofs (%s)", async evidence => {
    const f = await fixture(), args = ["-e", "process.stdout.write('ready');setInterval(()=>{},1000);"];
    const script = "const {spawn}=require('node:child_process');process.stdin.once('data',()=>{spawn(process.execPath,JSON.parse(process.argv[1]),{detached:true,stdio:['ignore','inherit','inherit']});});setInterval(()=>{},1000);";
    const shell = spawn(process.execPath, ["-e", script, JSON.stringify([childEntry, f.mapping.manifestPath, "codex", "--", ...args])], { detached: true, stdio: ["pipe", "pipe", "pipe"] });
    const exited = once(shell, "exit"), closed = once(shell, "close"); let helper: number | undefined;
    const timer = setTimeout(() => { shell.kill("SIGKILL"); if (helper !== undefined) process.kill(-helper, "SIGKILL"); }, 8_000);
    try {
      await f.mapping.captureProcesses([shell.pid!], operation());
      const journal = path.join(path.dirname(f.mapping.manifestPath), "processes.json"); let original = await readFile(journal, "utf8");
      const ready = once(shell.stdout!, "data"); shell.stdin!.write("go"); await ready;
      const receipt = await f.mapping.verifyReceipt(args, operation()); helper = receipt.helperPid;
      if (evidence === "intent") await rm(path.join(path.dirname(f.mapping.manifestPath), "launch-receipt.json"));
      if (evidence === "helper-only") {
        const partial = JSON.parse(original) as { nonce: string; proofs: unknown[] };
        partial.proofs.push(await captureMappingProcessProof(receipt.helperPid));
        original = JSON.stringify(partial); await writeFile(journal, original, { mode: 0o600 });
      }
      shell.kill("SIGKILL"); await exited;
      if (evidence === "native-orphan") process.kill(receipt.helperPid, "SIGKILL");
      else expect(() => process.kill(receipt.helperPid, 0)).not.toThrow();
      expect(() => process.kill(receipt.childPid, 0)).not.toThrow();
      const recovered = (await createToolLaunchMapping({ ...f.input, existingOnly: true }, operation()))!;
      await expect(recovered.confirmStopped(operation())).rejects.toThrow(/receipt|durable birth proof/);
      await expect(launchInventory.confirmToolLaunchMappingsStopped(f.directory, process.env, operation())).rejects.toThrow(/receipt|durable birth proof/);
      await expect(recovered.retire(operation())).rejects.toThrow(/receipt|durable birth proof/);
      await expect(recovered.stopProcesses(operation())).rejects.toThrow(/receipt|durable birth proof/);
      await expect(recovered.captureProcesses([receipt.helperPid, receipt.childPid], operation(), true)).rejects.toThrow(/receipt|durable birth proof/);
      expect(await readFile(journal, "utf8")).toBe(original);
      if (evidence !== "native-orphan") expect(() => process.kill(receipt.helperPid, 0)).not.toThrow();
      expect(() => process.kill(receipt.childPid, 0)).not.toThrow();
    } finally {
      clearTimeout(timer); shell.kill("SIGKILL");
      if (helper !== undefined) { try { process.kill(-helper, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; } }
      await closed;
    }
  });

  it.skipIf(process.platform === "win32")("stops a registered detached descendant after its original parent exits and the mapping reconnects", async () => {
    const f = await fixture();
    const script = "const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e',\"process.stdout.write('ready');setInterval(()=>{},1000);\"],{detached:true,stdio:['ignore','pipe','ignore']});child.stdout.once('data',()=>process.stdout.write(String(child.pid)));setInterval(()=>{},1000);";
    const shell = spawn(process.execPath, ["-e", script], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
    const closed = once(shell, "close"); let descendant: number | undefined;
    const timer = setTimeout(() => { shell.kill("SIGKILL"); if (descendant !== undefined) process.kill(descendant, "SIGKILL"); }, 8_000);
    try {
      const [data] = await once(shell.stdout!, "data"); descendant = Number(String(data));
      const ids = await f.mapping.captureProcesses([shell.pid!], operation(), true);
      expect(ids).toContain(descendant);
      shell.kill("SIGKILL"); await closed;
      expect(await f.mapping.confirmStopped(operation())).toBe(false);
      const recovered = (await createToolLaunchMapping({ ...f.input, existingOnly: true }, operation()))!;
      await recovered.stopProcesses(operation());
      expect(await recovered.confirmStopped(operation())).toBe(true);
      await recovered.retire(operation());
    } finally {
      clearTimeout(timer);
      shell.kill("SIGKILL");
      if (descendant !== undefined) { try { process.kill(descendant, "SIGCONT"); process.kill(descendant, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; } }
      await closed;
    }
  });

  it.skipIf(process.platform === "win32")("releases a frozen original detached descendant after its parent is reaped", async () => {
    const f = await fixture();
    const script = "const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e',\"process.stdout.write('ready');setInterval(()=>{},1000);\"],{detached:true,stdio:['ignore','pipe','ignore']});child.stdout.once('data',()=>process.stdout.write(String(child.pid)));setInterval(()=>{},1000);";
    const shell = spawn(process.execPath, ["-e", script], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
    const closed = once(shell, "close"); let descendant: number | undefined;
    const timer = setTimeout(() => { shell.kill("SIGKILL"); if (descendant !== undefined) process.kill(descendant, "SIGKILL"); }, 8_000);
    try {
      const [data] = await once(shell.stdout!, "data"); descendant = Number(String(data));
      await f.mapping.captureProcesses([shell.pid!], operation(), true);
      shell.kill("SIGKILL"); await closed;
      await f.mapping.releaseFrozen();
      const state = await execute("/bin/ps", ["-p", String(descendant), "-o", "stat="]);
      expect(state.code).toBe(0); expect(state.stdout).not.toContain("T");
    } finally {
      clearTimeout(timer); shell.kill("SIGKILL");
      if (descendant !== undefined) { try { process.kill(descendant, "SIGCONT"); process.kill(descendant, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; } }
      await closed;
    }
  });

  it.skipIf(process.platform !== "win32")("terminates the original Windows Job including descendants absent from the process journal", async () => {
    const f = await fixture();
    const args = ["-e", "const {spawn}=require('node:child_process');process.stdout.write('ready');process.stdin.once('data',()=>{const child=spawn(process.execPath,['-e','setInterval(()=>{},1000);'],{detached:true,stdio:'ignore'});process.stdout.write(String(child.pid));});setInterval(()=>{},1000);"];
    const helper = spawn(process.execPath, [childEntry, f.mapping.manifestPath, "codex", "--", ...args], { stdio: ["pipe", "pipe", "pipe"] });
    const closed = once(helper, "close"), job = `Local\\Daynight-${f.mapping.nonce}`;
    const timer = setTimeout(() => { helper.kill("SIGKILL"); }, 8_000);
    try {
      await once(helper.stdout!, "data");
      const receipt = await f.mapping.verifyReceipt(args, operation());
      const registered = await f.mapping.captureProcesses([helper.pid!, receipt.childPid], operation());
      const spawned = once(helper.stdout!, "data"); helper.stdin!.write("go");
      const [data] = await spawned, detached = Number(String(data));
      expect(registered).not.toContain(detached);
      expect(await inspectControllerJob(job)).toEqual(expect.arrayContaining([helper.pid!, receipt.childPid, detached]));
      await f.mapping.stopProcesses(operation());
      await closed;
      expect(await inspectControllerJob(job)).toEqual([]);
      expect(await f.mapping.confirmStopped(operation())).toBe(true);
    } finally { clearTimeout(timer); await inspectControllerJob(job, true); helper.kill("SIGKILL"); await closed; }
  });

  it("treats a validated retired generation as terminal even when its historical PID is running again", async () => {
    const f = await fixture(), native = spawn(process.execPath, ["-e", "process.stdout.write('ready');setInterval(()=>{},1000);"], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
    const closed = once(native, "close"), timer = setTimeout(() => native.kill("SIGKILL"), 8_000);
    try {
      await once(native.stdout!, "data");
      await f.mapping.captureProcesses([native.pid!], operation());
      expect(await launchInventory.confirmToolLaunchMappingsStopped(f.directory, process.env, operation())).toBe(false);
      const retired = path.join(path.dirname(f.mapping.manifestPath), "retired.json");
      await writeFile(retired, JSON.stringify({ nonce: f.mapping.nonce, selectionKey: f.mapping.selectionKey, owner }), { mode: 0o600 });
      expect(launchInventory.readToolLaunchMappingInventory(f.directory)).toMatchObject([{ retired: true }]);
      expect(await launchInventory.confirmToolLaunchMappingsStopped(f.directory, process.env, operation())).toBe(true);
      await writeFile(retired, JSON.stringify({ nonce: owner.taskId, selectionKey: f.mapping.selectionKey, owner }), { mode: 0o600 });
      await expect(launchInventory.confirmToolLaunchMappingsStopped(f.directory, process.env, operation())).rejects.toThrow("retirement");
    } finally { clearTimeout(timer); native.kill("SIGKILL"); await closed; }
  });

  it("retains an unknown start RPC without a helper intent until its definite rejection is durably settled", async () => {
    const f = await fixture(), shell = spawn(process.execPath, ["-e", "process.stdout.write('ready');setInterval(()=>{},1000);"], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
    const closed = once(shell, "close"), timer = setTimeout(() => shell.kill("SIGKILL"), 4_000);
    try {
      await once(shell.stdout!, "data");
      await f.mapping.captureProcesses([shell.pid!], operation());
      const request = await reserveToolStartRequest(f.mapping.manifestPath, { nonce: f.mapping.nonce, selectionKey: f.mapping.selectionKey, owner }, { session: "original-session", workspaceId: "original-workspace", paneId: "original-pane", terminalId: "original-terminal" }, "codex", ["original-argument"]);
      expect(launchInventory.readToolLaunchMappingInventory(f.directory)).toMatchObject([{ started: true, retired: false }]);
      shell.kill("SIGKILL"); await closed;
      await expect(f.mapping.confirmStopped(operation())).rejects.toThrow("launch RPC");
      await expect(launchInventory.confirmToolLaunchMappingsStopped(f.directory, process.env, operation())).rejects.toThrow("launch RPC");
      await expect(f.mapping.stopProcesses(operation())).rejects.toThrow("launch RPC");
      await expect(f.mapping.retire(operation())).rejects.toThrow("launch RPC");
      await expect(reserveToolStartRequest(f.mapping.manifestPath, request, request.binding, "codex", ["original-argument"])).rejects.toMatchObject({ code: "EEXIST" });
      await advanceToolStartRequest(f.mapping.manifestPath, request, "agent_pane_busy");
      expect(launchInventory.readToolLaunchMappingInventory(f.directory)).toMatchObject([{ started: false, retired: false }]);
      expect(await launchInventory.confirmToolLaunchMappingsStopped(f.directory, process.env, operation())).toBe(true);
      await f.mapping.retire(operation());
      expect(launchInventory.readToolLaunchMappingInventory(f.directory)).toMatchObject([{ retired: true }]);
    } finally { clearTimeout(timer); shell.kill("SIGKILL"); await closed; }
  });

  it("keeps incomplete orphan generations as cleanup responsibilities", async () => {
    const f = await fixture();
    expect(launchInventory.readToolLaunchMappingInventory(f.directory)).toMatchObject([{ owner, launch: f.launch, nonce: f.mapping.nonce, started: false, retired: false }]);
    expect(await launchInventory.confirmToolLaunchMappingsStopped(f.directory, process.env, operation())).toBe(true);
    const orphan = path.join(path.dirname(path.dirname(f.mapping.manifestPath)), "00000000-0000-4000-8000-000000000005");
    await mkdir(orphan, { mode: 0o700 });
    expect(() => launchInventory.readToolLaunchMappingInventory(f.directory)).toThrow();
    await expect(launchInventory.confirmToolLaunchMappingsStopped(f.directory, process.env, operation())).rejects.toThrow();
  });

  it("freezes one immutable manifest and preserves its nonce across reconnect", async () => {
    const f = await fixture(), before = await readFile(f.mapping.manifestPath, "utf8");
    const recovered = await createToolLaunchMapping({ ...f.input, nativeEnvironment: { ...f.input.nativeEnvironment, PATH: "/changed/current/path" }, existingOnly: true }, operation());
    expect(recovered?.nonce).toBe(f.mapping.nonce);
    expect(await readFile(f.mapping.manifestPath, "utf8")).toBe(before);
    expect(before).not.toContain("CODEX_HOME");
    expect(await createToolLaunchMapping({ ...f.input, directory: path.join(f.directory, "absent"), existingOnly: true }, operation())).toBeNull();
  });

  it("starts exactly the frozen command, records original argv, and removes mapping environment from the child", async () => {
    const f = await fixture();
    const args = ["-e", "process.stdout.write(JSON.stringify({args:process.argv.slice(1),path:process.env.PATH,home:process.env.CODEX_HOME,mapping:process.env.DAYNIGHT_HERDR_TOOL_MANIFEST}));", "--", "", "a b", "'\"\\", "$HOME;echo nope", "中文"];
    const result = await execute(process.execPath, [childEntry, f.mapping.manifestPath, "codex", "--", ...args], { ...process.env, ...f.mapping.environment, PATH: "/mapping:/native/path", CODEX_HOME: "/native/home" });
    expect(result).toMatchObject({ code: 0, signal: null, stderr: "" });
    expect(JSON.parse(result.stdout)).toEqual({ args: args.slice(3), path: "/native/path", home: "/native/home" });
    const receipt = await f.mapping.verifyReceipt(args, operation());
    expect(receipt).toMatchObject({ helperPid: result.pid, selectionKey: f.launch.selectionKey, file: f.launch.command.file, prefixArgs: f.launch.command.prefixArgs });
    expect(receipt.childPid).not.toBe(result.pid);
    await expect(f.mapping.verifyReceipt([...args, "changed"], operation())).rejects.toThrow("receipt");
    const replay = await execute(process.execPath, [childEntry, f.mapping.manifestPath, "codex", "--", ...args]);
    expect(replay.code).not.toBe(0);
    expect(replay.stdout).toBe("");
  });

  it("refuses redirected or changed manifests without spawning a native command", async () => {
    const f = await fixture(), contents = await readFile(f.mapping.manifestPath, "utf8");
    const redirected = path.join(f.directory, "redirected.json"); await writeFile(redirected, contents, { mode: 0o600 });
    await rm(f.mapping.manifestPath); await symlink(redirected, f.mapping.manifestPath);
    const result = await execute(process.execPath, [childEntry, f.mapping.manifestPath, "codex", "--", "-e", "process.stdout.write('wrong')"]);
    expect(result.code).not.toBe(0); expect(result.stdout).toBe("");
    await expect(createToolLaunchMapping({ ...f.input, existingOnly: true }, operation())).rejects.toThrow();
  });

  it("decodes the PowerShell transport as data and preserves empty native arguments", async () => {
    const f = await fixture(), args = ["-e", "process.stdout.write(JSON.stringify(process.argv.slice(1)));", "--", "", "a b", "'\"\\", "$HOME;echo nope", "中文"];
    const encode = (value: string) => Buffer.from(value).toString("base64");
    const result = await execute(process.execPath, [childEntry, "--encoded-manifest", encode(f.mapping.manifestPath), "codex", "--encoded-args", encode(JSON.stringify(args))]);
    expect(result).toMatchObject({ code: 0, signal: null, stderr: "" });
    expect(JSON.parse(result.stdout)).toEqual(args.slice(3));
    expect(await f.mapping.verifyReceipt(args, operation())).toMatchObject({ helperPid: result.pid });
  });

  it("waits for the asynchronous receipt publication without starting another native process", async () => {
    const f = await fixture(), args = ["-e", "process.stdout.write('once');"];
    const verification = f.mapping.verifyReceipt(args, operation());
    const [receiptResult, childResult] = await Promise.allSettled([verification, execute(process.execPath, [childEntry, f.mapping.manifestPath, "codex", "--", ...args])]);
    if (receiptResult.status === "rejected") throw receiptResult.reason;
    if (childResult.status === "rejected") throw childResult.reason;
    const receipt = receiptResult.value, result = childResult.value;
    expect(result).toMatchObject({ code: 0, stdout: "once" });
    expect(receipt.helperPid).toBe(result.pid);
  });

  it.skipIf(process.platform === "win32")("rotates a same-owner generation only after every recorded process has stopped", async () => {
    const f = await fixture(), native = spawn(process.execPath, ["-e", "process.stdout.write('ready');setInterval(()=>{},1000);"], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const closed = once(native, "close");
    const timer = setTimeout(() => { if (native.pid !== undefined) process.kill(-native.pid, "SIGKILL"); }, 8_000);
    try {
      await once(native.stdout!, "data");
      await f.mapping.captureProcesses([native.pid!], operation());
      await expect(f.mapping.retire(operation())).rejects.toThrow("stopped");
      expect((await createToolLaunchMapping(f.input, operation()))!.nonce).toBe(f.mapping.nonce);
      native.kill("SIGTERM"); await closed;
      await f.mapping.retire(operation());
      expect((await createToolLaunchMapping({ ...f.input, existingOnly: true }, operation()))!.nonce).toBe(f.mapping.nonce);
      const next = await createToolLaunchMapping(f.input, operation());
      expect(next!.nonce).not.toBe(f.mapping.nonce);
      expect(next!.manifestPath).not.toBe(f.mapping.manifestPath);
      expect(JSON.parse(await readFile(f.mapping.manifestPath, "utf8")).nonce).toBe(f.mapping.nonce);
    } finally { clearTimeout(timer); if (native.exitCode === null && native.signalCode === null && native.pid !== undefined) { process.kill(-native.pid, "SIGKILL"); await closed; } }
  });

  it.skipIf(process.platform === "win32")("waits for the original native child after a signal and returns its exit status", async () => {
    const f = await fixture(), args = ["-e", "process.on('SIGTERM',()=>process.exit(17));process.stdout.write('ready');setInterval(()=>{},1000);"];
    const helper = spawn(process.execPath, [childEntry, f.mapping.manifestPath, "codex", "--", ...args], { env: process.env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const closed = once(helper, "close");
    const timer = setTimeout(() => { if (helper.pid !== undefined) process.kill(-helper.pid, "SIGKILL"); }, 8_000);
    try {
      await once(helper.stdout!, "data");
      const receipt = await f.mapping.verifyReceipt(args, operation());
      expect(helper.kill("SIGTERM")).toBe(true);
      expect(await closed).toEqual([17, null]);
      expect(() => process.kill(receipt.childPid, 0)).toThrow();
    } finally { clearTimeout(timer); if (helper.exitCode === null && helper.signalCode === null && helper.pid !== undefined) { process.kill(-helper.pid, "SIGKILL"); await closed; } }
  });

  it.skipIf(process.platform === "win32")("refuses a replaced selected entry before writing a launch intent", async () => {
    const f = await fixture(), entry = path.join(f.directory, "selected-native");
    await symlink(process.execPath, entry);
    const launch = await resolveToolLaunch({ tool: "codex", context: "herdr", choice: { kind: "path", path: entry }, environment: process.env, cwd: f.directory }, operation());
    const mapping = await createToolLaunchMapping({ ...f.input, launch }, operation());
    if (mapping === null) throw new Error("Missing selected-entry mapping.");
    await rm(entry); await symlink("/bin/echo", entry);
    const result = await execute(process.execPath, [childEntry, mapping.manifestPath, "codex", "--", "-e", "process.stdout.write('wrong')"]);
    expect(result.code).not.toBe(0); expect(result.stdout).toBe("");
    expect(await mapping.readReceipt(operation())).toBeNull();
    await expect(readFile(path.join(path.dirname(mapping.manifestPath), "launch-intent.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.skipIf(process.platform === "win32")("uses unexported Bash functions without replacing the original pane shell", async () => {
    const f = await fixture(), rc = path.join(f.directory, "shell.rc");
    await writeFile(rc, posixToolMappingRc({ nodeExecutable: process.execPath, childEntry }));
    const args = ["-e", "process.stdout.write(JSON.stringify({args:process.argv.slice(1),path:process.env.PATH,mapping:process.env.DAYNIGHT_HERDR_TOOL_MANIFEST,functions:process.env['BASH_FUNC_codex%%']}));", "--", "", "a b", "$HOME;echo nope"];
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    const result = await execute("/bin/bash", ["--noprofile", "--rcfile", rc, "-p", "-i", "-c", `printf 'shell:%s\\n' "$$"; codex ${args.map(quote).join(" ")}; printf '\\nshell:%s\\n' "$$"`], { ...process.env, ...f.mapping.environment });
    expect(result.code).toBe(0);
    const lines = result.stdout.trim().split("\n");
    expect(lines[0]).toBe(`shell:${result.pid}`); expect(lines[2]).toBe(`shell:${result.pid}`);
    expect(JSON.parse(lines[1]!)).toEqual({ args: args.slice(3), path: "/native/path" });
  });
});
