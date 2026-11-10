import * as koffi from "koffi";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadWindowsNativeProcessKernel, WindowsNativeProcessError } from "../../src/platform/windows-native-process.js";

const boundary = vi.hoisted(() => ({ calls: new Map<string, (...args: unknown[]) => unknown>(), decodeError: undefined as Error | undefined, decodeCalls: 0,
  permissionCheck: undefined as ((...args: unknown[]) => unknown) | undefined }));
vi.mock("node:child_process", async importOriginal => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return { ...original, spawnSync: (...args: unknown[]) => {
    if (boundary.permissionCheck === undefined) throw new Error("Unexpected controlled permission check.");
    return boundary.permissionCheck(...args);
  } };
});
vi.mock("koffi", async importOriginal => {
  const original = await importOriginal<typeof import("koffi")>();
  return { ...original, decode: (...args: unknown[]) => {
    boundary.decodeCalls++;
    if (boundary.decodeError !== undefined) throw boundary.decodeError;
    return Reflect.apply(original.decode, undefined, args);
  }, load: () => ({ func: (declaration: string) => {
    const name = /([A-Za-z0-9_]+)\(/.exec(declaration)?.[1];
    if (name === undefined) throw new Error("Controlled native declaration has no function name.");
    return (...args: unknown[]) => {
      const call = boundary.calls.get(name);
      if (call === undefined) throw new Error(`Unexpected controlled Win32 call ${name}.`);
      return call(...args);
    };
  } }) };
});
afterEach(() => { boundary.calls.clear(); boundary.decodeError = undefined; boundary.decodeCalls = 0; boundary.permissionCheck = undefined; vi.unstubAllGlobals(); });

const permissionEnabled = (granted = false, advertisedAudit = false): ReturnType<typeof vi.fn> => {
  const original = process, has = vi.fn(() => granted);
  vi.stubGlobal("process", new Proxy(original, { get: (target, key, receiver) => {
    if (key === "permission") return { has };
    if (advertisedAudit && key === "env") return { ...target.env, NODE_OPTIONS: "--permission-audit" };
    if (advertisedAudit && key === "execArgv") return ["--permission-audit"];
    return Reflect.get(target, key, receiver);
  } }));
  return has;
};
const qualifiedPermissionCheck = () => ({ pid: 0, error: Object.assign(new Error("bad descriptor"), { code: "EBADF" }), status: null, signal: null });

const setup = (options: { createError?: number; deletionError?: Error; closeError?: number } = {}) => {
  const events: string[] = [], root = Buffer.alloc(8), thread = Buffer.alloc(8), stdio = [Buffer.alloc(8), Buffer.alloc(8), Buffer.alloc(8)], job = Buffer.alloc(8);
  const pointerSize = koffi.sizeof("void *"); let error = 0;
  boundary.calls.set("GetLastError", () => error);
  boundary.calls.set("SetLastError", value => { error = value as number; });
  boundary.calls.set("InitializeProcThreadAttributeList", (list, _count, _flags, size) => {
    if (list === null) { if (pointerSize === 8) (size as Buffer).writeBigUInt64LE(128n); else (size as Buffer).writeUInt32LE(128); error = 122; return 0; }
    events.push("initialize"); return 1;
  });
  boundary.calls.set("UpdateProcThreadAttribute", (_list, _flags, attribute) => { events.push(`attribute:${attribute}`); return 1; });
  boundary.calls.set("SetHandleInformation", () => { events.push("inherit"); return 1; });
  boundary.calls.set("CreateProcessW", (...args) => {
    events.push("create");
    expect(args[4]).toBe(1); expect(args[5]).toBe(0x0808_0404);
    if (options.createError !== undefined) { error = options.createError; return 0; }
    const output = args[9] as Buffer;
    koffi.encode(output, 0, "void *", root); koffi.encode(output, pointerSize, "void *", thread);
    output.writeUInt32LE(421, pointerSize * 2); output.writeUInt32LE(422, pointerSize * 2 + 4);
    return 1;
  });
  boundary.calls.set("DeleteProcThreadAttributeList", () => { events.push("delete"); if (options.deletionError !== undefined) throw options.deletionError; });
  boundary.calls.set("WaitForSingleObject", handle => { expect(BigInt(handle as number | bigint)).toBe(koffi.address(root)); return 0; });
  boundary.calls.set("GetExitCodeProcess", (handle, output) => { expect(BigInt(handle as number | bigint)).toBe(koffi.address(root)); (output as Buffer).writeUInt32LE(259); return 1; });
  boundary.calls.set("GetCurrentProcess", () => root);
  boundary.calls.set("DuplicateHandle", (_sourceProcess, handle, _targetProcess, output, access, inherit, flags) => {
    expect(BigInt(handle as number | bigint)).toBe(koffi.address(root)); expect([access, inherit, flags]).toEqual([0, 0, 2]);
    koffi.encode(output, "void *", root); return 1;
  });
  boundary.calls.set("CloseHandle", handle => {
    events.push(`close:${stdio.findIndex(value => koffi.address(value) === BigInt(handle as number | bigint))}`);
    if (options.closeError !== undefined && BigInt(handle as number | bigint) === koffi.address(stdio[1])) { error = options.closeError; return 0; }
    return 1;
  });
  return { events, root, thread, stdio, command: {
    application: "C:\\Git\\git.exe", commandLine: Buffer.from("git version\0", "utf16le"), environment: Buffer.alloc(4), cwd: "C:\\work", job,
    stdin: stdio[0], stdout: stdio[1], stderr: stdio[2],
  } };
};

describe("Windows native creation bookkeeping with controlled Win32 calls", () => {
  it("retains original process and thread handles when post-create cleanup fails", async () => {
    const deletion = new Error("controlled attribute deletion failure"), f = setup({ deletionError: deletion, closeError: 6 });
    const api = await loadWindowsNativeProcessKernel();
    boundary.decodeError = new Error("Opaque pointer decoding is unavailable");
    const result = api.createSuspended(f.command);
    expect(result.failure).toBeUndefined(); expect(result.created).toMatchObject({ pid: 421, threadId: 422 });
    expect(boundary.decodeCalls).toBe(0);
    expect(api.signaled(result.created!.process)).toBe(true);
    expect(api.exitCode(result.created!.process)).toBe(259);
    expect(result.cleanupErrors[0]).toBe(deletion);
    expect(result.cleanupErrors[1]).toMatchObject({ stage: "close-handle", win32Code: 6 });
    expect(f.events.slice(-4)).toEqual(["delete", "close:0", "close:1", "close:2"]);
    expect(f.events.filter(value => value === "inherit")).toHaveLength(3);
    expect(f.events.indexOf("create")).toBeGreaterThan(f.events.lastIndexOf("inherit"));
  });

  it("duplicates a retained original for independent Job observation without transferring ownership", async () => {
    const f = setup(), api = await loadWindowsNativeProcessKernel(), created = api.createSuspended(f.command).created!;
    const duplicate = api.duplicateProcess(created.process);
    expect(koffi.address(duplicate)).toBe(koffi.address(f.root));
    expect(api.signaled(created.process)).toBe(true);
  });

  it("captures the native creation error before cleanup can overwrite thread-local last-error", async () => {
    const f = setup({ createError: 193, closeError: 6 }), api = await loadWindowsNativeProcessKernel();
    const result = api.createSuspended(f.command);
    expect(result.created).toBeNull(); expect(result.failure).toBeInstanceOf(WindowsNativeProcessError);
    expect(result.failure).toMatchObject({ stage: "create-process", win32Code: 193 });
    expect(result.cleanupErrors).toMatchObject([{ stage: "close-handle", win32Code: 6 }]);
    expect(f.events.filter(value => value.startsWith("close:"))).toHaveLength(3);
  });

  it("honors the Node child permission before payload creation and still consumes parent stdio", async () => {
    const f = setup(), api = await loadWindowsNativeProcessKernel(), denied = Object.assign(new Error("real enforcement decision"), { code: "ERR_ACCESS_DENIED", permission: "ChildProcess" });
    permissionEnabled(false, true); boundary.permissionCheck = () => { throw denied; };
    const result = api.createSuspended(f.command);
    expect(result.created).toBeNull(); expect(result.failure).toBe(denied);
    expect(f.events).toEqual(["close:0", "close:1", "close:2"]);
  });

  it.each(["audit denial", "allowed child"])("accepts only the builtin no-process result for %s", async mode => {
    const f = setup(), api = await loadWindowsNativeProcessKernel(), has = permissionEnabled(mode === "allowed child");
    const check = vi.fn((file: unknown, args: unknown, options: unknown) => {
      expect(file).toBe(process.execPath); expect(args).toEqual(["-e", "process.exit(125)"]);
      expect(options).toEqual({ env: { NODE_OPTIONS: "", NODE_V8_COVERAGE: undefined }, stdio: [0x7fff_ffff, "ignore", "ignore"], timeout: 1000 });
      return qualifiedPermissionCheck();
    });
    boundary.permissionCheck = check;
    expect(api.createSuspended(f.command).created).not.toBeNull();
    expect(check).toHaveBeenCalledOnce(); expect(has).not.toHaveBeenCalled();
  });

  it.each([
    { ...qualifiedPermissionCheck(), pid: 42 },
    { ...qualifiedPermissionCheck(), error: Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }) },
    { ...qualifiedPermissionCheck(), status: 0 },
    { ...qualifiedPermissionCheck(), signal: "SIGTERM" },
  ])("rejects an unqualified check result before creating a native payload: %j", async result => {
    const f = setup(), api = await loadWindowsNativeProcessKernel(); permissionEnabled(); boundary.permissionCheck = () => result;
    const outcome = api.createSuspended(f.command);
    expect(outcome.created).toBeNull(); expect(outcome.failure).toMatchObject({ message: expect.stringContaining("no-process boundary") });
    expect(f.events).toEqual(["close:0", "close:1", "close:2"]);
  });

  it("preserves a returned access-denial object and checks each launch instead of caching an allow", async () => {
    const f = setup(), api = await loadWindowsNativeProcessKernel(), has = permissionEnabled(true);
    const denied = Object.assign(new Error("permission dropped"), { code: "ERR_ACCESS_DENIED", permission: "ChildProcess" });
    boundary.permissionCheck = vi.fn().mockReturnValueOnce(qualifiedPermissionCheck()).mockReturnValueOnce({ ...qualifiedPermissionCheck(), error: denied });
    expect(api.createSuspended(f.command).created).not.toBeNull();
    has.mockReturnValue(false);
    expect(api.createSuspended(f.command).failure).toBe(denied);
    expect(boundary.permissionCheck).toHaveBeenCalledTimes(2);
  });

  it("rejects an unexpected check exception before native creation", async () => {
    const f = setup(), api = await loadWindowsNativeProcessKernel(), failed = new Error("unsupported check");
    permissionEnabled(); boundary.permissionCheck = () => { throw failed; };
    const result = api.createSuspended(f.command);
    expect(result.created).toBeNull(); expect(result.failure).toMatchObject({ cause: failed });
    expect(f.events).toEqual(["close:0", "close:1", "close:2"]);
  });
});

describe("builtin permission check reference", () => {
  it.each(["execArgv", "NODE_OPTIONS"] as const)("observes actual %s enforced denial despite mutable audit advertisements", async origin => {
    const { spawnSync } = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const moduleUrl = pathToFileURL(path.resolve(import.meta.dirname, "../../dist/platform/windows-native-process.js")).href;
    const source = `const {assertWindowsNativeChildPermission}=await import(${JSON.stringify(moduleUrl)});let outcome;
      process.env.NODE_OPTIONS='--permission-audit';process.execArgv.push('--permission-audit');
      try{assertWindowsNativeChildPermission();outcome={returned:true};}
      catch(error){outcome={returned:false,code:error.code,permission:error.permission};}
      process.stdout.write(JSON.stringify(outcome));`;
    const flags = ["--permission", "--allow-addons", "--allow-fs-read=*"];
    const result = spawnSync(process.execPath, [...(origin === "execArgv" ? flags : []), "--input-type=module", "-e", source], {
      env: { ...process.env, NODE_OPTIONS: origin === "NODE_OPTIONS" ? flags.join(" ") : "" }, encoding: "utf8", timeout: 3500,
    });
    expect(result.error).toBeUndefined(); expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ returned: false, code: "ERR_ACCESS_DENIED", permission: "ChildProcess" });
  });

  it.skipIf(process.platform !== "win32" || !process.allowedNodeEnvironmentFlags.has("--permission-audit")).each(["execArgv", "NODE_OPTIONS"] as const)(
    "qualifies the actual Windows %s audit no-process boundary despite enforcement advertisements", async origin => {
      const { spawnSync } = await vi.importActual<typeof import("node:child_process")>("node:child_process");
      const moduleUrl = pathToFileURL(path.resolve(import.meta.dirname, "../../dist/platform/windows-native-process.js")).href;
      const source = `const {assertWindowsNativeChildPermission}=await import(${JSON.stringify(moduleUrl)});
        const denied=process.permission.has('child')===false;process.env.NODE_OPTIONS='--permission';process.execArgv.splice(0,process.execArgv.length,'--permission');
        assertWindowsNativeChildPermission();process.stdout.write(JSON.stringify({denied,qualified:true}));`;
      const flags = ["--permission-audit", "--allow-addons", "--allow-fs-read=*"];
      const result = spawnSync(process.execPath, [...(origin === "execArgv" ? flags : []), "--input-type=module", "-e", source], {
        env: { ...process.env, NODE_OPTIONS: origin === "NODE_OPTIONS" ? flags.join(" ") : "" }, encoding: "utf8", timeout: 3500,
      });
      expect(result.error).toBeUndefined(); expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ denied: true, qualified: true });
    });
});
