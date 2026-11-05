const fs: typeof import("node:fs") = require("node:fs");
const promises: typeof import("node:fs/promises") = require("node:fs/promises");
const path: typeof import("node:path") = require("node:path");
const crypto: typeof import("node:crypto") = require("node:crypto");
const moduleApi: typeof import("node:module") = require("node:module");
const childProcess: typeof import("node:child_process") = require("node:child_process");
const { fileURLToPath }: typeof import("node:url") = require("node:url");
const { promisify }: typeof import("node:util") = require("node:util");
const original = { lstat: fs.lstatSync, realpath: fs.realpathSync, mkdir: fs.mkdirSync, mkdtemp: fs.mkdtempSync, rm: fs.rmSync };
const repositoryRoot = path.resolve(__dirname, "../../..");
const temporaryRoots = [path.join(repositoryRoot, ".tmp"), path.join(repositoryRoot, "packages/daynight/.tmp")];
const metadataName = "DAYNIGHT_TEST_ISOLATION";
const directoryEnvironmentNames = ["HOME", "USERPROFILE", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "COPILOT_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "GH_CONFIG_DIR", "APPDATA", "LOCALAPPDATA", "TMPDIR", "TEMP", "TMP"];
const preload = __filename;
const contains = (root: string, target: string): boolean => {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
};
const physicalPath = (target: string): string => {
  let current = target;
  const missing: string[] = [];
  for (;;) {
    try { original.lstat(current); }
    catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      missing.push(path.basename(current));
      current = parent;
      continue;
    }
    return path.join(original.realpath(current), ...missing.reverse());
  }
};
const prepareTemporaryRoot = (root: string): void => {
  if (physicalPath(root) !== path.join(original.realpath(repositoryRoot), path.relative(repositoryRoot, root))) throw new Error(`Test temporary root is redirected: ${root}`);
  original.mkdir(root, { recursive: true });
};
for (const key of Object.keys(process.env)) {
  if (["DN_CONFIG_DIR", "NODE_OPTIONS", metadataName, ...directoryEnvironmentNames].includes(key.toUpperCase()) && key !== key.toUpperCase()) {
    const value = process.env[key]; delete process.env[key]; process.env[key.toUpperCase()] = value;
  }
}
const inheritedProtectedRoots = [process.env.DN_CONFIG_DIR, ...[process.env.HOME, process.env.USERPROFILE].filter((home): home is string => home !== undefined).map(home => path.join(home, ".daynight"))].filter((directory): directory is string => directory !== undefined).map(directory => path.resolve(directory));
const canonicalInheritedProtectedRoots = inheritedProtectedRoots.map(directory => physicalPath(directory));
if (process.env[metadataName] === undefined && canonicalInheritedProtectedRoots.some(directory => temporaryRoots.some(temporary => contains(directory, physicalPath(temporary))))) throw new Error("Test temporary directories overlap retained state.");
for (const directory of temporaryRoots) prepareTemporaryRoot(directory);

let root: string;
let protectedRoots: string[];
const ownsRoot = process.env[metadataName] === undefined;
if (process.env[metadataName] === undefined) {
  protectedRoots = inheritedProtectedRoots;
  root = original.mkdtemp(path.join(temporaryRoots[0]!, "cli-tests-"));
  delete process.env.DN_CONFIG_DIR;
  for (const name of ["CODEX_HOME", "CLAUDE_CONFIG_DIR", "COPILOT_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"]) delete process.env[name];
  for (const name of ["HOME", "USERPROFILE", "XDG_CACHE_HOME", "GH_CONFIG_DIR", "APPDATA", "LOCALAPPDATA", "TMPDIR", "TEMP", "TMP"]) {
    const directory = path.join(root, name.toLowerCase());
    original.mkdir(directory, { recursive: true });
    process.env[name] = directory;
  }
  process.env.USERPROFILE = process.env.HOME;
  process.env[metadataName] = JSON.stringify({ root, protectedRoots });
} else {
  const metadata: unknown = JSON.parse(process.env[metadataName]!);
  if (typeof metadata !== "object" || metadata === null || !("root" in metadata) || typeof metadata.root !== "string" || !contains(temporaryRoots[0]!, metadata.root)) {
    throw new Error("Invalid CLI test isolation metadata.");
  }
  root = metadata.root;
  if (!("protectedRoots" in metadata) || !Array.isArray(metadata.protectedRoots) || !metadata.protectedRoots.every(value => typeof value === "string" && path.isAbsolute(value))) throw new Error("Invalid protected test paths.");
  protectedRoots = metadata.protectedRoots;
  if (!contains(original.realpath(repositoryRoot), physicalPath(root))) throw new Error("CLI test isolation root escapes the repository.");
}
const writableRoots = [...temporaryRoots];
const ipcRoots = new Map<string, string>();
const physicalRoots = new Map(writableRoots.map(directory => [directory, physicalPath(directory)]));
const physicalProtectedRoots = protectedRoots.map(directory => physicalPath(directory));
const descriptors = new Map<number, unknown>();
const nativePipes = new Set<string>();
const asPath = (value: unknown): string | undefined => {
  if (typeof value === "string") return path.resolve(value);
  if (Buffer.isBuffer(value)) return path.resolve(value.toString());
  if (value instanceof URL) return path.resolve(fileURLToPath(value));
  return undefined;
};
const assertWritablePath = (value: unknown, followLeaf = true): void => {
  const target = asPath(value);
  if (target === undefined) {
    if (typeof value === "number") {
      if (value === 1 || value === 2 || fs.fstatSync(value).isCharacterDevice()) return;
      const file = descriptors.get(value);
      if (file === undefined) throw new Error(`Test mutation uses an untracked descriptor: ${value}`);
      assertWritablePath(file, followLeaf); return;
    }
    throw new Error("Test mutation requires a filesystem path or an already opened descriptor.");
  }
  if (nativePipes.has(target)) return;
  if (protectedRoots.some(directory => contains(directory, target) || (!followLeaf && contains(target, directory)))) throw new Error(`Test mutation targets retained state: ${target}`);
  const allowed = [...writableRoots, ...ipcRoots.keys()];
  const lexical = allowed.find(candidate => contains(candidate, target));
  if (lexical === undefined) throw new Error(`Test mutation escapes isolated directories: ${target}`);
  if (!followLeaf && writableRoots.includes(target)) throw new Error(`Test cleanup cannot remove a shared temporary root: ${target}`);
  const inspected = target;
  const canonicalRoot = physicalRoots.get(lexical) ?? ipcRoots.get(lexical)!;
  const physical = followLeaf ? physicalPath(inspected) : path.join(physicalPath(path.dirname(target)), path.basename(target));
  if (physicalProtectedRoots.some(directory => contains(directory, physical) || (!followLeaf && contains(physical, directory)))) throw new Error(`Test mutation reaches retained state through an alias: ${target}`);
  if (!contains(canonicalRoot, physical)) throw new Error(`Test mutation follows a symbolic link outside isolated directories: ${target}`);
};
const registerStateDirectory = (directory: string): void => {
  try { assertWritablePath(directory); }
  catch { return; }
  if (typeof process.getuid !== "function") return;
  const key = crypto.createHash("sha256").update(directory).digest("hex").slice(0, 24);
  const shortRoot = `/tmp/daynight-${process.getuid()}-${key}`;
  const canonical = path.join(original.realpath("/tmp"), path.basename(shortRoot));
  if (canonical !== physicalPath(shortRoot)) throw new Error(`Test IPC root follows an external symbolic link: ${shortRoot}`);
  ipcRoots.set(shortRoot, canonical);
};
registerStateDirectory(process.env.DN_CONFIG_DIR === undefined ? path.join(process.env.HOME!, ".daynight") : path.resolve(process.env.DN_CONFIG_DIR));

const requireOption = `--require=${JSON.stringify(preload)}`;
const guardedEnvironment = (supplied: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv => {
  const environment = { ...supplied };
  for (const key of Object.keys(environment)) {
    if ([metadataName, "NODE_OPTIONS", "DN_CONFIG_DIR", ...directoryEnvironmentNames].includes(key.toUpperCase()) && key !== key.toUpperCase()) {
      environment[key.toUpperCase()] = environment[key]; delete environment[key];
    }
  }
  environment[metadataName] = process.env[metadataName];
  if (environment.DN_CONFIG_DIR !== undefined) assertWritablePath(environment.DN_CONFIG_DIR);
  for (const name of directoryEnvironmentNames) {
    const value = environment[name];
    if (value === undefined && !["HOME", "USERPROFILE", "TMPDIR", "TEMP", "TMP"].includes(name)) continue;
    if (value === undefined || !writableRoots.some(candidate => contains(candidate, path.resolve(value)))) environment[name] = path.join(root, name.toLowerCase());
    assertWritablePath(environment[name]);
  }
  const options = environment.NODE_OPTIONS ?? "";
  environment.NODE_OPTIONS = options.includes(requireOption) ? options : `${options} ${requireOption}`.trim();
  return environment;
};
Object.assign(process.env, guardedEnvironment());

const patch = (object: object, name: string, inspect: (arguments_: unknown[]) => void, returnsPromise = false): void => {
  const target = object as Record<string, any>;
  const operation = target[name];
  if (typeof operation !== "function") return;
  target[name] = function (...arguments_: unknown[]) {
    try { inspect(arguments_); }
    catch (error) {
      if (returnsPromise || object === promises || operation.constructor.name === "AsyncFunction") return Promise.reject(error);
      const callback = arguments_.at(-1);
      if (typeof callback === "function") { queueMicrotask(() => callback(error)); return; }
      throw error;
    }
    return Reflect.apply(operation, this, arguments_);
  };
};
const writableOpen = (flags: unknown): boolean => typeof flags === "number"
  ? (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND)) !== 0
  : typeof flags === "string" && /[wa+]/.test(flags);
const firstPath = (arguments_: unknown[]): void => assertWritablePath(arguments_[0]);
const removal = (arguments_: unknown[]): void => assertWritablePath(arguments_[0], false);
for (const name of ["writeFile", "appendFile", "mkdir", "mkdtemp", "truncate", "chmod", "chown", "utimes", "lutimes", "lchmod", "lchown"]) {
  for (const object of [fs, promises]) patch(object, name, firstPath);
  patch(fs, `${name}Sync`, firstPath);
}
for (const name of ["unlink", "rm", "rmdir"]) {
  for (const object of [fs, promises]) patch(object, name, removal);
  patch(fs, `${name}Sync`, removal);
}
for (const name of ["rename", "link"]) {
  const inspect = (arguments_: unknown[]): void => { assertWritablePath(arguments_[0], name === "link"); assertWritablePath(arguments_[1], false); };
  for (const object of [fs, promises]) patch(object, name, inspect);
  patch(fs, `${name}Sync`, inspect);
}
for (const name of ["copyFile", "cp", "symlink"]) {
  const inspect = (arguments_: unknown[]): void => assertWritablePath(arguments_[1], name !== "symlink");
  for (const object of [fs, promises]) patch(object, name, inspect);
  patch(fs, `${name}Sync`, inspect);
}
const guardedCopyFilter = (filter: ((source: string, destination: string) => boolean | Promise<boolean>) | undefined, asynchronous: boolean) => {
  if (asynchronous) return async (source: string, destination: string) => {
    const included = filter === undefined ? true : await filter(source, destination);
    if (included) assertWritablePath(destination);
    return included;
  };
  return (source: string, destination: string) => {
    const included = filter === undefined ? true : filter(source, destination);
    if (included) assertWritablePath(destination);
    return included;
  };
};
const copySync = fs.cpSync;
(fs as any).cpSync = (source: unknown, destination: unknown, options: any = {}) => copySync(source as any, destination as any, { ...options, filter: guardedCopyFilter(options.filter, false) as any });
const copyPromise = promises.cp;
(promises as any).cp = (source: unknown, destination: unknown, options: any = {}) => copyPromise(source as any, destination as any, { ...options, filter: guardedCopyFilter(options.filter, true) as any });
const copyCallback = fs.cp;
(fs as any).cp = (source: unknown, destination: unknown, options: any, callback?: any) => {
  if (typeof options === "function") { callback = options; options = {}; }
  options ??= {};
  (copyCallback as any)(source, destination, { ...options, filter: guardedCopyFilter(options.filter, true) }, callback);
};

const openSync = fs.openSync;
(fs as any).openSync = (filename: unknown, flags: unknown, mode: unknown) => {
  if (writableOpen(flags)) assertWritablePath(filename);
  const descriptor = (openSync as any)(filename, flags, mode); descriptors.set(descriptor, filename); return descriptor;
};
const openCallback = fs.open;
(fs as any).open = (filename: unknown, flags: unknown, ...arguments_: any[]) => {
  const callback = arguments_.pop();
  try { if (writableOpen(flags)) assertWritablePath(filename); }
  catch (error) { queueMicrotask(() => callback(error)); return; }
  (openCallback as any)(filename, flags, ...arguments_, (error: unknown, descriptor: number) => {
    if (error === null) descriptors.set(descriptor, filename);
    callback(error, descriptor);
  });
};
const openPromise = promises.open;
(promises as any).open = async (filename: unknown, flags: unknown, mode: unknown) => {
  if (writableOpen(flags)) assertWritablePath(filename);
  const handle = await (openPromise as any)(filename, flags, mode); descriptors.set(handle.fd, filename);
  for (const name of ["write", "writev", "writeFile", "appendFile", "truncate", "chmod", "chown", "utimes", "createWriteStream"]) patch(handle, name, () => assertWritablePath(filename), name !== "createWriteStream");
  const close = handle.close.bind(handle);
  handle.close = async () => { const descriptor = handle.fd; await close(); descriptors.delete(descriptor); };
  return handle;
};
const closeSync = fs.closeSync;
(fs as any).closeSync = (descriptor: number) => { closeSync(descriptor); descriptors.delete(descriptor); };
const closeCallback = fs.close;
(fs as any).close = (descriptor: number, callback: (error: unknown) => void) => closeCallback(descriptor, error => { if (error === null) descriptors.delete(descriptor); callback(error); });
for (const name of ["write", "writev", "ftruncate", "fchmod", "fchown", "futimes"]) {
  patch(fs, name, firstPath); patch(fs, `${name}Sync`, firstPath);
}
patch(fs, "createWriteStream", arguments_ => {
  const options = arguments_[1] as { fd?: number } | undefined;
  assertWritablePath(options?.fd === undefined ? arguments_[0] : options.fd);
});

for (const name of ["spawn", "spawnSync", "execFile", "execFileSync", "fork"]) {
  const target = childProcess as unknown as Record<string, any>;
  const operation = target[name];
  target[name] = function (file: string, ...arguments_: any[]) {
    const index = Array.isArray(arguments_[0]) ? 1 : 0;
    const options = arguments_[index];
    const guarded = { ...(options !== null && typeof options === "object" ? options : {}), env: guardedEnvironment(options?.env) };
    if (options === undefined || typeof options === "function") arguments_.splice(index, 0, guarded);
    else arguments_[index] = guarded;
    return Reflect.apply(operation, this, [file, ...arguments_]);
  };
}
for (const name of ["exec", "execSync"]) {
  const target = childProcess as unknown as Record<string, any>;
  const operation = target[name];
  target[name] = function (command: string, options?: any, callback?: any) {
    if (typeof options === "function") return operation.call(this, command, { env: guardedEnvironment() }, options);
    return operation.call(this, command, { ...options, env: guardedEnvironment(options?.env) }, callback);
  };
}

for (const name of ["exec", "execFile"]) {
  const target = childProcess as unknown as Record<string, any>;
  target[name][promisify.custom] = (...arguments_: any[]) => {
    let resolve!: (result: { stdout: string | Buffer; stderr: string | Buffer }) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<{ stdout: string | Buffer; stderr: string | Buffer }>((yes, no) => { resolve = yes; reject = no; }) as Promise<unknown> & { child?: import("node:child_process").ChildProcess };
    promise.child = target[name](...arguments_, (error: Error | null, stdout: string | Buffer, stderr: string | Buffer) => {
      if (error !== null) { Object.assign(error, { stdout, stderr }); reject(error); }
      else resolve({ stdout, stderr });
    });
    return promise;
  };
}

const moduleLoader = moduleApi as unknown as { _load: (request: string, ...arguments_: any[]) => any };
const load = moduleLoader._load;
const sqliteConstructors = new WeakMap<object, object>();
moduleLoader._load = function (request: string, ...arguments_: any[]) {
  const loaded = Reflect.apply(load, this, [request, ...arguments_]);
  if (request.endsWith(".node") && typeof loaded.Database === "function" && typeof loaded.initialize === "function" && !sqliteConstructors.has(loaded.Database)) {
    const database = loaded.Database;
    patch(database.prototype, "backup", arguments_ => assertWritablePath(arguments_[2]));
    const guarded = new Proxy(database, {
      construct(target, arguments_, newTarget) { if (!arguments_[2]) assertWritablePath(arguments_[0]); return Reflect.construct(target, arguments_, newTarget); },
    });
    sqliteConstructors.set(database, guarded);
    sqliteConstructors.set(guarded, guarded);
    loaded.Database = guarded;
  }
  if (request.endsWith(".node") && typeof loaded.fork === "function" && /node-pty|pty\.node/.test(request) && !loaded.fork.__isolated) {
    const fork = loaded.fork;
    const isolated = function (this: unknown, ...arguments_: any[]) {
      const environment = Object.fromEntries(arguments_[2].map((entry: string) => { const index = entry.indexOf("="); return [entry.slice(0, index), entry.slice(index + 1)]; }));
      arguments_[2] = Object.entries(guardedEnvironment(environment)).filter(([, value]) => value !== undefined).map(([name, value]) => `${name}=${value}`);
      return Reflect.apply(fork, this, arguments_);
    };
    isolated.__isolated = true; loaded.fork = isolated;
  }
  if (request.endsWith(".node") && typeof loaded.startProcess === "function" && /node-pty|(?:con)?pty\.node/.test(request) && !loaded.startProcess.__isolated) {
    const parseEnvironment = (entries: string[]): NodeJS.ProcessEnv => Object.fromEntries(entries.map(entry => { const index = entry.indexOf("="); return [entry.slice(0, index), entry.slice(index + 1)]; }));
    const entries = (environment: NodeJS.ProcessEnv): string[] => Object.entries(guardedEnvironment(environment)).filter(([, value]) => value !== undefined).map(([name, value]) => `${name}=${value}`);
    const startProcess = loaded.startProcess;
    const isolated = function (this: unknown, ...arguments_: any[]) {
      if (Array.isArray(arguments_[2])) arguments_[2] = entries(parseEnvironment(arguments_[2]));
      const result = Reflect.apply(startProcess, this, arguments_) as { conin?: string; conout?: string };
      for (const pipe of [result.conin, result.conout]) if (pipe !== undefined) nativePipes.add(path.resolve(pipe));
      return result;
    };
    isolated.__isolated = true; loaded.startProcess = isolated;
    if (typeof loaded.connect === "function") {
      const connect = loaded.connect;
      loaded.connect = function (this: unknown, ...arguments_: any[]) { arguments_[3] = entries(parseEnvironment(arguments_[3])); return Reflect.apply(connect, this, arguments_); };
    }
  }
  if (request === "node-pty" && typeof loaded.spawn === "function" && !loaded.spawn.__isolated) {
    const spawn = loaded.spawn;
    const isolated = (file: string, args: string[], options: any = {}) => spawn(file, args, { ...options, env: guardedEnvironment(options.env) });
    isolated.__isolated = true; loaded.spawn = isolated;
  }
  if (request !== "better-sqlite3" || typeof loaded !== "function") return loaded;
  let guarded = sqliteConstructors.get(loaded);
  if (guarded !== undefined) return guarded;
  const check = (arguments_: any[]): void => { if (typeof arguments_[0] === "string" && arguments_[0] !== "" && arguments_[0] !== ":memory:") assertWritablePath(arguments_[0]); };
  patch(loaded.prototype, "backup", firstPath);
  guarded = new Proxy(loaded, {
    construct(target, arguments_, newTarget) { check(arguments_); return Reflect.construct(target, arguments_, newTarget); },
    apply(target, receiver, arguments_) { check(arguments_); return Reflect.apply(target, receiver, arguments_); },
  });
  sqliteConstructors.set(loaded, guarded!);
  return guarded;
};
moduleApi.syncBuiltinESMExports();

const cleanupIpc = (): void => {
  for (const directory of ipcRoots.keys()) { assertWritablePath(directory, false); original.rm(directory, { recursive: true, force: true }); }
  ipcRoots.clear();
};
const isolation = {
  root,
  assertWritablePath,
  guardedEnvironment,
  registerStateDirectory,
  cleanupIpc,
  cleanup: () => {
    cleanupIpc();
    assertWritablePath(root, false); original.rm(root, { recursive: true, force: true });
  },
};

module.exports = isolation;
if (ownsRoot) process.once("exit", () => isolation.cleanup());
