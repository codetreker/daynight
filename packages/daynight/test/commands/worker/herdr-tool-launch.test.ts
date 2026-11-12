import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createOperation, type Operation } from "../../../src/api/operation.js";
import { resolveToolLaunch } from "../../../src/platform/tool-executables.js";
import { inspectControllerJob } from "../../../src/commands/controller/windows-job.js";
import { createToolLaunchMapping, posixToolMappingRc } from "../../../src/commands/worker/herdr/tool-launch.js";
import * as launchInventory from "../../../src/commands/worker/herdr/tool-launch-inventory.js";
import { advanceToolStartRequest, reserveToolStartRequest } from "../../../src/commands/worker/herdr/tool-launch-start.js";
import { captureMappingProcessProof, parseLinuxProcessBirth } from "../../../src/commands/worker/herdr/tool-launch-process-proof.js";
import { parseWindowsMappingProcessInventory, windowsMappingProcessInventoryCommand } from "../../../src/commands/worker/herdr/tool-launch-lifecycle.js";

const roots: string[] = [], operations: Operation[] = [];
const operation = (): Operation => { const value = createOperation({ limits: { totalMs: 10_000 } }); operations.push(value); return value; };
const owner = { projectId: "00000000-0000-4000-8000-000000000001", taskId: "00000000-0000-4000-8000-000000000002", claimId: "00000000-0000-4000-8000-000000000003", worktreeId: "00000000-0000-4000-8000-000000000004" };
const childEntry = path.resolve(import.meta.dirname, "../../../dist/commands/worker/herdr/tool-launch-child.js");
const fixture = async () => {
  const scratch = path.resolve(import.meta.dirname, "../../../../../.tmp/herdr-tools/mapping-tests");
  await mkdir(scratch, { recursive: true });
  const directory = await mkdtemp(path.join(scratch, "owner ' $; 中文-")); roots.push(directory);
  const launch = await resolveToolLaunch({ tool: "codex", context: "herdr", choice: { kind: "path", path: process.execPath }, environment: process.env, cwd: directory }, operation());
  const input = { directory, owner, launch, nativeEnvironment: { ...process.env, PATH: "/native/path", CODEX_HOME: "/native/home" }, childEntry };
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
afterEach(async () => { operations.splice(0).forEach(value => value.dispose()); await Promise.all(roots.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

describe("owned Herdr launch mapping", () => {
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

  it.skipIf(process.platform !== "win32")("reads the real Windows process inventory despite inherited incompatible PowerShell module paths", async () => {
    const f = await fixture(), native = spawn(process.execPath, ["-e", "process.stdout.write('ready');setInterval(()=>{},1000);"], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
    const closed = once(native, "close"), timer = setTimeout(() => native.kill("SIGKILL"), 8_000);
    try {
      await once(native.stdout!, "data");
      const environment = { ...f.input.nativeEnvironment, PSModulePath: path.join(f.directory, "incompatible-modules"), pSmOdUlEpAtH: path.join(f.directory, "other-incompatible-modules") };
      const mapping = (await createToolLaunchMapping({ ...f.input, nativeEnvironment: environment, existingOnly: true }, operation()))!;
      expect(await mapping.captureProcesses([native.pid!], operation())).toContain(native.pid);
      native.kill("SIGKILL"); await closed;
      expect(await mapping.confirmStopped(operation())).toBe(true);
      expect(environment.PSModulePath).toBe(path.join(f.directory, "incompatible-modules"));
      expect(environment.PATH).toBe("/native/path");
    } finally { clearTimeout(timer); native.kill("SIGKILL"); await closed; }
  });

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
