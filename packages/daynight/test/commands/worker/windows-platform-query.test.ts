import { lstat, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { createOperation } from "../../../src/api/operation.js";
import { createWindowsQueryCheckpointObserver, decodeWindowsExternalScript, decodeWindowsPlatformJson, prepareWindowsObserverEnvironment, runWindowsPlatformQuery, type WindowsQueryObservation } from "./windows-platform-query.fixtures.js";

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
