import { spawnSync } from "node:child_process";
import { getSystemErrorMap } from "node:util";
import type { SerializedSpawnError } from "./windows-owned-command.js";

export type WindowsNativeCommandDataApi = {
  environmentValue(name: string): string | undefined;
  compareOrdinal(left: string, right: string): number;
  needCurrentDirectory(): boolean;
  fileExists(file: string): boolean;
  shortPath(file: string): string;
};
export type WindowsNativeCommandInput = {
  file: string;
  args: readonly string[];
  cwd: string;
  environment: NodeJS.ProcessEnv;
};
export type WindowsNativeCommandData = {
  application: string;
  commandLine: Buffer;
  environment: Buffer;
  cwd: string;
};
export class WindowsNativeProcessError extends Error {
  constructor(readonly stage: string, readonly win32Code: number) {
    super(`Windows native command ${stage} failed (Win32 ${win32Code}).`);
    this.name = "WindowsNativeProcessError";
  }
}

const withoutNul = (value: string, subject: string): void => {
  if (value.includes("\0")) throw new TypeError(`${subject} must not contain null bytes.`);
};

// Match Node's Windows launch representation rather than cmd.exe or JSON escaping.
// https://github.com/nodejs/node/blob/f7f273a9bb6445f6f7fb6349105e7532972045fb/deps/uv/src/win/process.c#L448-L584
export const quoteWindowsNativeArgument = (value: string): string => {
  withoutNul(value, "Windows command argument");
  if (value.length === 0) return '""';
  if (!/[ \t"]/.test(value)) return value;
  let result = '"', slashes = 0;
  for (const character of value) {
    if (character === "\\") { slashes++; continue; }
    if (character === '"') result += "\\".repeat(slashes * 2 + 1) + '"';
    else result += "\\".repeat(slashes) + character;
    slashes = 0;
  }
  return result + "\\".repeat(slashes * 2) + '"';
};

const requiredEnvironment = ["HOMEDRIVE", "HOMEPATH", "LOGONSERVER", "PATH", "SYSTEMDRIVE", "SYSTEMROOT", "TEMP", "USERDOMAIN", "USERNAME", "USERPROFILE", "WINDIR"] as const;
const permissionFlags = ["--allow-fs-read", "--allow-fs-write", "--allow-addons", "--allow-child-process", "--allow-inspector", "--allow-wasi", "--allow-worker", "--allow-openssl-store", "--permission"] as const;
type ChildCreationDeniedError = Error & { code: "ERR_ACCESS_DENIED"; permission: "ChildProcess" };
const deniedChildCreation = (error: unknown): error is ChildCreationDeniedError => error instanceof Error && "code" in error && error.code === "ERR_ACCESS_DENIED" &&
  "permission" in error && error.permission === "ChildProcess";

// The public permission object exists in both enforcement and audit mode; only Node's
// own normalizer knows whether to propagate flags. Observe its actual argv iteration,
// then restore argv before stdio validation enters the binding or emits diagnostics.
// https://github.com/nodejs/node/blob/f7f273a9bb6445f6f7fb6349105e7532972045fb/lib/child_process.js#L541-L584
// https://github.com/nodejs/node/blob/f7f273a9bb6445f6f7fb6349105e7532972045fb/lib/child_process.js#L885-L933
const checkChildPermission = (observePropagation: boolean): readonly string[] => {
  const captured: string[] = [];
  const stdio: [number, "ignore", "ignore"] = [0x7fff_ffff, "ignore", "ignore"];
  let restore = (): void => {};
  if (observePropagation) {
    const descriptor = Object.getOwnPropertyDescriptor(process, "execArgv");
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.configurable) {
      throw new Error("Node execArgv cannot be observed before native command admission.");
    }
    let observing = true;
    restore = () => {
      if (!observing) return;
      Object.defineProperty(process, "execArgv", descriptor);
      observing = false;
    };
    const argv = descriptor.value as string[];
    const observed = new Proxy(argv, { get: (target, key, receiver) => {
      const value = Reflect.get(target, key, receiver) as unknown;
      if (key !== Symbol.iterator) return value;
      return function* (): Generator<string> {
        const iterator = Reflect.apply(value as (...args: never[]) => Iterator<string>, receiver, []) as Iterator<string>;
        for (const argument of { [Symbol.iterator]: () => iterator }) {
          if (observing) captured.push(argument);
          yield argument;
        }
      };
    } });
    Object.defineProperty(process, "execArgv", { ...descriptor, value: observed });
    Object.defineProperty(stdio, "0", { configurable: true, enumerable: true, get: () => { restore(); return 0x7fff_ffff; } });
  }
  let result: ReturnType<typeof spawnSync>;
  try {
    result = spawnSync(process.execPath, ["-e", "process.exit(125)"], {
      env: { NODE_OPTIONS: "", NODE_V8_COVERAGE: undefined }, stdio, timeout: 1000,
    });
  } catch (error) {
    if (deniedChildCreation(error)) throw error;
    throw new Error("Node child-process permission check could not be qualified before native command admission.", { cause: error });
  } finally { restore(); }
  if (deniedChildCreation(result.error)) throw result.error;
  const invalidDescriptor = result.error !== undefined && "code" in result.error && result.error.code === "EBADF";
  if (result.pid !== 0 || !invalidDescriptor || result.status !== null || result.signal !== null) {
    throw new Error("Node child-process permission check did not establish the no-process boundary.", { cause: result.error });
  }
  return captured;
};

// The invalid CRT fd is rejected before CreateProcessW; no probe process is created.
// The binding makes the current enforcement/audit decision without mutable mode guesses.
// https://github.com/nodejs/node/blob/f7f273a9bb6445f6f7fb6349105e7532972045fb/src/spawn_sync.cc#L380-L404
// https://github.com/nodejs/node/blob/f7f273a9bb6445f6f7fb6349105e7532972045fb/deps/uv/src/win/process.c#L1005-L1076
export const assertWindowsNativeChildPermission = (): void => {
  if (process.permission !== undefined) checkChildPermission(false);
};

const copyPermissionFlags = (environment: NodeJS.ProcessEnv, args: readonly string[]): void => {
  if (process.permission === undefined || args.includes("--permission") || args.includes("--permission-audit")) return;
  const options = environment.NODE_OPTIONS;
  if (options?.split(/\s+/).some(token => token === "--permission" || token.startsWith("--permission=") || token === "--permission-audit" || token.startsWith("--permission-audit="))) return;
  for (const argument of checkChildPermission(true)) {
    for (const flag of permissionFlags) {
      if (argument.startsWith(flag)) environment.NODE_OPTIONS = environment.NODE_OPTIONS ? `${environment.NODE_OPTIONS} ${argument}` : argument;
    }
  }
};
type EnvironmentEntry = { name: string; value: string };
const environmentEntries = (environment: NodeJS.ProcessEnv, args: readonly string[], api: WindowsNativeCommandDataApi): EnvironmentEntry[] => {
  const values = Object.create(null) as NodeJS.ProcessEnv;
  for (const name in environment) values[name] = environment[name];
  const coverage = api.environmentValue("NODE_V8_COVERAGE");
  if (coverage && !Object.hasOwn(environment, "NODE_V8_COVERAGE")) values.NODE_V8_COVERAGE = coverage;
  copyPermissionFlags(values, args);
  const names: string[] = [];
  for (const name in values) names.push(name);
  names.sort();
  const seen = new Set<string>(), entries: EnvironmentEntry[] = [];
  for (const name of names) {
    const folded = name.toUpperCase();
    if (seen.has(folded)) continue;
    seen.add(folded);
    const value = values[name];
    if (value === undefined) continue;
    withoutNul(name, "Windows environment name"); withoutNul(value, `Windows environment ${name}`);
    entries.push({ name, value });
  }
  for (const name of requiredEnvironment) {
    if (entries.some(entry => api.compareOrdinal(entry.name, name) === 0)) continue;
    const value = api.environmentValue(name);
    if (value !== undefined) { withoutNul(value, `Windows environment ${name}`); entries.push({ name, value }); }
  }
  return entries.sort((left, right) => api.compareOrdinal(left.name.split("=", 1)[0]!, right.name.split("=", 1)[0]!));
};

const pathDirectories = (value: string): string[] => {
  const result: string[] = [];
  let offset = 0;
  while (offset < value.length) {
    let end = offset;
    const quote = value[offset];
    if (quote === '"' || quote === "'") {
      const closing = value.indexOf(quote, offset + 1);
      end = closing === -1 ? value.length : closing;
    }
    const separator = value.indexOf(";", end);
    end = separator === -1 ? value.length : separator;
    let directory = value.slice(offset, end);
    offset = end + 1;
    if (directory.length === 0) continue;
    if (directory.startsWith('"') || directory.startsWith("'")) directory = directory.slice(1);
    if (directory.endsWith('"') || directory.endsWith("'")) directory = directory.slice(0, -1);
    result.push(directory);
  }
  return result;
};
const joinSearchPath = (directory: string, name: string, extension: string, cwd: string): string => {
  let prefix = cwd;
  if (directory.length > 2 && /^[\\/]{2}/.test(directory)) prefix = "";
  else if (/^[\\/]/.test(directory)) prefix = cwd.slice(0, 2);
  else if (directory.length >= 2 && directory[1] === ":" && (directory.length < 3 || !/[\\/]/.test(directory[2]!))) {
    if (cwd.length < 2 || cwd.slice(0, 2).toUpperCase() !== directory.slice(0, 2).toUpperCase()) prefix = "";
    else directory = directory.slice(2);
  } else if (directory.length > 2 && directory[1] === ":") prefix = "";
  if (prefix.length && !/[\\/:]$/.test(prefix)) prefix += "\\";
  prefix += directory;
  if (directory.length && !/[\\/:]$/.test(directory)) prefix += "\\";
  return prefix + name + (extension.length ? (name.endsWith(".") ? "" : ".") + extension : "");
};
const resolveExecutable = (file: string, cwd: string, path: string | undefined, api: WindowsNativeCommandDataApi): string => {
  if (file.length === 0 || file === ".") throw new WindowsNativeProcessError("resolve-executable", 2);
  const separator = Math.max(file.lastIndexOf("\\"), file.lastIndexOf("/"), file.lastIndexOf(":"));
  const name = file.slice(separator + 1), directory = file.slice(0, separator + 1);
  const dot = name.indexOf("."), extensions = dot !== -1 && dot + 1 < name.length ? ["", "com", "exe"] : ["com", "exe"];
  const directories = separator !== -1 ? [directory] : [...(api.needCurrentDirectory() ? [""] : []), ...(path === undefined ? [] : pathDirectories(path))];
  for (const candidateDirectory of directories) {
    for (const extension of extensions) {
      const candidate = joinSearchPath(candidateDirectory, name, extension, cwd);
      if (api.fileExists(candidate)) return candidate;
    }
  }
  throw new WindowsNativeProcessError("resolve-executable", 2);
};

export const prepareWindowsNativeCommand = (input: WindowsNativeCommandInput, api: WindowsNativeCommandDataApi): WindowsNativeCommandData => {
  withoutNul(input.file, "Windows command file"); withoutNul(input.cwd, "Windows command directory");
  const commandLine = Buffer.from([input.file, ...input.args].map(quoteWindowsNativeArgument).join(" ") + "\0", "utf16le");
  const entries = environmentEntries(input.environment, [input.file, ...input.args], api);
  const cwd = input.cwd.length >= 260 ? api.shortPath(input.cwd) : input.cwd;
  const path = entries.find(entry => api.compareOrdinal(entry.name, "PATH") === 0)?.value;
  return {
    application: resolveExecutable(input.file, cwd, path, api), commandLine,
    environment: Buffer.from(entries.map(entry => `${entry.name}=${entry.value}\0`).join("") + (entries.length ? "\0" : "\0\0"), "utf16le"), cwd,
  };
};

// Keep Win32-to-UV classification aligned with the runtime whose spawn contract we expose.
// https://github.com/nodejs/node/blob/f7f273a9bb6445f6f7fb6349105e7532972045fb/deps/uv/src/win/error.c#L71-L172
const win32Errors: Readonly<Record<string, readonly number[]>> = {
  EACCES: [10013, 740, 1920], EADDRINUSE: [1227, 10048], EADDRNOTAVAIL: [10049], EAFNOSUPPORT: [10047],
  EAGAIN: [10035, 232], EALREADY: [10037], EBADF: [1004, 6], EBUSY: [33, 231, 32], ECANCELED: [995, 10004],
  ECHARSET: [1113], ECONNABORTED: [1236, 10053], ECONNREFUSED: [1225, 10061], ECONNRESET: [64, 10054],
  EEXIST: [183, 80], EFAULT: [998, 10014], EHOSTUNREACH: [1232, 10065], EINVAL: [122, 13, 87, 1464, 10022, 10046],
  EIO: [1102, 1111, 23, 1166, 1165, 1393, 1129, 1101, 31, 1106, 1117, 1104, 205, 110, 1103, 156],
  EISCONN: [10056], ELOOP: [1921], EMFILE: [4, 10024], EMSGSIZE: [10040], ENAMETOOLONG: [111, 206],
  ENETUNREACH: [1231, 10051], ENOBUFS: [10055], ENOENT: [161, 267, 203, 2, 123, 15, 4392, 126, 3, 11001, 11004],
  ENOMEM: [8, 14], ENOSPC: [82, 112, 277, 1100, 39], ENOTCONN: [2250, 10057], ENOTEMPTY: [145],
  ENOTSOCK: [10038], ENOTSUP: [50], EOF: [109], EPERM: [5, 1314], EPIPE: [230, 233, 10058],
  EPROTONOSUPPORT: [10043], EROFS: [19], ETIMEDOUT: [121, 10060], EXDEV: [17], EISDIR: [1],
  E2BIG: [208], ESOCKTNOSUPPORT: [10044], EFTYPE: [193],
};
const uvNames = new Map<number, string>(Object.entries(win32Errors).flatMap(([name, codes]) => codes.map(code => [code, name] as const)));
const systemErrors = new Map([...getSystemErrorMap()].map(([errno, [name, message]]) => [name, { errno, message }]));
const spawnStages = new Set(["resolve-executable", "resolve-working-directory", "create-process"]);
export const windowsNativeSpawnError = (error: unknown, file: string, args: readonly string[]): (SerializedSpawnError & { win32Code: number; cause: WindowsNativeProcessError }) | undefined => {
  if (!(error instanceof WindowsNativeProcessError) || !spawnStages.has(error.stage)) return undefined;
  const code = uvNames.get(error.win32Code) ?? "UNKNOWN";
  const system = systemErrors.get(code);
  if (system === undefined) throw new Error(`Node does not expose the ${code} system error.`);
  return { name: "Error", message: `spawn ${file} ${code}`, code, errno: system.errno, syscall: `spawn ${file}`, path: file, spawnargs: [...args], win32Code: error.win32Code, cause: error };
};
