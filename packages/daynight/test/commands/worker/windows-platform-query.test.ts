import { lstat, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { createOperation } from "../../../src/api/operation.js";
import { createWindowsQueryCheckpointObserver, decodeWindowsExternalScript, decodeWindowsPlatformJson, prepareWindowsObserverEnvironment, runWindowsPlatformQuery, windowsProcessQuery, decodeWindowsProcessQuery, windowsConsoleQuery, decodeWindowsConsoleQuery, type WindowsQueryObservation } from "./windows-platform-query.fixtures.js";

const command = await import(new URL("../../../dist/commands/worker/herdr/command.js", import.meta.url).href) as typeof import("../../../src/commands/worker/herdr/command.js");

afterEach(() => vi.restoreAllMocks());

const withObserverDirectory = async (inspect: (root: string) => Promise<void>) => {
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp/herdr-tools/research-platform/observer-env-tests");
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, "observer-"));
  try { await inspect(root); }
  finally { await rm(root, { recursive: true, force: true }); }
};

test.each(["upper", "lower"])("isolates a %s-case harness observer without copying credentials or mutating harness inputs", async casing => {
  await withObserverDirectory(async root => {
    const system = { SystemRoot: "C:\\Windows", SystemDrive: "C:", ComSpec: "C:\\Windows\\System32\\cmd.exe", WINDIR: "C:\\Windows", OS: "Windows_NT", PATH: "harness-search", PATHEXT: ".EXE;.COM", ProgramData: "C:\\ProgramData", ProgramFiles: "C:\\Program Files", "ProgramFiles(x86)": "C:\\Program Files (x86)", ProgramW6432: "C:\\Program Files", CommonProgramFiles: "C:\\Program Files\\Common Files", "CommonProgramFiles(x86)": "C:\\Program Files (x86)\\Common Files", CommonProgramW6432: "C:\\Program Files\\Common Files" };
    const source = Object.freeze({ ...Object.fromEntries(Object.entries(system).map(([name, value]) => [casing === "upper" ? name.toUpperCase() : name.toLowerCase(), value])), HOME: "harness-home", USERPROFILE: "harness-user", PSModulePath: "harness-ps7-or-user-modules", OPENAI_API_KEY: "credentials-sentinel", COPILOT_PROVIDER_API_KEY: "credentials-sentinel", UNKNOWN_PROVIDER_TOKEN: "credentials-sentinel", CODEX_HOME: "credentials-sentinel", GIT_CONFIG_GLOBAL: "credentials-sentinel" });
    const beforeHarness = JSON.stringify(source);
    const environment = await prepareWindowsObserverEnvironment(root, source);
    expect(JSON.stringify(source)).toBe(beforeHarness);
    expect(environment).toMatchObject(system);
    expect(environment.PSModulePath).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules");
    expect(environment.HOME).toBe(environment.USERPROFILE);
    for (const name of ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP"] as const) {
      const location = environment[name]!, relative = path.relative(path.join(root, "observer"), location);
      expect(path.isAbsolute(location)).toBe(true); expect(relative).not.toBe(""); expect(relative).not.toMatch(/^\.\./); expect(path.isAbsolute(relative)).toBe(false);
      const entry = await lstat(location); expect(entry.isDirectory()).toBe(true); expect(entry.isSymbolicLink()).toBe(false);
      if (process.platform !== "win32") expect(entry.mode & 0o077).toBe(0);
    }
    expect(Object.keys(environment).sort()).toEqual([...Object.keys(system), "PSModulePath", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP"].sort());
    expect(JSON.stringify(environment)).not.toContain("credentials-sentinel"); expect(JSON.stringify(environment)).not.toContain("harness-home");
  });
});

test("prepares real observer temporary storage for a joined child without granting it provider configuration", async () => {
  await withObserverDirectory(async root => {
    const environment = await prepareWindowsObserverEnvironment(root, Object.freeze({ SystemRoot: "C:\\Windows", PATH: "harness-search", UNKNOWN_PROVIDER_TOKEN: "credentials-sentinel" }));
    const active = createOperation({ limits: { totalMs: 2000, requestMs: 1000 } }), observations: WindowsQueryObservation[] = [];
    try {
      const script = "const fs=require('node:fs'),path=require('node:path');fs.writeFileSync(path.join(process.env.TEMP,'owned-compiler-probe'),'owned');process.stdout.write(JSON.stringify({home:process.env.HOME,temporary:process.env.TEMP,providerPresent:'UNKNOWN_PROVIDER_TOKEN' in process.env}));";
      const output = JSON.parse(await runWindowsPlatformQuery("console", { file: process.execPath, args: ["-e", script], environment }, active, observations));
      expect(output).toEqual({ home: environment.HOME, temporary: environment.TEMP, providerPresent: false });
      expect(await readFile(path.join(environment.TEMP!, "owned-compiler-probe"), "utf8")).toBe("owned");
      expect(observations[0]).toMatchObject({ closed: true, cleanupConfirmed: true });
    } finally { active.dispose(); }
  });
});

test.each([undefined, "relative-windows-root"])("refuses an unavailable system PS5 location before creating observer files (%s)", async systemRoot => {
  await withObserverDirectory(async root => {
    await expect(prepareWindowsObserverEnvironment(root, systemRoot === undefined ? {} : { SystemRoot: systemRoot })).rejects.toThrow(/SystemRoot/);
    expect(await readdir(root)).toEqual([]);
  });
});

test("keeps Unicode and quote characters in the independent ExternalScript proof", () => {
  const source = "D:\\task's 空间 📖\\codex.ps1";
  expect(decodeWindowsExternalScript(Buffer.from(`5.1.19041.5000\nExternalScript\n${source}`, "utf8").toString("base64") + "\r\n")).toEqual({ version: "5.1.19041.5000", type: "ExternalScript", source });
});

test.each(["", "not base64", Buffer.from([0xff]).toString("base64"), Buffer.from("5.1\nExternalScript").toString("base64"), Buffer.from("5.1\nExternalScript\n\nextra").toString("base64")])("rejects an incomplete independent proof (%s)", value => {
  expect(() => decodeWindowsExternalScript(value)).toThrow();
});

test("keeps independent JSON evidence intact without using it as a production process proof", () => {
  expect(decodeWindowsPlatformJson("processes", '{"processes":[{"ProcessId":4101,"ParentProcessId":4000}]}', [])).toEqual({ processes: [{ ProcessId: 4101, ParentProcessId: 4000 }] });
});

test("rejects incomplete JSON without leaking any raw output through the parse error", () => {
  const observations: WindowsQueryObservation[] = [{ stage: "console", elapsedMs: 1, code: 0, killed: false, signal: null, stdoutBytes: 27, stderrBytes: 0, closed: true, cleanupConfirmed: true, errorType: null }];
  let failure: unknown;
  try { decodeWindowsPlatformJson("console", '{"private-query-marker":', observations); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(Error); expect((failure as Error).message).toContain("console"); expect((failure as Error).message).not.toContain("private-query-marker");
  expect(observations[0]!.errorType).toBe("InvalidJson");
  expect((failure as Error).cause).toBeUndefined();
});

test("records a malformed ExternalScript transport without revoking its confirmed cleanup", () => {
  const observations: WindowsQueryObservation[] = [{ stage: "external-script", elapsedMs: 1, code: 0, killed: false, signal: null, stdoutBytes: 10, stderrBytes: 0, closed: true, cleanupConfirmed: true, errorType: null }];
  expect(() => decodeWindowsExternalScript("not-base64", observations)).toThrow();
  expect(observations[0]).toMatchObject({ errorType: "InvalidExternalScript", closed: true, cleanupConfirmed: true });
});

test("records a real query's output byte counts only after its original child closes", async () => {
  const active = createOperation({ limits: { totalMs: 2000, requestMs: 1000 } }), observations: WindowsQueryObservation[] = [];
  try {
    const output = await runWindowsPlatformQuery("external-script", { file: process.execPath, args: ["-e", "process.stdout.write('independent-output')"], environment: {} }, active, observations);
    expect(output).toBe("independent-output");
    expect(observations).toMatchObject([{ stage: "external-script", code: 0, stdoutBytes: 18, stderrBytes: 0, closed: true, cleanupConfirmed: true, errorType: null }]);
  } finally { active.dispose(); }
});

test("preserves a failed query's exit diagnostics without exposing its command, environment or output", async () => {
  const secret = "private-query-marker", active = createOperation({ limits: { totalMs: 2000, requestMs: 1000 } }), observations: WindowsQueryObservation[] = [];
  try {
    const error = await runWindowsPlatformQuery("processes", { file: process.execPath, args: ["-e", `process.stderr.write('${secret}');process.exit(7)`], environment: { PRIVATE_MARKER: secret } }, active, observations).catch(error => error);
    expect(error).toBeInstanceOf(Error); expect(error.message).toContain("processes"); expect(error.message).not.toContain(secret); expect(error.cause).toBeUndefined();
    expect(observations).toMatchObject([{ stage: "processes", code: 7, stdoutBytes: 0, stderrBytes: 20, closed: true, cleanupConfirmed: true, errorType: "HerdrCommandError" }]);
    expect(JSON.stringify(observations)).not.toContain(secret);
  } finally { active.dispose(); }
});

test("joins a timed out real query before rejecting and records its original deadline", async () => {
  const active = createOperation({ limits: { totalMs: 5000, requestMs: 150 } }), observations: WindowsQueryObservation[] = [];
  try {
    await expect(runWindowsPlatformQuery("console", { file: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], environment: {} }, active, observations)).rejects.toThrow("console");
    expect(observations).toMatchObject([{ stage: "console", closed: true, cleanupConfirmed: true, errorType: "HerdrCommandDeadlineError" }]);
    expect(observations[0]!.elapsedMs).toBeLessThan(4000);
  } finally { active.dispose(); }
});

test("keeps cleanup unknown without serializing an unsafe raw error cause", async () => {
  const secret = "private-encoded-command", active = createOperation(), observations: WindowsQueryObservation[] = [];
  vi.spyOn(command, "runHerdrCommand").mockRejectedValue(new command.HerdrCommandCleanupError([new Error(secret)], new Error(secret)));
  try {
    const error = await runWindowsPlatformQuery("console", { file: process.execPath, args: [], environment: {} }, active, observations).catch(error => error);
    expect(error.message).not.toContain(secret); expect(error.cause).toBeUndefined();
    expect(observations).toMatchObject([{ closed: false, cleanupConfirmed: false, errorType: "HerdrCommandCleanupError" }]);
  } finally { active.dispose(); }
});


test("keeps only complete fixed stage checkpoints across stderr chunks", () => {
  const checkpoints: string[] = [], observe = createWindowsQueryCheckpointObserver("processes", value => checkpoints.push(value));
  observe(Buffer.from("DAYNIGHT_QUERY:ent")); expect(checkpoints).toEqual([]);
  observe(Buffer.from("ry\r\nDAYNIGHT_QUERY:cim-complete\n"));
  observe(Buffer.from("DAYNIGHT_QUERY:projection-complete\nDAYNIGHT_QUERY:json-complete\n"));
  expect(checkpoints).toEqual(["entry", "cim-complete", "projection-complete", "json-complete"]);
});

test("rejects unknown, cross-stage, embedded and oversized stderr without retaining private output", () => {
  const checkpoints: string[] = [], observe = createWindowsQueryCheckpointObserver("console", value => checkpoints.push(value));
  for (const value of ["private-value\n", "DAYNIGHT_QUERY:cim-complete\n", "private-DAYNIGHT_QUERY:entry\n", "DAYNIGHT_QUERY:unknown-private-value\n", "x".repeat(100_000), "DAYNIGHT_QUERY:entry\n", "DAYNIGHT_QUERY:entry\0\n", "DAYNIGHT_QUERY:entryé\n"]) observe(Buffer.from(value));
  expect(checkpoints).toEqual([]);
  observe(Buffer.from("DAYNIGHT_QUERY:type-complete\nDAYNIGHT_QUERY:attach-complete\n"));
  expect(checkpoints).toEqual(["type-complete", "attach-complete"]);
});

test.each(["win32", "linux"])("changes only the Windows query console flag and existing detached override (%s)", async platform => {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!, active = createOperation(), observations: WindowsQueryObservation[] = [];
  const environment = { PRIVATE_MARKER: "not-logged" }, options: SpawnOptions = { env: environment, cwd: "/owned", detached: true, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] };
  const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), killed: false }) as unknown as ChildProcess;
  const spawn = vi.spyOn(command, "spawnHerdrProcess").mockReturnValue(child);
  vi.spyOn(command, "runHerdrCommand").mockImplementation(async (_input, _operation, start) => {
    start!("powershell", ["fixed-arguments"], options);
    child.stderr!.emit("data", Buffer.from("DAYNIGHT_QUERY:entry\n"));
    child.emit("close", 0, null);
    return { stdout: "{}", stderr: "" };
  });
  try {
    Object.defineProperty(process, "platform", { ...descriptor, value: platform });
    expect(await runWindowsPlatformQuery("processes", { file: "powershell", args: [], environment }, active, observations)).toBe("{}");
    expect(spawn).toHaveBeenCalledWith("powershell", ["fixed-arguments"], { ...options, ...(platform === "win32" ? { detached: false, windowsHide: false } : {}) });
    expect(options).toMatchObject({ detached: true, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    expect(observations).toMatchObject([{ lastCheckpoint: "entry", closed: true, cleanupConfirmed: true }]);
  } finally { Object.defineProperty(process, "platform", descriptor); active.dispose(); }
});


const wmiBirth = "20260102030405.123456+060", wmiTicks = "639029162451234560";
const wmiRow = (pid: number, patch: Partial<{ parent: string; executable: string; command: string; birth: string; ticks: string }> = {}) => {
  const row = { parent: "400", executable: "C:\\task's 空间 📖\\native.exe", command: "native.exe --literal 'quoted'\nsecond line", birth: wmiBirth, ticks: wmiTicks, ...patch };
  return [String(pid), row.parent, Buffer.from(row.executable).toString("base64"), Buffer.from(row.command).toString("base64"), row.birth, row.ticks].join("\t");
};
const wmiFrame = (rows = [wmiRow(401), wmiRow(402), wmiRow(403)]) => ["DAYNIGHT_WINDOWS_WMI_V1", Buffer.from("5.1.26100.33648").toString("base64"), ...rows].join("\n");

test("decodes only original WMI processes with lossless Unicode, command lines and offset microsecond birth", () => {
  const output = decodeWindowsProcessQuery(wmiFrame([wmiRow(401), wmiRow(402, { birth: "20260102010405.123456-060" }), wmiRow(403, { birth: "20260102020405.123456+000" })]), [401, 402, 403]);
  expect(output.version).toBe("5.1.26100.33648"); expect(output.processes).toHaveLength(3);
  expect(output.processes[0]).toEqual({ ProcessId: 401, ParentProcessId: 400, ExecutablePath: "C:\\task's 空间 📖\\native.exe", CommandLine: "native.exe --literal 'quoted'\nsecond line", CreationDate: wmiBirth, CreationDateTicks: wmiTicks });
  expect(decodeWindowsProcessQuery(wmiFrame([wmiRow(403), wmiRow(401), wmiRow(402)]), [401, 402, 403]).processes.map(row => row.ProcessId)).toEqual([403, 401, 402]);
});

test.each([
  [wmiRow(401), wmiRow(402)], [wmiRow(401), wmiRow(402), wmiRow(403), wmiRow(404)],
  [wmiRow(401), wmiRow(401), wmiRow(403)], [wmiRow(401), wmiRow(402), wmiRow(404)],
  [wmiRow(401, { parent: "-1" }), wmiRow(402), wmiRow(403)],
  [wmiRow(401, { executable: "" }), wmiRow(402), wmiRow(403)],
  [wmiRow(401, { executable: "relative.exe" }), wmiRow(402), wmiRow(403)],
  [wmiRow(401, { executable: "\\rooted-but-unqualified.exe" }), wmiRow(402), wmiRow(403)],
  [wmiRow(401, { command: "" }), wmiRow(402), wmiRow(403)],
  [wmiRow(401, { command: "   " }), wmiRow(402), wmiRow(403)],
  [wmiRow(401, { birth: "20260102030405.******+060" }), wmiRow(402), wmiRow(403)],
  [wmiRow(401, { birth: "20260230030405.123456+060" }), wmiRow(402), wmiRow(403)],
  [wmiRow(401, { ticks: "639029162451234561" }), wmiRow(402), wmiRow(403)],
  [wmiRow(401).replace(/\t[^\t]+$/, ""), wmiRow(402), wmiRow(403)],
  [wmiRow(401).replace(Buffer.from("C:\\task's 空间 📖\\native.exe").toString("base64"), "/w=="), wmiRow(402), wmiRow(403)],
].map(rows => [rows]))("rejects incomplete or inconsistent independent WMI fields without exposing process data (%#)", rows => {
  const observations: WindowsQueryObservation[] = [{ stage: "processes", elapsedMs: 1, code: 0, killed: false, signal: null, stdoutBytes: 1, stderrBytes: 0, closed: true, cleanupConfirmed: true, errorType: null }];
  let failure: unknown;
  try { decodeWindowsProcessQuery(wmiFrame(rows), [401, 402, 403], observations); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(Error); expect((failure as Error).message).not.toContain("native.exe"); expect((failure as Error).cause).toBeUndefined();
  expect(observations[0]).toMatchObject({ errorType: "InvalidWindowsProcesses", cleanupConfirmed: true, closed: true });
});

test.each([[401, 401, 403], [401, 402], [401, 402, -1], [401, 402, 4294967296], [401, 402, 3.5]].map(pids => [pids]))("refuses an unsafe or incomplete independent WMI target set (%j)", pids => {
  expect(() => windowsProcessQuery(pids)).toThrow();
  expect(() => decodeWindowsProcessQuery(wmiFrame(), pids)).toThrow();
});


test.each(["", wmiFrame().replace("DAYNIGHT_WINDOWS_WMI_V1", "private-header"), wmiFrame().replace(Buffer.from("5.1.26100.33648").toString("base64"), Buffer.from("7.4.0").toString("base64")), wmiFrame().replace(Buffer.from("C:\\task's 空间 📖\\native.exe").toString("base64"), "not-base64!")])("refuses an invalid WMI envelope or encoded field (%#)", output => {
  expect(() => decodeWindowsProcessQuery(output, [401, 402, 403])).toThrow("independent Windows process proof is incomplete");
});


const consoleFrame = (patch: Partial<{ version: string; attached: string; error: string; count: string; detached: string; members: string }> = {}) => {
  const row = { version: "5.1.26100.33648", attached: "1", error: "0", count: "4", detached: "1", members: "401,402,403,499", ...patch };
  return ["DAYNIGHT_WINDOWS_CONSOLE_V1", Buffer.from(row.version).toString("base64"), [row.attached, row.error, row.count, row.detached, row.members].join("\t")].join("\n");
};

test("decodes an original shared console including its extra observer without assuming exactly three members", () => {
  expect(decodeWindowsConsoleQuery(consoleFrame({ error: "5" }), [401, 402, 403])).toEqual({ version: "5.1.26100.33648", attached: true, errorCode: 5, count: 4, detached: true, processIds: [401, 402, 403, 499] });
  const members = Array.from({ length: 256 }, (_, index) => 401 + index);
  expect(decodeWindowsConsoleQuery(consoleFrame({ count: "256", members: members.join(",") }), [401, 402, 403]).processIds).toEqual(members);
});

test.each([
  { attached: "0" }, { detached: "0" }, { count: "0", members: "" }, { count: "257", members: Array.from({ length: 257 }, (_, index) => 401 + index).join(",") },
  { count: "5" }, { members: "401,402,403,403" }, { members: "401,402,404,499" },
  { members: "401,402,403,0" }, { members: "401,402,403,4294967296" }, { error: "-1" }, { error: "4294967296" },
  { version: "7.5.4" }, { members: "401,402,403,private-console-value" },
])("rejects an incomplete independent console proof without leaking its frame (%#)", patch => {
  const observations: WindowsQueryObservation[] = [{ stage: "console", elapsedMs: 1, code: 0, killed: false, signal: null, stdoutBytes: 1, stderrBytes: 0, closed: true, cleanupConfirmed: true, errorType: null }];
  let failure: unknown;
  try { decodeWindowsConsoleQuery(consoleFrame(patch), [401, 402, 403], observations); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(Error); expect((failure as Error).message).not.toContain("private-console-value"); expect((failure as Error).cause).toBeUndefined();
  expect(observations[0]).toMatchObject({ errorType: "InvalidWindowsConsole", closed: true, cleanupConfirmed: true });
});

test.each(["", consoleFrame().replace("DAYNIGHT_WINDOWS_CONSOLE_V1", "private-header"), consoleFrame()+"\n", consoleFrame().replace(/\t[^\t]+$/, ""), consoleFrame().replace(Buffer.from("5.1.26100.33648").toString("base64"), "not-base64!")])("rejects malformed or partial console frames (%#)", frame => {
  expect(() => decodeWindowsConsoleQuery(frame, [401, 402, 403])).toThrow("independent Windows console proof is incomplete");
});

test.each([0, -1, 3.5, 4294967296])("refuses an unsafe original console target (%j)", pid => {
  expect(() => windowsConsoleQuery(pid)).toThrow();
});
