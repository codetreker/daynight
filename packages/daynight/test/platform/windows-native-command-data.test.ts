import { spawnSync } from "node:child_process";
import { getSystemErrorMap } from "node:util";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareWindowsNativeCommand, quoteWindowsNativeArgument, WindowsNativeProcessError, windowsNativeSpawnError } from "../../src/platform/windows-native-command-data.js";
import type { WindowsNativeCommandDataApi } from "../../src/platform/windows-native-command-data.js";

const boundary = vi.hoisted(() => ({ check: undefined as ((...args: unknown[]) => unknown) | undefined }));
vi.mock("node:child_process", async importOriginal => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return { ...original, spawnSync: (...args: unknown[]) => boundary.check === undefined ? Reflect.apply(original.spawnSync, undefined, args) : boundary.check(...args) };
});
afterEach(() => { boundary.check = undefined; vi.unstubAllGlobals(); });
const qualifiedCheck = () => ({ pid: 0, error: Object.assign(new Error("invalid descriptor"), { code: "EBADF" }), status: null, signal: null });

const api = (files: readonly string[], inherited: NodeJS.ProcessEnv = {}): WindowsNativeCommandDataApi => ({
  environmentValue: name => inherited[name],
  compareOrdinal: (left, right) => left.toUpperCase() < right.toUpperCase() ? -1 : left.toUpperCase() > right.toUpperCase() ? 1 : 0,
  needCurrentDirectory: () => true,
  fileExists: file => files.includes(file),
  shortPath: file => file,
});
const input = (environment: NodeJS.ProcessEnv = {}) => ({ file: "git", args: [] as string[], cwd: "C:\\work", environment });
const block = (value: Buffer): string[] => value.toString("utf16le").split("\0").filter(Boolean);
type PermissionProbeOptions = { env: NodeJS.ProcessEnv; stdio: [number, string, string] };
const normalizedArguments = (call: unknown[], flags: readonly string[]): void => {
  const args = call[1] as string[], options = call[2] as PermissionProbeOptions;
  const policy = options.env.NODE_OPTIONS;
  const explicitPolicy = args.includes("--permission") || args.includes("--permission-audit") ||
    policy?.split(/\s+/).some(token => token === "--permission" || token.startsWith("--permission=") || token === "--permission-audit" || token.startsWith("--permission-audit="));
  if (explicitPolicy) return;
  for (const argument of process.execArgv) {
    for (const flag of flags) {
      if (argument.startsWith(flag)) options.env.NODE_OPTIONS = `${options.env.NODE_OPTIONS ? options.env.NODE_OPTIONS + " " + argument : argument}`;
    }
  }
};
const permissionContext = <T>(args: readonly string[], active: boolean, read: () => T, propagates = true): T => {
  const original = process;
  boundary.check = (...call) => {
    expect(call[0]).toBe(process.execPath);
    expect((call[1] as string[]).slice(0, 3)).toEqual(["-e", "process.exit(125)", "--"]);
    if (propagates) normalizedArguments(call, ["--permission", "--allow-"]);
    const options = call[2] as PermissionProbeOptions;
    expect(options.stdio[0]).toBe(0x7fff_ffff);
    return qualifiedCheck();
  };
  vi.stubGlobal("process", new Proxy(original, { get: (target, key, receiver) => {
    if (key === "execArgv") return Reflect.get(target, key, receiver);
    if (key === "permission") return active ? { has: () => true } : undefined;
    return Reflect.get(target, key, receiver);
  } }));
  const descriptor = Object.getOwnPropertyDescriptor(original, "execArgv")!;
  Object.defineProperty(original, "execArgv", { ...descriptor, value: [...args] });
  try { return read(); } finally { Object.defineProperty(original, "execArgv", descriptor); boundary.check = undefined; vi.unstubAllGlobals(); }
};
const targetNodeOptions = (environment: NodeJS.ProcessEnv, args: readonly string[] = []): string | undefined => {
  const result = prepareWindowsNativeCommand({ ...input(environment), args }, api(["C:\\work\\git.exe"]));
  return block(result.environment).find(entry => entry.startsWith("NODE_OPTIONS="))?.slice("NODE_OPTIONS=".length);
};

describe("Windows native command argument encoding", () => {
  it.each([
    ["", '""'], ["plain", "plain"], ["hello\\world", "hello\\world"],
    ["hello world", '"hello world"'], ['hello"world', '"hello\\"world"'],
    ['hello\\"world', '"hello\\\\\\"world"'], ["hello world\\", '"hello world\\\\"'],
    ["中文 🚀", '"中文 🚀"'], ["a\tb", '"a\tb"'],
  ])("matches libuv's quoting for %j", (value, expected) => expect(quoteWindowsNativeArgument(value)).toBe(expected));

  it("keeps argv0 as the requested command and preserves exact UTF-16 argument data", () => {
    const result = prepareWindowsNativeCommand({ ...input(), args: ["", "中文", "a b", "a\\", "\ud800"] }, api(["C:\\work\\git.exe"]));
    expect(result.application).toBe("C:\\work\\git.exe");
    expect(result.commandLine.toString("utf16le")).toBe('git "" 中文 "a b" a\\ \ud800\0');
  });

  it("rejects NUL arguments and environment without dispatching a file probe", () => {
    const f = api([]); f.fileExists = vi.fn(f.fileExists);
    expect(() => prepareWindowsNativeCommand({ ...input(), args: ["a\0b"] }, f)).toThrow("null bytes");
    expect(() => prepareWindowsNativeCommand(input({ BAD: "a\0b" }), f)).toThrow("null bytes");
    expect(f.fileExists).not.toHaveBeenCalled();
  });
});

describe("Windows native executable resolution", () => {
  it("checks cwd and each PATH directory in com-before-exe order without using PATHEXT", () => {
    const f = api(["D:\\tools\\git.exe"]); f.fileExists = vi.fn(f.fileExists);
    const result = prepareWindowsNativeCommand(input({ PATH: "D:\\tools", PATHEXT: ".cmd" }), f);
    expect(result.application).toBe("D:\\tools\\git.exe");
    expect(f.fileExists).toHaveBeenNthCalledWith(1, "C:\\work\\git.com");
    expect(f.fileExists).toHaveBeenNthCalledWith(2, "C:\\work\\git.exe");
    expect(f.fileExists).toHaveBeenNthCalledWith(3, "D:\\tools\\git.com");
    expect(f.fileExists).toHaveBeenNthCalledWith(4, "D:\\tools\\git.exe");
  });

  it("honors the native cwd-search policy and preserves quoted semicolons and relative PATH entries", () => {
    const f = api(["C:\\work\\tools\\git.com"]); f.needCurrentDirectory = () => false; f.fileExists = vi.fn(f.fileExists);
    expect(prepareWindowsNativeCommand(input({ PATH: ';"D:\\semi;colon";;tools;' }), f).application).toBe("C:\\work\\tools\\git.com");
    expect(f.fileExists).toHaveBeenCalledTimes(3);
    expect(f.fileExists).toHaveBeenNthCalledWith(1, "D:\\semi;colon\\git.com");
    expect(f.fileExists).toHaveBeenNthCalledWith(2, "D:\\semi;colon\\git.exe");
  });

  it("resolves path-containing targets without searching PATH and tries their exact extension first", () => {
    const f = api(["D:\\bin\\node.exe"]); f.fileExists = vi.fn(f.fileExists);
    const result = prepareWindowsNativeCommand({ ...input({ PATH: "X:\\wrong" }), file: "D:\\bin\\node.exe" }, f);
    expect(result.application).toBe("D:\\bin\\node.exe"); expect(f.fileExists).toHaveBeenCalledOnce();
  });

  it("retains libuv drive-relative joining rather than replacing another drive with cwd", () => {
    expect(prepareWindowsNativeCommand(input({ PATH: "C:tools" }), api(["C:\\work\\tools\\git.exe"])).application).toBe("C:\\work\\tools\\git.exe");
    expect(prepareWindowsNativeCommand(input({ PATH: "D:tools" }), api(["D:tools\\git.exe"])).application).toBe("D:tools\\git.exe");
  });

  it("reports a genuine unresolved target and preserves its native cause in the spawn receipt", () => {
    let failure: unknown;
    try { prepareWindowsNativeCommand(input({ PATH: "D:\\empty" }), api([])); } catch (error) { failure = error; }
    expect(failure).toMatchObject({ stage: "resolve-executable", win32Code: 2 });
    const receipt = windowsNativeSpawnError(failure, "git", ["version"]);
    expect(receipt).toMatchObject({ code: "ENOENT", syscall: "spawn git", path: "git", spawnargs: ["version"], win32Code: 2 });
    expect(receipt?.cause).toBe(failure);
  });

  it("uses the long-cwd native representation for both image resolution and creation", () => {
    const cwd = "C:\\" + "long\\".repeat(60), f = api(["C:\\short\\git.exe"]);
    f.shortPath = vi.fn(() => "C:\\short");
    const result = prepareWindowsNativeCommand({ ...input(), cwd }, f);
    expect(f.shortPath).toHaveBeenCalledWith(cwd); expect(result.cwd).toBe("C:\\short");
  });
});

describe("Windows native environment representation", () => {
  it("deduplicates keys before removing undefined entries, then applies libuv's required inheritance", () => {
    const result = prepareWindowsNativeCommand(input({ Path: "D:\\discarded", PATH: undefined, Z: "last", a: "first" }),
      api(["E:\\inherited\\git.exe"], { PATH: "E:\\inherited", SYSTEMROOT: "C:\\Windows" }));
    expect(block(result.environment)).toEqual(["a=first", "PATH=E:\\inherited", "SYSTEMROOT=C:\\Windows", "Z=last"]);
    expect(result.environment.subarray(-4)).toEqual(Buffer.alloc(4));
  });

  it("keeps explicit empty required variables and coverage suppression while inheriting other required keys", () => {
    const result = prepareWindowsNativeCommand(input({ PATH: "D:\\tools", SYSTEMROOT: "", NODE_V8_COVERAGE: undefined }),
      api(["D:\\tools\\git.exe"], { SYSTEMROOT: "ignored", TEMP: "D:\\tmp", NODE_V8_COVERAGE: "ignored-coverage" }));
    expect(block(result.environment)).toEqual(["PATH=D:\\tools", "SYSTEMROOT=", "TEMP=D:\\tmp"]);
  });

  it("includes inherited properties and treats __proto__ as an environment name", () => {
    const environment = Object.assign(Object.create({ INHERITED: "yes" }) as NodeJS.ProcessEnv, { PATH: "D:\\tools" });
    Object.defineProperty(environment, "__proto__", { value: "literal", enumerable: true });
    const result = prepareWindowsNativeCommand(input(environment), api(["D:\\tools\\git.exe"], { NODE_V8_COVERAGE: "coverage" }));
    expect(block(result.environment)).toEqual(["INHERITED=yes", "NODE_V8_COVERAGE=coverage", "PATH=D:\\tools", "__proto__=literal"]);
  });
});

describe("Windows native target permission propagation", () => {
  const parentFlags = ["--permission", "--allow-child-process", "--allow-addons"];

  it("matches an actual allowed-child/addon Node parent's builtin spawn environment", () => {
    const moduleUrl = pathToFileURL(path.resolve("dist/platform/windows-native-command-data.js")).href;
    const source = `const {spawnSync}=await import('node:child_process');
      const {prepareWindowsNativeCommand}=await import(${JSON.stringify(moduleUrl)});
      const input='--title=--permission'+(process.env.NODE_OPTIONS?' '+process.env.NODE_OPTIONS:'');
      const child=spawnSync(process.execPath,['-e','process.stdout.write(JSON.stringify(process.env.NODE_OPTIONS))'],
        {env:{NODE_OPTIONS:input},encoding:'utf8',timeout:2500});
      if(child.error)throw child.error;if(child.status!==0)throw new Error(child.stderr);
      const api={environmentValue:()=>undefined,compareOrdinal:(a,b)=>a.toUpperCase().localeCompare(b.toUpperCase()),
        needCurrentDirectory:()=>true,fileExists:()=>true,shortPath:file=>file};
      const data=prepareWindowsNativeCommand({file:'git',args:[],cwd:'C:/work',environment:{NODE_OPTIONS:input}},api);
      const actual=data.environment.toString('utf16le').split('\\0').find(v=>v.startsWith('NODE_OPTIONS=')).slice(13);
      process.stdout.write(JSON.stringify({input,expected:JSON.parse(child.stdout),actual}));`;
    const reference = spawnSync(process.execPath, [...parentFlags, "--allow-fs-read=*", "--input-type=module", "-e", source], {
      env: { ...process.env, NODE_OPTIONS: "" }, encoding: "utf8", timeout: 3500,
    });
    expect(reference.error).toBeUndefined(); expect(reference.status, reference.stderr).toBe(0);
    const observed = JSON.parse(reference.stdout) as { input: string; expected: string; actual: string };
    expect(observed.expected).toBe(`${observed.input} --permission --allow-child-process --allow-addons --allow-fs-read=*`);
    expect(observed.actual).toBe(observed.expected);
  });

  it.skipIf(process.platform !== "win32" || !process.allowedNodeEnvironmentFlags.has("--permission-audit")).each(["execArgv", "NODE_OPTIONS"] as const)(
    "does not turn actual %s audit diagnostics into permission propagation", origin => {
      const moduleUrl = pathToFileURL(path.resolve("dist/platform/windows-native-command-data.js")).href;
      const source = `const {prepareWindowsNativeCommand}=await import(${JSON.stringify(moduleUrl)});
        const {spawnSync}=await import('node:child_process');const {channel}=await import('node:diagnostics_channel');
        const observe=(options,args=[])=>{
          const child=spawnSync(process.execPath,['-e','process.stdout.write(JSON.stringify(process.env.NODE_OPTIONS))',...args],
            {env:{NODE_OPTIONS:options},encoding:'utf8',timeout:1000});
          if(child.error)throw child.error;if(child.status!==0)throw new Error(child.stderr);return JSON.parse(child.stdout);
        };
        const input=observe('--trace-warnings',['--','--permission']),expected=observe(input);
        const argv=process.execArgv,descriptor=Object.getOwnPropertyDescriptor(process,'execArgv');let diagnostics=0;
        channel('node:permission-model:child').subscribe(()=>{
          diagnostics++;if(process.execArgv!==argv)throw new Error('argv identity changed during diagnostics');
          for(const value of process.execArgv)void value;process.execArgv.push('--permission');
        });
        const api={environmentValue:()=>undefined,compareOrdinal:(a,b)=>a.toUpperCase().localeCompare(b.toUpperCase()),
          needCurrentDirectory:()=>true,fileExists:()=>true,shortPath:file=>file};
        const data=prepareWindowsNativeCommand({file:'git',args:[],cwd:'C:/work',environment:{NODE_OPTIONS:input}},api);
        const actual=data.environment.toString('utf16le').split('\\0').find(v=>v.startsWith('NODE_OPTIONS=')).slice(13);
        process.stdout.write(JSON.stringify({actual,expected,diagnostics,restored:process.execArgv===argv,
          descriptor:Object.getOwnPropertyDescriptor(process,'execArgv').value===descriptor.value}));`;
      const flags = ["--permission-audit", "--allow-addons", "--allow-fs-read=*"];
      const reference = spawnSync(process.execPath, [...(origin === "execArgv" ? flags : []), "--input-type=module", "-e", source], {
        env: { ...process.env, NODE_OPTIONS: origin === "NODE_OPTIONS" ? flags.join(" ") : "" }, encoding: "utf8", timeout: 3500,
      });
      expect(reference.error).toBeUndefined(); expect(reference.status, reference.stderr).toBe(0);
      const observed = JSON.parse(reference.stdout) as { actual: string; expected: string; diagnostics: number; restored: boolean; descriptor: boolean };
      expect(observed.actual).toBe(observed.expected);
      expect(observed).toMatchObject({ diagnostics: 1, restored: true, descriptor: true });
    });

  it("copies literal allowed paths containing whitespace without starting an interpreter", () => {
    const args = ["--permission", "--allow-fs-read=C:\\path with spaces --require=never-preload", "--allow-child-process"];
    expect(permissionContext(args, true, () => targetNodeOptions({}))).toBe(args.join(" "));
  });

  it("copies only the flags the builtin appends, including allowances beyond the pinned Node 24 list", () => {
    const args = ["--trace-warnings", "--permission-audit", "--allow-fs-read=C:\\one", "--allow-fs-write=C:\\two", "--allow-addons",
      "--allow-child-process", "--allow-inspector", "--allow-wasi", "--allow-worker", "--allow-openssl-store", "--allow-net", "--allow-fs-vfs", "--allow-ffi"];
    const expected = "--permission-audit --allow-fs-read=C:\\one --allow-fs-write=C:\\two --allow-addons --allow-child-process --allow-inspector --allow-wasi --allow-worker --allow-openssl-store --allow-net --allow-fs-vfs --allow-ffi";
    expect(permissionContext(args, true, () => targetNodeOptions({}))).toBe(expected);
  });

  it("does not copy unmatched argv and preserves actual duplicate-match order", () => {
    permissionContext(["--unmatched", "--allow-net", "--permission"], true, () => {
      boundary.check = (...call) => {
        normalizedArguments(call, ["--allow", "--allow-net", "--permission"]);
        (call[2] as PermissionProbeOptions).stdio[0];
        return qualifiedCheck();
      };
      expect(targetNodeOptions({})).toBe("--allow-net --allow-net --permission");
    });
  });

  it("passes the complete target argv and literal options to the builtin opt-out decision", () => {
    permissionContext(parentFlags, true, () => {
      boundary.check = (...call) => {
        expect(call[1]).toEqual(["-e", "process.exit(125)", "--", "git", "fetch", "--permission-audit"]);
        const options = call[2] as PermissionProbeOptions;
        expect(options.env).toEqual({ NODE_OPTIONS: "--require=literal-preload --title=--permission", NODE_V8_COVERAGE: undefined });
        options.stdio[0];
        return qualifiedCheck();
      };
      expect(targetNodeOptions({ NODE_OPTIONS: "--require=literal-preload --title=--permission" }, ["fetch", "--permission-audit"]))
        .toBe("--require=literal-preload --title=--permission");
    });
  });

  it("keeps a builtin's older substring opt-out without imposing current token rules", () => {
    permissionContext(parentFlags, true, () => {
      boundary.check = (...call) => {
        const options = call[2] as PermissionProbeOptions;
        if (!options.env.NODE_OPTIONS?.includes("--permission")) normalizedArguments(call, ["--permission", "--allow-"]);
        options.stdio[0];
        return qualifiedCheck();
      };
      expect(targetNodeOptions({ NODE_OPTIONS: "--title=--permission" })).toBe("--title=--permission");
    });
  });

  it("does not propagate an audit-only normalizer's argv even when the public permission object exists", () => {
    expect(permissionContext(["--permission-audit", "--allow-addons"], true,
      () => targetNodeOptions({ NODE_OPTIONS: "--trace-warnings" }), false)).toBe("--trace-warnings");
  });

  it("ends observation before binding diagnostics can iterate or mutate the restored argv", () => {
    const descriptor = Object.getOwnPropertyDescriptor(process, "execArgv")!, original = process.execArgv;
    permissionContext(["--permission-audit"], true, () => {
      const current = process.execArgv, currentDescriptor = Object.getOwnPropertyDescriptor(process, "execArgv");
      boundary.check = (...call) => {
        const options = call[2] as { stdio: [number, string, string] };
        expect(process.execArgv).not.toBe(current);
        expect(options.stdio[0]).toBe(0x7fff_ffff);
        expect(process.execArgv).toBe(current);
        expect(Object.getOwnPropertyDescriptor(process, "execArgv")).toEqual(currentDescriptor);
        [...process.execArgv]; process.execArgv.push("--permission");
        return qualifiedCheck();
      };
      expect(targetNodeOptions({})).toBeUndefined();
      expect(process.execArgv).toBe(current);
    }, false);
    expect(process.execArgv).toBe(original);
    expect(Object.getOwnPropertyDescriptor(process, "execArgv")).toEqual(descriptor);
  });

  it("uses values actually copied before diagnostics mutate argv", () => {
    permissionContext(parentFlags, true, () => {
      boundary.check = (...call) => {
        normalizedArguments(call, ["--permission", "--allow-"]);
        const options = call[2] as { stdio: [number, string, string] };
        options.stdio[0]; process.execArgv.splice(0, process.execArgv.length, "--permission-audit");
        return qualifiedCheck();
      };
      expect(targetNodeOptions({})).toBe(parentFlags.join(" "));
    });
  });

  it.each(["throw", "returned"] as const)("restores argv and retains the original %s permission denial", mode => {
    const denied = Object.assign(new Error("original denial"), { code: "ERR_ACCESS_DENIED", permission: "ChildProcess" });
    permissionContext(parentFlags, true, () => {
      const argv = process.execArgv, descriptor = Object.getOwnPropertyDescriptor(process, "execArgv");
      boundary.check = () => { if (mode === "throw") throw denied; return { ...qualifiedCheck(), error: denied }; };
      expect(() => targetNodeOptions({})).toThrow(denied);
      try { targetNodeOptions({}); } catch (error) { expect(error).toBe(denied); }
      expect(process.execArgv).toBe(argv); expect(Object.getOwnPropertyDescriptor(process, "execArgv")).toEqual(descriptor);
    });
  });

  it.each(["--permission", "--permission-audit"])("keeps the explicit target argv policy %s", flag => {
    expect(permissionContext(parentFlags, true, () => targetNodeOptions({ NODE_OPTIONS: "--trace-warnings" }, [flag]))).toBe("--trace-warnings");
  });

  it.each(["--permission", "--permission=false", "--permission-audit", "--permission-audit=true"])("keeps explicit target NODE_OPTIONS policy %s", flag => {
    const options = `--trace-warnings ${flag}`;
    expect(permissionContext(parentFlags, true, () => targetNodeOptions({ NODE_OPTIONS: options }))).toBe(options);
  });

  it("performs literal token detection rather than treating substrings or quoted token text as opt-outs", () => {
    expect(permissionContext(parentFlags, true, () => targetNodeOptions({ NODE_OPTIONS: '--title=--permission "--permission"' })))
      .toBe('--title=--permission "--permission" --permission --allow-child-process --allow-addons');
    expect(permissionContext(parentFlags, true, () => targetNodeOptions({}, ["--permission=false"]))).toBe(parentFlags.join(" "));
  });

  it("propagates before case deduplication and does not mutate explicit caller environment", () => {
    const environment = { node_options: "--permission-audit", NODE_OPTIONS: undefined };
    expect(permissionContext(parentFlags, true, () => targetNodeOptions(environment))).toBe(parentFlags.join(" "));
    expect(environment).toEqual({ node_options: "--permission-audit", NODE_OPTIONS: undefined });
  });

  it("does not invent inherited NODE_OPTIONS when policy was only supplied by the parent's environment", () => {
    expect(permissionContext(["-e", "inline"], true, () => targetNodeOptions({}))).toBeUndefined();
    expect(permissionContext(parentFlags, false, () => targetNodeOptions({ NODE_OPTIONS: "--trace-warnings" }))).toBe("--trace-warnings");
  });
});

describe("Windows native spawn error classification", () => {
  it.each([[5, "EPERM"], [740, "EACCES"], [193, "EFTYPE"], [267, "ENOENT"], [87, "EINVAL"], [8, "ENOMEM"], [999999, "UNKNOWN"]] as const)(
    "preserves the runtime's UV classification for Win32 %i", (win32, code) => {
      const original = new WindowsNativeProcessError("create-process", win32), result = windowsNativeSpawnError(original, "git", []);
      expect(result?.code).toBe(code); expect(result?.cause).toBe(original); expect(result?.win32Code).toBe(win32);
      expect(getSystemErrorMap().get(result!.errno as number)?.[0]).toBe(code);
    });

  it("does not misclassify ownership, pipe or arbitrary errors as a missing executable", () => {
    expect(windowsNativeSpawnError(new WindowsNativeProcessError("set-process-job-list", 5), "git", [])).toBeUndefined();
    expect(windowsNativeSpawnError(new WindowsNativeProcessError("write-pipe-frame", 2), "git", [])).toBeUndefined();
    expect(windowsNativeSpawnError(new Error("unrelated"), "git", [])).toBeUndefined();
  });
});
