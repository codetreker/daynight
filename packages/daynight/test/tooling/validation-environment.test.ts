import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import type { SpawnSyncOptionsWithStringEncoding } from "node:child_process";
import crossSpawn from "cross-spawn";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createValidationProbeRecorder } from "../../scripts/validation-environment.js";

const temporary = path.resolve(import.meta.dirname, "../../../../.tmp/validation-probe-tests");
const directories: string[] = [];
type PreparationRequest = { file: string; args: string[]; cwd: string; environment: NodeJS.ProcessEnv };
const helperScript = path.resolve(import.meta.dirname, "../../scripts/validation-environment.ts");
type Diagnostics = {
  error: null | { name: string; message: string; code?: string; errno?: number; syscall?: string; path?: string };
  probes: {
    file: string; args: string[]; state: string; resolvedExecutable: string | null; launcher: string | null;
    startedAt: string; elapsedMs: number; timeoutMs: number; executionTimeoutMs: number | null; maxBuffer: number; pid: number | null;
    preparation: { bytesRead: number; sha256: string | null; elapsedMs: number | null; timeoutMs: number; helperPid: number | null } | null;
    executionElapsedMs: number | null; failurePhase: "resolving" | "preparing" | "running" | null; exitCode: number | null;
    stdout: string; stderr: string; stdoutTruncated: boolean; stderrTruncated: boolean;
    error: null | { name: string; message: string; code?: string; errno?: number; syscall?: string; path?: string };
  }[];
};
const fixture = () => {
  mkdirSync(temporary, { recursive: true });
  const directory = mkdtempSync(path.join(temporary, "Probe 中文 "));
  directories.push(directory);
  const bin = path.join(directory, "bin");
  mkdirSync(bin);
  const inheritedPathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path");
  if (inheritedPathKey === undefined) throw new Error("Native probe tests require PATH.");
  const environment: NodeJS.ProcessEnv = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== "path")),
    PATH: `${bin}${path.delimiter}${process.env[inheritedPathKey]}`,
    DAYNIGHT_PROBE_NODE: process.execPath,
  };
  const tool = (name: string, source: string, extension = ".cmd"): string => {
    const script = path.join(bin, `${name}${extension}.cjs`);
    writeFileSync(script, source);
    const executable = path.join(bin, process.platform === "win32" ? `${name}${extension}` : name);
    const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
    // Keep batch source ASCII; CMD expands the Unicode directory from the invoked shim.
    const wrapper = process.platform === "win32"
      ? `@echo off\r\n"%DAYNIGHT_PROBE_NODE%" "%~dp0${path.basename(script)}" %*\r\n`
      : `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)} "$@"\n`;
    if (process.platform === "win32") expect(wrapper).toMatch(/^[\x00-\x7f]*$/);
    writeFileSync(executable, wrapper);
    chmodSync(executable, 0o755);
    return executable;
  };
  const diagnostics = path.join(directory, "evidence");
  const read = (): Diagnostics => JSON.parse(readFileSync(path.join(diagnostics, "validation-probes.json"), "utf8")) as Diagnostics;
  const log: string[] = [];
  const recorder = () => createValidationProbeRecorder({ directory: diagnostics, environment, log: (message) => { log.push(message); } });
  return { directory, bin, environment, tool, diagnostics, read, log, recorder };
};
const blockedReadPipe = async (directory: string, serverExecutable = process.execPath) => {
  const pipe = process.platform === "win32" ? `\\\\.\\pipe\\dn-probe-${randomUUID()}` : path.join(directory, "blocked-read.fifo");
  if (process.platform !== "win32") {
    const made = crossSpawn.sync("mkfifo", [pipe], { encoding: "utf8" });
    if (made.error) throw made.error;
    expect(made.status).toBe(0);
  }
  const source = process.platform === "win32"
    ? `require('node:net').createServer(c=>c.write(Buffer.from('x'))).listen(process.argv[1],()=>process.stdout.write('ready\\n'))`
    : `process.stdout.write('ready\\n',()=>{const fs=require('node:fs');const fd=fs.openSync(process.argv[1],'w');fs.writeSync(fd,Buffer.from('x'));setInterval(()=>{},1000)})`;
  const server = spawn(serverExecutable, ["-e", source, pipe], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  const closed = new Promise<void>(resolve => { server.once("close", () => resolve()); });
  const close = async (): Promise<void> => {
    if (server.pid !== undefined && server.exitCode === null && server.signalCode === null) server.kill("SIGKILL");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([closed, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Blocked-read fixture server did not close.")), 5_000); })]); }
    finally { clearTimeout(timer); }
  };
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Blocked-read fixture server did not start.")), 10_000);
      server.once("error", error => { clearTimeout(timer); reject(error); });
      server.once("exit", () => { clearTimeout(timer); reject(new Error("Blocked-read fixture server exited before readiness.")); });
      server.stdout.once("data", () => { clearTimeout(timer); resolve(); });
    });
  } catch (error) {
    try { await close(); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], "Blocked-read fixture startup and cleanup failed.", { cause: error }); }
    throw error;
  }
  return { pipe, close };
};
afterEach(({ task }) => {
  for (const directory of directories.splice(0)) {
    try {
      if (task.result?.state === "fail") {
        for (const relative of ["evidence/validation-probes.json", ".tmp/validation-probes.json"]) {
          const diagnostics = path.join(directory, relative);
          if (existsSync(diagnostics)) process.stderr.write(`Native probe fixture failure (${task.name}): ${readFileSync(diagnostics, "utf8").slice(0, 65_536)}\n`);
        }
      }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }
});

describe("native validation environment probes", () => {
  it("joins the blocked-read fixture when its server cannot be spawned", async () => {
    const f = fixture();
    await expect(blockedReadPipe(f.directory, path.join(f.directory, "missing-fixture-executable"))).rejects.toMatchObject({ code: "ENOENT" });
  }, 10_000);

  it("persists and streams command identity before launch and completed evidence before returning", () => {
    const f = fixture();
    let executions = 0;
    const recorder = createValidationProbeRecorder({ directory: f.diagnostics, environment: f.environment,
      log: (message) => { f.log.push(message); },
      execute: (file, args, options) => {
        const pending = f.read().probes.at(-1)!;
        expect(pending.state).toBe("running");
        expect(pending.resolvedExecutable).toBe(process.execPath);
        expect(pending.launcher).toBe(process.execPath);
        expect(options).toMatchObject({ timeout: 10_000, maxBuffer: 1_048_576, shell: false, windowsHide: true, encoding: "utf8" });
        executions += 1;
        return crossSpawn.sync(file, args, options);
      },
    });
    expect(f.read().probes).toEqual([]);
    expect(recorder.command(process.execPath, ["-e", "process.stdout.write(' first\\nsecond \\n')"])).toBe("first\nsecond");
    expect(recorder.version(process.execPath)).toBe(process.version);
    expect(executions).toBe(2);
    expect(f.read().probes.map((probe) => probe.state)).toEqual(["completed", "completed"]);
    expect(f.read().error).toBeNull();
    expect(f.log.map((message) => JSON.parse(message.slice("Validation probe: ".length)).state)).toEqual([
      "resolving", "running", "completed", "resolving", "running", "completed",
    ]);
    expect(f.read().probes[0]!.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(Number.isNaN(Date.parse(f.read().probes[0]!.startedAt))).toBe(false);
  });

  it("prepares and hashes the complete selected gh file before native launch", () => {
    const f = fixture();
    const selected = f.tool("gh", "process.stdout.write('gh version fixture')");
    // Extra shell comments leave the native fixture executable while crossing multiple read chunks.
    const comment = process.platform === "win32" ? `rem ${"x".repeat(2_048)}\r\n` : `#${"x".repeat(2_048)}\n`;
    const contents = `${readFileSync(selected, "utf8")}${comment.repeat(1_100)}`;
    writeFileSync(selected, contents);
    const expectedBytes = Buffer.byteLength(contents);
    let executions = 0;
    const recorder = createValidationProbeRecorder({ directory: f.diagnostics, environment: f.environment, now: () => 0,
      log: (message) => { f.log.push(message); },
      execute: (file, args, options) => {
        executions += 1;
        const pending = f.read().probes.at(-1)!;
        expect(pending).toMatchObject({ state: "running", preparation: {
          bytesRead: expectedBytes, sha256: createHash("sha256").update(contents).digest("hex"), elapsedMs: 0, timeoutMs: 20_000,
        }, executionTimeoutMs: 10_000 });
        expect(options).toMatchObject({ timeout: 10_000, maxBuffer: 1_048_576, shell: false, windowsHide: true, encoding: "utf8" });
        expect(file).toBe("gh");
        expect(args).toEqual(["--version"]);
        return crossSpawn.sync(file, args, options);
      },
    });
    expect(recorder.version("gh")).toBe("gh version fixture");
    expect(executions).toBe(1);
    expect(f.read().probes[0]!.preparation!.helperPid).toBeGreaterThan(0);
    expect(f.read().probes[0]!.pid).toBeGreaterThan(0);
    expect(f.log.map((message) => JSON.parse(message.slice("Validation probe: ".length)).state)).toEqual([
      "resolving", "preparing", "running", "completed",
    ]);
    const preparing = JSON.parse(f.log[1]!.slice("Validation probe: ".length));
    expect(preparing.preparation).toEqual({ bytesRead: 0, sha256: null, elapsedMs: null, timeoutMs: 20_000, helperPid: null });
  });

  it("preserves a preparation read error and never launches gh after preparation fails", () => {
    const f = fixture();
    const selected = f.tool("gh", "process.stdout.write('gh version fixture')");
    const execute = vi.fn();
    const preload = path.join(f.directory, "remove-selected-before-open.cjs");
    writeFileSync(preload, `const fs=require('node:fs');const path=require('node:path');const original=fs.openSync;let removed=false;fs.openSync=function(file,...args){if(!removed&&typeof file==='string'&&path.resolve(file).toLowerCase()===path.resolve(${JSON.stringify(selected)}).toLowerCase()){fs.unlinkSync(file);removed=true}return original.call(this,file,...args)};require('node:module').syncBuiltinESMExports();`);
    const prepare = vi.fn((_request: PreparationRequest, options: SpawnSyncOptionsWithStringEncoding) => crossSpawn.sync(process.execPath,
      ["--require", preload, helperScript, "--daynight-gh-provenance-helper"], options));
    const recorder = createValidationProbeRecorder({ directory: f.diagnostics, environment: f.environment, log: () => {}, execute, prepare });
    let failure: unknown;
    try { recorder.version("gh"); } catch (error) { failure = error; }
    expect(failure).toMatchObject({ name: "Error", code: "ENOENT", syscall: "open" });
    expect((failure as NodeJS.ErrnoException).path!.toLowerCase()).toBe(selected.toLowerCase());
    expect(execute).not.toHaveBeenCalled();
    expect(f.read().probes[0]).toMatchObject({ state: "failed", failurePhase: "preparing", pid: null, executionTimeoutMs: null,
      preparation: { bytesRead: 0, sha256: null }, error: { code: "ENOENT", syscall: "open" } });
  });

  it("preserves a helper-reported I/O error and partial byte count", () => {
    const f = fixture();
    const selected = f.tool("gh", "process.stdout.write('gh version fixture')");
    const error = { name: "Error", message: "fixture read failure", code: "EIO", errno: -5, syscall: "read", path: selected };
    const prepare = vi.fn((_request: PreparationRequest, options: SpawnSyncOptionsWithStringEncoding) => {
      const resolved = { kind: "resolved", resolvedExecutable: selected, launcher: process.execPath,
        parsed: { command: process.execPath, args: [], file: selected, windowsVerbatimArguments: false, original: { command: "gh", args: ["--version"] } } };
      const lines = [resolved, { kind: "progress", bytesRead: 1024 }, { kind: "error", bytesRead: 1024, error }];
      return crossSpawn.sync(process.execPath, ["-e", `process.stdout.write(${JSON.stringify(`${lines.map(line => JSON.stringify(line)).join("\n")}\n`)})`], options);
    });
    const execute = vi.fn();
    const recorder = createValidationProbeRecorder({ directory: f.diagnostics, environment: f.environment, log: () => {}, execute, prepare });
    let failure: unknown;
    try { recorder.version("gh"); } catch (caught) { failure = caught; }
    expect(failure).toMatchObject(error);
    expect(execute).not.toHaveBeenCalled();
    expect(f.read().probes[0]).toMatchObject({ state: "failed", failurePhase: "preparing", pid: null, executionTimeoutMs: null,
      preparation: { bytesRead: 1024, sha256: null }, error: { code: "EIO", syscall: "read" } });
  });

  it.each(["EIO", "preparing", "failed"])("keeps structured failure fields when a token equals %s", (token) => {
    const f = fixture();
    const selected = f.tool("gh", "process.stdout.write('gh version fixture')");
    f.environment.GH_TOKEN = token;
    const prepare = vi.fn((_request: PreparationRequest, options: SpawnSyncOptionsWithStringEncoding) => {
      const resolved = { kind: "resolved", resolvedExecutable: selected, launcher: process.execPath,
        parsed: { command: process.execPath, args: [], file: selected, windowsVerbatimArguments: false, original: { command: "gh", args: ["--version"] } } };
      const error = { name: "Error", message: `fixture secret ${token}`, code: "EIO", errno: -5, syscall: "read" };
      const lines = [resolved, { kind: "error", bytesRead: 0, error }];
      return crossSpawn.sync(process.execPath, ["-e", `process.stdout.write(${JSON.stringify(`${lines.map(line => JSON.stringify(line)).join("\n")}\n`)})`], options);
    });
    const execute = vi.fn();
    const recorder = createValidationProbeRecorder({ directory: f.diagnostics, environment: f.environment, log: message => f.log.push(message), prepare, execute });
    expect(() => recorder.version("gh")).toThrow();
    expect(execute).not.toHaveBeenCalled();
    const probe = f.read().probes[0]!;
    expect(probe).toMatchObject({ state: "failed", failurePhase: "preparing", error: { code: "EIO", syscall: "read" } });
    expect(probe.error!.message).not.toContain(token);
    const final = JSON.parse(f.log.at(-1)!.slice("Validation probe: ".length));
    expect(final).toMatchObject({ state: "failed", failurePhase: "preparing", error: { code: "EIO", syscall: "read" } });
    expect(final.error.message).not.toContain(token);
  });

  it("preserves both native read and close errors from the real helper", () => {
    const f = fixture();
    const selected = f.tool("gh", "process.stdout.write('gh version fixture')");
    const preload = path.join(f.directory, "fail-read-and-close.cjs");
    writeFileSync(preload, `const fs=require('node:fs');const path=require('node:path');const originalOpen=fs.openSync,originalRead=fs.readSync,originalClose=fs.closeSync;let target;
      fs.openSync=function(file,...args){const fd=originalOpen.call(this,file,...args);if(typeof file==='string'&&path.resolve(file).toLowerCase()===path.resolve(${JSON.stringify(selected)}).toLowerCase())target=fd;return fd};
      fs.readSync=function(fd,...args){if(fd===target)throw Object.assign(new Error('fixture read failure'),{code:'EIO',errno:-5,syscall:'read'});return originalRead.call(this,fd,...args)};
      fs.closeSync=function(fd){const result=originalClose.call(this,fd);if(fd===target)throw Object.assign(new Error('fixture close failure'),{code:'EBUSY',errno:-16,syscall:'close'});return result};
      require('node:module').syncBuiltinESMExports();`);
    const prepare = vi.fn((_request: PreparationRequest, options: SpawnSyncOptionsWithStringEncoding) => crossSpawn.sync(process.execPath,
      ["--require", preload, helperScript, "--daynight-gh-provenance-helper"], options));
    const execute = vi.fn();
    const recorder = createValidationProbeRecorder({ directory: f.diagnostics, environment: f.environment, log: () => {}, execute, prepare });
    let failure: unknown;
    try { recorder.version("gh"); } catch (caught) { failure = caught; }
    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure).toMatchObject({ name: "AggregateError", cause: { code: "EIO", errno: -5, syscall: "read", message: "fixture read failure" },
      errors: [{ code: "EIO", errno: -5, syscall: "read", message: "fixture read failure" }, { code: "EBUSY", errno: -16, syscall: "close", message: "fixture close failure" }] });
    expect(execute).not.toHaveBeenCalled();
    expect(f.read().probes[0]).toMatchObject({ state: "failed", failurePhase: "preparing", pid: null, executionTimeoutMs: null,
      preparation: { bytesRead: 0, sha256: null }, error: { name: "AggregateError", cause: { code: "EIO" }, errors: [{ code: "EIO" }, { code: "EBUSY" }] } });
  });

  it("fails closed when the preparation helper returns no digest", () => {
    const f = fixture();
    const selected = f.tool("gh", "process.stdout.write('gh version fixture')");
    const prepare = vi.fn((_request: PreparationRequest, options: SpawnSyncOptionsWithStringEncoding) => {
      const resolved = { kind: "resolved", resolvedExecutable: selected, launcher: process.execPath,
        parsed: { command: process.execPath, args: [], file: selected, windowsVerbatimArguments: false, original: { command: "gh", args: ["--version"] } } };
      const lines = [resolved, { kind: "progress", bytesRead: 1 }];
      return crossSpawn.sync(process.execPath, ["-e", `process.stdout.write(${JSON.stringify(`${lines.map(line => JSON.stringify(line)).join("\n")}\n`)})`], options);
    });
    const execute = vi.fn();
    const recorder = createValidationProbeRecorder({ directory: f.diagnostics, environment: f.environment, log: () => {}, execute, prepare });
    expect(() => recorder.version("gh")).toThrow();
    expect(execute).not.toHaveBeenCalled();
    expect(f.read().probes[0]).toMatchObject({ state: "failed", failurePhase: "preparing", pid: null, executionTimeoutMs: null,
      preparation: { sha256: null } });
  });

  it("launches gh with its full execution budget after a slow multi-chunk preparation", () => {
    const f = fixture();
    const selected = f.tool("gh", "process.stdout.write('gh version fixture')");
    const comment = process.platform === "win32" ? `rem ${"x".repeat(2_048)}\r\n` : `#${"x".repeat(2_048)}\n`;
    const contents = `${readFileSync(selected, "utf8")}${comment.repeat(1_100)}`;
    writeFileSync(selected, contents);
    let clock = 0;
    const prepare = vi.fn((_request: PreparationRequest, options: SpawnSyncOptionsWithStringEncoding) => {
      const result = crossSpawn.sync(process.execPath, [helperScript, "--daynight-gh-provenance-helper"], options);
      clock = 9_750;
      return result;
    });
    const execute = vi.fn((file, args, options) => {
      expect(options.timeout).toBe(10_000);
      const result = crossSpawn.sync(file, args, options);
      clock = 19_749.5;
      return result;
    });
    const recorder = createValidationProbeRecorder({ directory: f.diagnostics, environment: f.environment, now: () => clock, log: () => {}, execute, prepare });
    expect(recorder.version("gh")).toBe("gh version fixture");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(f.read().probes[0]).toMatchObject({ state: "completed", failurePhase: null, pid: expect.any(Number), executionTimeoutMs: 10_000,
      executionElapsedMs: 9_999.5, elapsedMs: 19_749.5, preparation: { timeoutMs: 20_000, elapsedMs: 9_750,
        bytesRead: Buffer.byteLength(contents), sha256: createHash("sha256").update(contents).digest("hex") } });
    expect(f.read().probes[0]!.pid).toBeGreaterThan(0);
  });

  it("terminates and reaps a preparation helper blocked on a real read without starting gh", async () => {
    const f = fixture();
    const selected = f.tool("gh", "process.stdout.write('gh version fixture')");
    const marker = path.join(f.directory, "helper-started.json");
    const { pipe, close } = await blockedReadPipe(f.directory);
    try {
      const preload = path.join(f.directory, "block-selected-read.cjs");
      writeFileSync(preload, `const fs=require('node:fs');const path=require('node:path');const originalOpen=fs.openSync,originalRead=fs.readSync;let target;
        fs.openSync=function(file,...args){if(typeof file==='string'&&path.resolve(file).toLowerCase()===path.resolve(${JSON.stringify(selected)}).toLowerCase()){target=originalOpen.call(this,${JSON.stringify(pipe)},'r');return target}return originalOpen.call(this,file,...args)};
        fs.readSync=function(fd,...args){const n=originalRead.call(this,fd,...args);if(fd===target&&n>0)fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({pid:process.pid}));return n};require('node:module').syncBuiltinESMExports();`);
      const prepare = vi.fn((_request: PreparationRequest, options: SpawnSyncOptionsWithStringEncoding) => crossSpawn.sync(process.execPath,
        ["--require", preload, helperScript, "--daynight-gh-provenance-helper"], options));
      const execute = vi.fn();
      const recorder = createValidationProbeRecorder({ directory: f.diagnostics, environment: f.environment, preparationTimeoutMs: 2_000, log: () => {}, execute, prepare });
      expect(() => recorder.version("gh")).toThrow("Cannot prepare gh --version within 2000ms.");
      expect(prepare).toHaveBeenCalledTimes(1);
      expect(execute).not.toHaveBeenCalled();
      const { pid } = JSON.parse(readFileSync(marker, "utf8")) as { pid: number };
      expect(pid).toBeGreaterThan(0);
      let processError: unknown;
      try { process.kill(pid, 0); } catch (error) { processError = error; }
      expect(processError).toMatchObject({ code: "ESRCH" });
      expect(f.read().probes[0]).toMatchObject({ state: "failed", failurePhase: "preparing", pid: null, executionTimeoutMs: null, executionElapsedMs: null,
        preparation: { bytesRead: 1, sha256: null, timeoutMs: 2_000, helperPid: pid }, error: { code: "ETIMEDOUT" } });
    } finally { await close(); }
  }, 20_000);

  it("terminates and reaps the helper when command resolution blocks without launching gh", async () => {
    const f = fixture();
    const selected = f.tool("gh", "process.stdout.write('gh version fixture')");
    const marker = path.join(f.directory, "resolution-blocked.json");
    const { pipe, close } = await blockedReadPipe(f.directory);
    try {
      const preload = path.join(f.directory, "block-command-stat.cjs");
      writeFileSync(preload, `const fs=require('node:fs');const path=require('node:path');const original=fs.statSync;
        fs.statSync=function(file,...args){if(typeof file==='string'&&path.resolve(file).toLowerCase()===path.resolve(${JSON.stringify(selected)}).toLowerCase()){const fd=fs.openSync(${JSON.stringify(pipe)},'r');const b=Buffer.alloc(1);fs.readSync(fd,b,0,1,null);fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({pid:process.pid}));fs.readSync(fd,b,0,1,null)}return original.call(this,file,...args)};require('node:module').syncBuiltinESMExports();`);
      const prepare = vi.fn((_request: PreparationRequest, options: SpawnSyncOptionsWithStringEncoding) => crossSpawn.sync(process.execPath,
        ["--require", preload, helperScript, "--daynight-gh-provenance-helper"], options));
      const execute = vi.fn();
      const recorder = createValidationProbeRecorder({ directory: f.diagnostics, environment: f.environment, preparationTimeoutMs: 2_000, log: () => {}, execute, prepare });
      expect(() => recorder.version("gh")).toThrow("Cannot prepare gh --version within 2000ms.");
      expect(execute).not.toHaveBeenCalled();
      const { pid } = JSON.parse(readFileSync(marker, "utf8")) as { pid: number };
      let processError: unknown;
      try { process.kill(pid, 0); } catch (error) { processError = error; }
      expect(processError).toMatchObject({ code: "ESRCH" });
      expect(f.read().probes[0]).toMatchObject({ state: "failed", failurePhase: "resolving", resolvedExecutable: null, pid: null,
        executionTimeoutMs: null, executionElapsedMs: null, preparation: { timeoutMs: 2_000, bytesRead: 0, sha256: null, helperPid: pid }, error: { code: "ETIMEDOUT" } });
      expect(f.read().probes[0]!.preparation!.elapsedMs).toBeGreaterThan(0);
    } finally { await close(); }
  }, 20_000);

  it("rejects native success after its independent execution deadline", () => {
    const f = fixture();
    f.tool("gh", "process.stdout.write('partial gh')");
    let clock = 0;
    const execute = vi.fn((file, args, options) => {
      expect(options.timeout).toBe(10_000);
      const result = crossSpawn.sync(file, args, options);
      clock = 13_501;
      return result;
    });
    const recorder = createValidationProbeRecorder({ directory: f.diagnostics, environment: f.environment, now: () => clock,
      log: (message) => {
        if (JSON.parse(message.slice("Validation probe: ".length)).state === "preparing") clock = 3_500;
      }, execute,
    });
    expect(() => recorder.version("gh")).toThrow("Cannot execute gh --version within 10000ms.");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(f.read().probes[0]).toMatchObject({ state: "failed", failurePhase: "running", exitCode: 0, stdout: "partial gh", elapsedMs: 13_501,
      executionTimeoutMs: 10_000, executionElapsedMs: 10_001, error: { code: "ETIMEDOUT" } });
  });

  it("does not charge prelaunch diagnostic persistence against the gh execution timeout", () => {
    const f = fixture();
    f.tool("gh", "process.stdout.write('gh version fixture')");
    let clock = 0;
    const recorder = createValidationProbeRecorder({ directory: f.diagnostics, environment: f.environment, now: () => clock,
      log: (message) => { if (JSON.parse(message.slice("Validation probe: ".length)).state === "running") clock = 3_500.25; },
      execute: (file, args, options) => {
        expect(options.timeout).toBe(10_000);
        return crossSpawn.sync(file, args, options);
      },
    });
    expect(recorder.version("gh")).toBe("gh version fixture");
    expect(f.read().probes[0]!.executionTimeoutMs).toBe(10_000);
  });

  it("preserves a native gh timeout and its partial output even after the absolute deadline", () => {
    const f = fixture();
    f.tool("gh", "process.stdout.write('gh version fixture')");
    let clock = 0;
    let originalError: Error | undefined;
    const execute = vi.fn((file, args, options) => {
      expect(file).toBe("gh");
      expect(args).toEqual(["--version"]);
      const result = crossSpawn.sync(process.execPath, ["-e", "process.stdout.write('partial gh');process.stderr.write('gh timeout stderr');setInterval(()=>{},1000)"], { ...options, timeout: 2_000 });
      originalError = result.error;
      clock = 10_001;
      return result;
    });
    const recorder = createValidationProbeRecorder({ directory: f.diagnostics, environment: f.environment, now: () => clock, log: () => {}, execute });
    let failure: unknown;
    try { recorder.version("gh"); } catch (error) { failure = error; }
    expect(failure).toBe(originalError);
    expect(originalError).toMatchObject({ code: "ETIMEDOUT" });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(f.read().probes[0]).toMatchObject({ state: "failed", failurePhase: "running", stdout: "partial gh", stderr: "gh timeout stderr", elapsedMs: 10_001,
      error: { code: "ETIMEDOUT", syscall: `spawnSync ${process.execPath}` } });
  }, 10_000);

  it("does not convert a fractional preparation budget into an unlimited helper timeout", () => {
    const f = fixture();
    f.tool("gh", "process.stdout.write('gh version fixture')");
    let clock = 0;
    const execute = vi.fn(), prepare = vi.fn();
    const recorder = createValidationProbeRecorder({ directory: f.diagnostics, environment: f.environment, now: () => clock,
      log: (message) => { if (JSON.parse(message.slice("Validation probe: ".length)).state === "preparing") clock = 19_999.5; }, execute, prepare,
    });
    expect(() => recorder.version("gh")).toThrow("within 20000ms");
    expect(prepare).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it("records the checked elapsed snapshot when the clock advances after gh completion", () => {
    const f = fixture();
    f.tool("gh", "process.stdout.write('gh version fixture')");
    let clock = 0;
    let completed = false;
    let finalClockReads = 0;
    const recorder = createValidationProbeRecorder({ directory: f.diagnostics, environment: f.environment,
      now: () => {
        if (completed) {
          finalClockReads += 1;
          clock = finalClockReads === 1 ? 9_999 : 10_000;
        }
        return clock;
      }, log: () => {},
      execute: (file, args, options) => {
        const result = crossSpawn.sync(file, args, options);
        completed = true;
        return result;
      },
    });
    expect(recorder.version("gh")).toBe("gh version fixture");
    expect(f.read().probes[0]).toMatchObject({ state: "completed", exitCode: 0, elapsedMs: 9_999, stdout: "gh version fixture", error: null });
  });

  it("accepts native success completed within the last fractional millisecond of the gh budget", () => {
    const f = fixture();
    f.tool("gh", "process.stdout.write('gh version fixture')");
    let clock = 0;
    const recorder = createValidationProbeRecorder({ directory: f.diagnostics, environment: f.environment, now: () => clock, log: () => {},
      execute: (file, args, options) => {
        const result = crossSpawn.sync(file, args, options);
        clock = 9_999.5;
        return result;
      },
    });
    expect(recorder.version("gh")).toBe("gh version fixture");
    expect(f.read().probes[0]).toMatchObject({ state: "completed", elapsedMs: 9_999.5 });
  });

  it.each(["resolving", "preparing"])("never launches gh when its preparation budget expires while %s", (state) => {
    const f = fixture();
    f.tool("gh", "process.stdout.write('gh version fixture')");
    let clock = 0;
    const execute = vi.fn();
    const recorder = createValidationProbeRecorder({ directory: f.diagnostics, environment: f.environment, now: () => clock,
      log: (message) => { if (JSON.parse(message.slice("Validation probe: ".length)).state === state) clock = 20_000; }, execute,
    });
    expect(() => recorder.version("gh")).toThrow("within 20000ms");
    expect(execute).not.toHaveBeenCalled();
    expect(f.read().probes[0]).toMatchObject({ state: "failed", pid: null, error: { code: "ETIMEDOUT" } });
  });

  it("saves nonzero results and both output streams before propagating failure", () => {
    const f = fixture();
    expect(() => f.recorder().command(process.execPath, ["-e", "process.stdout.write('partial out');process.stderr.write('partial err');process.exitCode=7"])).toThrow("exit=7");
    expect(f.read().probes[0]).toMatchObject({ state: "failed", exitCode: 7, stdout: "partial out", stderr: "partial err", resolvedExecutable: process.execPath });
    expect(f.read().error?.message).toContain("exit=7");
  });

  it("rejects an empty native version response with its persisted result", () => {
    const f = fixture();
    const executable = f.tool("empty-version", "");
    expect(() => f.recorder().version("empty-version")).toThrow("version command returned no output");
    expect(f.read().probes[0]).toMatchObject({ state: "failed", exitCode: 0, stdout: "" });
    expect(f.read().probes[0]!.resolvedExecutable?.toLowerCase()).toBe(executable.toLowerCase());
    expect(path.basename(f.read().probes[0]!.launcher!).toLowerCase()).toBe(process.platform === "win32" ? "cmd.exe" : "empty-version");
  });

  it("saves partial output and the original native timeout error without retrying", () => {
    const f = fixture();
    let executions = 0;
    let originalError: Error | undefined;
    const recorder = createValidationProbeRecorder({ directory: f.diagnostics, environment: f.environment, log: () => {},
      execute: (file, args, options) => {
        executions += 1;
        expect(options.timeout).toBe(10_000);
        const result = crossSpawn.sync(file, args, { ...options, timeout: 2_000 });
        originalError = result.error;
        return result;
      },
    });
    let failure: unknown;
    try { recorder.command(process.execPath, ["-e", "process.stdout.write('before timeout');process.stderr.write('timeout stderr');setInterval(()=>{},1000)"]); }
    catch (error) { failure = error; }
    expect(executions).toBe(1);
    expect(failure).toBe(originalError);
    expect(originalError).toMatchObject({ code: "ETIMEDOUT" });
    expect(f.read().probes[0]).toMatchObject({ state: "failed", stdout: "before timeout", stderr: "timeout stderr", resolvedExecutable: process.execPath,
      error: { name: "Error", code: "ETIMEDOUT", syscall: `spawnSync ${process.execPath}` } });
    expect(f.read().error?.code).toBe("ETIMEDOUT");
    expect(f.read().probes[0]!.preparation).toBeNull();
  }, 10_000);

  it("keeps diagnostic output bounded without truncating a successful command's return value", () => {
    const f = fixture();
    const result = f.recorder().command(process.execPath, ["-e", "process.stdout.write('o'.repeat(20000));process.stderr.write('e'.repeat(20000))"]);
    expect(result).toHaveLength(20_000);
    const probe = f.read().probes[0]!;
    expect(probe.stdout).toBe("o".repeat(16_384));
    expect(probe.stderr).toBe("e".repeat(16_384));
    expect(probe).toMatchObject({ state: "completed", stdoutTruncated: true, stderrTruncated: true, maxBuffer: 1_048_576 });
  });

  it("preserves the native maxBuffer failure and bounded evidence", () => {
    const f = fixture();
    expect(() => f.recorder().command(process.execPath, ["-e", "process.stdout.write('x'.repeat(2*1024*1024))"])).toThrow();
    expect(f.read().probes[0]).toMatchObject({ state: "failed", stdoutTruncated: true, error: { code: "ENOBUFS" } });
    expect(f.read().probes[0]!.stdout).toHaveLength(16_384);
  });

  it("records command lookup failures before rethrowing their native errors", () => {
    const f = fixture();
    expect(() => f.recorder().version("daynight-tool-that-does-not-exist")).toThrow();
    expect(f.read().probes[0]).toMatchObject({ state: "failed", resolvedExecutable: null, error: { code: "ENOENT" } });
  });

  it("lets the native launcher report a missing gh without preparing another file", () => {
    const f = fixture();
    f.environment.PATH = f.bin;
    let originalError: Error | undefined;
    const execute = vi.fn((file, args, options) => {
      const result = crossSpawn.sync(file, args, options);
      originalError = result.error;
      return result;
    });
    const recorder = createValidationProbeRecorder({ directory: f.diagnostics, environment: f.environment, log: () => {}, execute });
    let failure: unknown;
    try { recorder.version("gh"); } catch (error) { failure = error; }
    expect(failure).toBe(originalError);
    expect(originalError).toMatchObject({ code: "ENOENT" });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(f.read().probes[0]).toMatchObject({ state: "failed", resolvedExecutable: null, preparation: null, error: { code: "ENOENT" } });
  });

  it.runIf(process.platform === "win32")("matches cross-spawn when the child PATH is empty", () => {
    const f = fixture();
    f.environment.PATH = "";
    const baseline = crossSpawn.sync("gh", ["--version"], { cwd: process.cwd(), env: f.environment, encoding: "utf8", shell: false, windowsHide: true, timeout: 10_000, maxBuffer: 1_048_576 });
    expect(baseline.error).toMatchObject({ code: "ENOENT" });
    const recorder = f.recorder();
    let failure: unknown;
    try { recorder.version("gh"); } catch (error) { failure = error; }
    expect(failure).toMatchObject({ name: baseline.error!.name, code: "ENOENT", syscall: (baseline.error as NodeJS.ErrnoException).syscall });
    expect(f.read().probes[0]).toMatchObject({ state: "failed", failurePhase: "running", error: { code: "ENOENT" } });
  });

  it("isolates only the gh child and preserves inherited configuration, credentials, and the parent environment", () => {
    const f = fixture();
    const parent = path.join(f.directory, "parent-config");
    mkdirSync(parent);
    const hostsFile = path.join(parent, "hosts.yml");
    writeFileSync(hostsFile, "fixture-auth-config");
    Object.assign(f.environment, { GH_CONFIG_DIR: parent, XDG_STATE_HOME: parent, XDG_DATA_HOME: parent, GH_TELEMETRY: "enabled", GH_TOKEN: "fixture-secret-not-for-evidence" });
    const originalEnvironment = { ...f.environment };
    const originalParentEnvironment = { ...process.env };
    f.tool("gh", `const fs=require('node:fs');const path=require('node:path');
      if(process.env.GH_TELEMETRY!=='0')throw new Error('telemetry not disabled');
      for(const name of ['GH_CONFIG_DIR','XDG_STATE_HOME','XDG_DATA_HOME']){fs.mkdirSync(process.env[name],{recursive:true});fs.writeFileSync(path.join(process.env[name],'marker'),'isolated');}
      process.stdout.write('gh version fixture\\nrelease URL\\n');`);
    f.tool("other", `if(process.env.GH_CONFIG_DIR!==${JSON.stringify(parent)}||process.env.GH_TELEMETRY!=='enabled')throw new Error('parent configuration changed');process.stdout.write('other version fixture');`);
    const recorder = f.recorder();
    expect(recorder.version("gh")).toBe("gh version fixture");
    expect(recorder.version("other")).toBe("other version fixture");
    for (const directory of ["config", "state", "data"]) expect(readFileSync(path.join(f.diagnostics, "gh", directory, "marker"), "utf8")).toBe("isolated");
    expect(readFileSync(hostsFile, "utf8")).toBe("fixture-auth-config");
    expect(existsSync(path.join(parent, "marker"))).toBe(false);
    expect(f.environment).toEqual(originalEnvironment);
    expect(process.env).toEqual(originalParentEnvironment);
    expect(JSON.stringify(f.read())).not.toContain("fixture-secret-not-for-evidence");
    expect(f.log.join("")).not.toContain("fixture-secret-not-for-evidence");
    expect(f.read().probes[0]!.preparation?.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(f.read().probes[1]!.preparation).toBeNull();
  });

  it.each([false, true])("redacts inherited tokens from gh output and diagnostics (failure=%s)", (fail) => {
    const f = fixture();
    const token = "ghs_fixture_secret_that_must_not_escape", apiKey = "fixture_api_key_that_must_not_escape";
    Object.assign(f.environment, { GH_TOKEN: token, OPENAI_API_KEY: apiKey });
    f.tool("gh", `process.stdout.write('gh version '+process.env.GH_TOKEN+' '+process.env.OPENAI_API_KEY);process.stderr.write('stderr '+process.env.GH_TOKEN+' '+process.env.OPENAI_API_KEY);process.exitCode=${fail ? 7 : 0};`);
    const recorder = f.recorder();
    let result: string | undefined, failure: unknown;
    try { result = recorder.version("gh"); } catch (error) { failure = error; }
    if (fail) expect(failure).toBeInstanceOf(Error);
    else expect(result).toContain("gh version");
    for (const secret of [token, apiKey]) {
      expect(result ?? "").not.toContain(secret);
      expect(String(failure ?? "")).not.toContain(secret);
      expect(JSON.stringify(f.read())).not.toContain(secret);
      expect(f.log.join("")).not.toContain(secret);
    }
    expect(f.environment).toMatchObject({ GH_TOKEN: token, OPENAI_API_KEY: apiKey });
  });

  it("preserves the full SHA-256 when a token matches part of the digest", () => {
    const f = fixture();
    const selected = f.tool("gh", "process.stdout.write('gh version '+process.env.GH_TOKEN)");
    const expectedHash = createHash("sha256").update(readFileSync(selected)).digest("hex");
    const token = expectedHash.slice(0, 8);
    f.environment.GH_TOKEN = token;
    const recorder = f.recorder();
    expect(recorder.version("gh")).not.toContain(token);
    const probe = f.read().probes[0]!;
    expect(probe.preparation!.sha256).toBe(expectedHash);
    expect(probe.stdout).not.toContain(token);
    expect(f.log.map(message => JSON.parse(message.slice("Validation probe: ".length))).at(-1).preparation.sha256).toBe(expectedHash);
  });

  it("keeps NODE_OPTIONS on gh while excluding it from the real provenance helper", () => {
    const f = fixture();
    const preload = path.join(f.directory, "inherited-preload.cjs");
    writeFileSync(preload, "process.stdout.write('fixture preload\\n')");
    f.environment.NODE_OPTIONS = `--require=${JSON.stringify(preload)}`;
    f.tool("gh", "process.stdout.write('gh version fixture')");
    vi.stubEnv("NODE_OPTIONS", f.environment.NODE_OPTIONS);
    try {
      let childEnvironment: NodeJS.ProcessEnv | undefined;
      const recorder = createValidationProbeRecorder({ directory: f.diagnostics, environment: f.environment, log: () => {},
        execute: (file, args, options) => { childEnvironment = options.env; return crossSpawn.sync(file, args, options); },
      });
      expect(recorder.version("gh")).toBe("fixture preload");
      expect(childEnvironment!.NODE_OPTIONS).toBe(f.environment.NODE_OPTIONS);
      expect(f.read().probes[0]).toMatchObject({ state: "completed", stdout: "fixture preload\ngh version fixture", preparation: { sha256: expect.stringMatching(/^[a-f0-9]{64}$/) } });
    } finally { vi.unstubAllEnvs(); }
  });

  it("passes no inherited credentials to the helper while preserving the gh child environment", () => {
    const f = fixture();
    const token = "fixture_secret_helper_must_not_receive", apiKey = "fixture_helper_api_key";
    Object.assign(f.environment, { GH_TOKEN: token, OPENAI_API_KEY: apiKey });
    f.tool("gh", "process.stdout.write(process.env.GH_TOKEN?'gh version fixture':'missing token')");
    vi.stubEnv("GH_TOKEN", token); vi.stubEnv("OPENAI_API_KEY", apiKey);
    try {
      const prepare = vi.fn((request: PreparationRequest, options: SpawnSyncOptionsWithStringEncoding) => {
        expect(JSON.stringify(request)).not.toContain(token);
        expect(JSON.stringify(request)).not.toContain(apiKey);
        expect(JSON.stringify(options.env)).not.toContain(token);
        expect(JSON.stringify(options.env)).not.toContain(apiKey);
        expect(String(options.input)).not.toContain(token);
        expect(String(options.input)).not.toContain(apiKey);
        return crossSpawn.sync(process.execPath, [helperScript, "--daynight-gh-provenance-helper"], options);
      });
      const execute = vi.fn((file, args, options) => {
        expect(options.env).toMatchObject({ GH_TOKEN: token, OPENAI_API_KEY: apiKey });
        return crossSpawn.sync(file, args, options);
      });
      const recorder = createValidationProbeRecorder({ directory: f.diagnostics, environment: f.environment, log: () => {}, prepare, execute });
      expect(recorder.version("gh")).toBe("gh version fixture");
      expect(prepare).toHaveBeenCalledTimes(1);
      expect(execute).toHaveBeenCalledTimes(1);
    } finally { vi.unstubAllEnvs(); }
  });

  it("redacts inherited secrets from the script's real failed process output", () => {
    const f = fixture();
    const token = "fixture_main_gh_token", apiKey = "fixture_main_openai_api_key";
    Object.assign(f.environment, { GH_TOKEN: token, OPENAI_API_KEY: apiKey });
    f.tool("git", "process.stdout.write(process.argv[2]==='rev-parse'?'a'.repeat(40):process.argv[2]==='--version'?'git version fixture':'')");
    f.tool("pnpm", "process.stdout.write('11.28.6')");
    f.tool("gh", "process.stdout.write(process.env.GH_TOKEN);process.stderr.write(process.env.OPENAI_API_KEY);process.exitCode=23");
    const result = crossSpawn.sync(process.execPath, [path.resolve(import.meta.dirname, "../../scripts/validation-environment.ts")], {
      cwd: f.directory, env: f.environment, encoding: "utf8", shell: false, windowsHide: true, timeout: 30_000, maxBuffer: 1_048_576,
    });
    if (result.error) throw result.error;
    expect(result.status).toBe(1);
    const evidence = readFileSync(path.join(f.directory, ".tmp", "validation-probes.json"), "utf8");
    for (const secret of [token, apiKey]) {
      expect(result.stdout).not.toContain(secret);
      expect(result.stderr).not.toContain(secret);
      expect(evidence).not.toContain(secret);
    }
  }, 40_000);

  it.runIf(process.platform === "win32")("records the PATHEXT-selected shim and its native command interpreter", () => {
    const f = fixture();
    f.tool("ordered-tool", "process.stdout.write('cmd version')", ".cmd");
    const selected = f.tool("ordered-tool", "process.stdout.write('bat version')", ".bat");
    const pathExtensions = ".BAT;.CMD;.EXE;.COM";
    f.environment.PATHEXT = pathExtensions;
    // which@2 reads the parent PATHEXT, as does the pinned cross-spawn launcher.
    vi.stubEnv("PATHEXT", pathExtensions);
    try {
      expect(f.recorder().version("ordered-tool")).toBe("bat version");
      expect(f.read().probes[0]!.resolvedExecutable?.toLowerCase()).toBe(selected.toLowerCase());
      expect(path.basename(f.read().probes[0]!.launcher!).toLowerCase()).toBe("cmd.exe");
    } finally { vi.unstubAllEnvs(); }
  });

  it.runIf(process.platform === "win32")("prepares and launches the PATHEXT-selected gh shim", () => {
    const f = fixture();
    f.tool("gh", "process.stdout.write('cmd gh')", ".cmd");
    const selected = f.tool("gh", "process.stdout.write('bat gh')", ".bat");
    const pathExtensions = ".BAT;.CMD;.EXE;.COM";
    f.environment.PATHEXT = pathExtensions;
    vi.stubEnv("PATHEXT", pathExtensions);
    try {
      expect(f.recorder().version("gh")).toBe("bat gh");
      const probe = f.read().probes[0]!;
      expect(probe.resolvedExecutable!.toLowerCase()).toBe(selected.toLowerCase());
      expect(path.basename(probe.launcher!).toLowerCase()).toBe("cmd.exe");
      expect(probe.preparation!.sha256).toBe(createHash("sha256").update(readFileSync(selected)).digest("hex"));
      expect(probe.pid).toBeGreaterThan(0);
    } finally { vi.unstubAllEnvs(); }
  });

  it.each([
    ["two words", 'literal"quote'],
    ["two words", "alpha&beta", "one^two", "trailing\\"],
    ["two words", 'literal"quote', "alpha&beta", "one^two", "trailing\\"],
  ])("matches cross-spawn for gh arguments %j", (...args) => {
    const f = fixture();
    f.tool("gh", "process.stdout.write(JSON.stringify(process.argv.slice(2)))");
    const baseline = crossSpawn.sync("gh", args, { cwd: process.cwd(), env: f.environment, encoding: "utf8", shell: false, windowsHide: true, timeout: 10_000, maxBuffer: 1_048_576 });
    if (baseline.error) throw baseline.error;
    const recorder = f.recorder();
    if (baseline.status === 0) {
      expect(JSON.parse(recorder.command("gh", args))).toEqual(args);
    } else {
      expect(() => recorder.command("gh", args)).toThrow(`exit=${baseline.status}`);
    }
    expect(f.read().probes[0]).toMatchObject({ state: baseline.status === 0 ? "completed" : "failed", args, executionTimeoutMs: 10_000,
      exitCode: baseline.status, signal: baseline.signal, stdout: baseline.stdout, stderr: baseline.stderr });
  });

  it.each([false, true])("writes full provenance only after every native tool succeeds (gh failure=%s)", (fail) => {
    const f = fixture();
    f.tool("git", "process.stdout.write(process.argv[2]==='rev-parse'?'a'.repeat(40):process.argv[2]==='--version'?'git version fixture':'')");
    f.tool("pnpm", "process.stdout.write('11.28.6')");
    f.tool("gh", fail ? "process.stdout.write('partial gh');process.stderr.write('fixture gh failure');process.exitCode=23" : "process.stdout.write('gh version fixture')");
    const result = crossSpawn.sync(process.execPath, [path.resolve(import.meta.dirname, "../../scripts/validation-environment.ts")], {
      cwd: f.directory, env: f.environment, encoding: "utf8", shell: false, windowsHide: true, timeout: 30_000, maxBuffer: 1_048_576,
    });
    if (result.error !== undefined && result.error !== null) throw result.error;
    expect(result.status).toBe(fail ? 1 : 0);
    const evidenceDirectory = path.join(f.directory, ".tmp");
    const diagnostics = JSON.parse(readFileSync(path.join(evidenceDirectory, "validation-probes.json"), "utf8")) as Diagnostics;
    expect(diagnostics.probes).toHaveLength(5);
    expect(diagnostics.probes.at(-1)!.file).toBe("gh");
    expect(existsSync(path.join(evidenceDirectory, "validation-environment.json"))).toBe(!fail);
    if (fail) expect(diagnostics.probes.at(-1)).toMatchObject({ state: "failed", exitCode: 23, stdout: "partial gh", stderr: "fixture gh failure" });
    else {
      const evidence = JSON.parse(readFileSync(path.join(evidenceDirectory, "validation-environment.json"), "utf8"));
      expect(evidence).toMatchObject({ sourceRevision: "a".repeat(40), sourceDirty: false, versions: { node: process.version, pnpm: "11.28.6", git: "git version fixture", gh: "gh version fixture" } });
      expect(evidence.sqlite.engineVersion).not.toBe("");
      expect(diagnostics.probes.every((probe) => probe.state === "completed")).toBe(true);
    }
  }, 40_000);
});
