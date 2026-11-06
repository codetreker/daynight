const fs: typeof import("node:fs") = require("node:fs");
const promises: typeof import("node:fs/promises") = require("node:fs/promises");
const path: typeof import("node:path") = require("node:path");
const moduleApi: typeof import("node:module") = require("node:module");
const childProcess: typeof import("node:child_process") = require("node:child_process");
const os: typeof import("node:os") = require("node:os");
const { fileURLToPath }: typeof import("node:url") = require("node:url");
const { promisify }: typeof import("node:util") = require("node:util");
const original = { lstat: fs.lstatSync, realpath: fs.realpathSync, readlink: fs.readlinkSync, mkdir: fs.mkdirSync, mkdtemp: fs.mkdtempSync, rm: fs.rmSync };
const repositoryRoot = path.resolve(__dirname, "../../..");
const metadataName = "DAYNIGHT_TEST_ISOLATION";
const preload = __filename;
const contains = (root: string, target: string): boolean => {
  const relative = path.relative(path.toNamespacedPath(root), path.toNamespacedPath(target));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
};
const physicalPath = (target: string, links = new Set<string>()): string => {
  let current = target;
  const missing: string[] = [];
  for (;;) {
    let entry: import("node:fs").Stats;
    try { entry = original.lstat(current); }
    catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      missing.push(path.basename(current)); current = parent; continue;
    }
    if (entry.isSymbolicLink()) {
      if (links.has(current)) throw new Error(`Cannot resolve cyclic symbolic link: ${current}`);
      links.add(current);
      const destination = path.resolve(path.dirname(current), original.readlink(current));
      return path.join(physicalPath(destination, links), ...missing.reverse());
    }
    return path.join(original.realpath(current), ...missing.reverse());
  }
};
for (const key of Object.keys(process.env)) {
  if (["DN_CONFIG_DIR", "HOME", "USERPROFILE", "NODE_OPTIONS", metadataName].includes(key.toUpperCase()) && key !== key.toUpperCase()) {
    const value = process.env[key]; delete process.env[key]; process.env[key.toUpperCase()] = value;
  }
}
const ownsRoot = process.env[metadataName] === undefined;
let protectedRoots: string[];
let root: string;
if (ownsRoot) {
  protectedRoots = [process.env.DN_CONFIG_DIR, ...[os.homedir(), process.env.HOME, process.env.USERPROFILE].filter((home): home is string => home !== undefined).map(home => path.join(home, ".daynight"))].filter((directory): directory is string => directory !== undefined).map(directory => path.resolve(directory));
} else {
  const metadata: unknown = JSON.parse(process.env[metadataName]!);
  if (typeof metadata !== "object" || metadata === null || !("root" in metadata) || typeof metadata.root !== "string" || !path.isAbsolute(metadata.root) || !("protectedRoots" in metadata) || !Array.isArray(metadata.protectedRoots) || !metadata.protectedRoots.every(value => typeof value === "string" && path.isAbsolute(value))) throw new Error("Invalid CLI test isolation metadata.");
  root = metadata.root;
  protectedRoots = metadata.protectedRoots;
}
const physicalProtectedRoots = protectedRoots.map(directory => physicalPath(directory));
const reachesProtectedState = (target: string, destructive = false, followLeaf = true): boolean => {
  if (protectedRoots.some(directory => contains(directory, target) || (destructive && contains(target, directory)))) return true;
  const physical = followLeaf ? physicalPath(target) : path.join(physicalPath(path.dirname(target)), path.basename(target));
  return physicalProtectedRoots.some(directory => contains(directory, physical) || (destructive && contains(physical, directory)));
};
const descriptors = new Map<number, unknown>();
const asPath = (value: unknown): string | undefined => {
  if (typeof value === "string") return path.resolve(value);
  if (Buffer.isBuffer(value)) return path.resolve(value.toString());
  if (value instanceof URL) return path.resolve(fileURLToPath(value));
  return undefined;
};
const assertSafePath = (value: unknown, destructive = false, followLeaf = true): void => {
  const target = asPath(value);
  if (target === undefined) {
    if (typeof value === "number" && descriptors.has(value)) assertSafePath(descriptors.get(value), destructive, followLeaf);
    else if (typeof value === "object" && value !== null && "fd" in value && typeof value.fd === "number") assertSafePath(value.fd, destructive, followLeaf);
    return;
  }
  if (process.platform === "win32" && target.toLowerCase().startsWith("\\\\.\\pipe\\")) return;
  if (reachesProtectedState(target, destructive, followLeaf)) throw new Error(`Test mutation targets retained Daynight state: ${target}`);
};
if (ownsRoot) {
  const temporary = path.join(repositoryRoot, ".tmp");
  assertSafePath(temporary);
  original.mkdir(temporary, { recursive: true });
  assertSafePath(path.join(temporary, "cli-tests-"));
  root = original.mkdtemp(path.join(temporary, "cli-tests-"));
  for (const directory of [path.join(root, "home"), path.join(root, "tmp")]) original.mkdir(directory);
  process.env.HOME = path.join(root, "home"); process.env.USERPROFILE = process.env.HOME;
  for (const name of ["TMPDIR", "TEMP", "TMP"]) process.env[name] = path.join(root, "tmp");
  delete process.env.DN_CONFIG_DIR;
  process.env[metadataName] = JSON.stringify({ root, protectedRoots });
}
const requireOption = `--require=${JSON.stringify(preload)}`;
const guardedEnvironment = (supplied: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv => {
  const environment = { ...supplied };
  for (const key of Object.keys(environment)) {
    if ([metadataName, "NODE_OPTIONS", "DN_CONFIG_DIR", "HOME", "USERPROFILE"].includes(key.toUpperCase()) && key !== key.toUpperCase()) {
      environment[key.toUpperCase()] = environment[key]; delete environment[key];
    }
  }
  environment[metadataName] = process.env[metadataName];
  if (environment.DN_CONFIG_DIR !== undefined) assertSafePath(environment.DN_CONFIG_DIR);
  for (const name of ["HOME", "USERPROFILE"]) {
    const home = environment[name];
    if (home === undefined || (environment.DN_CONFIG_DIR === undefined && reachesProtectedState(path.join(path.resolve(home), ".daynight")))) environment[name] = path.join(root!, "home");
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
      if (returnsPromise || object === promises) return Promise.reject(error);
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
const firstPath = (arguments_: unknown[]): void => assertSafePath(arguments_[0]);
const removal = (arguments_: unknown[]): void => assertSafePath(arguments_[0], true, false);
for (const name of ["writeFile", "appendFile", "mkdir", "mkdtemp", "truncate", "chmod", "chown", "utimes", "lutimes", "lchmod", "lchown"]) {
  const inspect = name.startsWith("l") ? (arguments_: unknown[]) => assertSafePath(arguments_[0], false, false) : firstPath;
  for (const object of [fs, promises]) patch(object, name, inspect);
  patch(fs, `${name}Sync`, inspect);
}
for (const name of ["unlink", "rm", "rmdir"]) {
  for (const object of [fs, promises]) patch(object, name, removal);
  patch(fs, `${name}Sync`, removal);
}
for (const name of ["rename", "link"]) {
  const inspect = (arguments_: unknown[]): void => { assertSafePath(arguments_[0], name === "rename", name === "link"); assertSafePath(arguments_[1], false, false); };
  for (const object of [fs, promises]) patch(object, name, inspect);
  patch(fs, `${name}Sync`, inspect);
}
for (const name of ["copyFile", "cp", "symlink"]) {
  const inspect = (arguments_: unknown[]): void => assertSafePath(arguments_[1], false, name !== "symlink");
  for (const object of [fs, promises]) patch(object, name, inspect);
  patch(fs, `${name}Sync`, inspect);
}
// A filter keeps recursive copies on Node's checked traversal rather than its native fast path.
const guardedCopyFilter = (filter: ((source: string, destination: string) => boolean | Promise<boolean>) | undefined, asynchronous: boolean) => {
  if (asynchronous) return async (source: string, destination: string) => {
    const included = filter === undefined ? true : await filter(source, destination);
    if (included) assertSafePath(destination);
    return included;
  };
  return (source: string, destination: string) => {
    const included = filter === undefined ? true : filter(source, destination);
    if (included) assertSafePath(destination);
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
  if (writableOpen(flags)) assertSafePath(filename);
  const descriptor = (openSync as any)(filename, flags, mode); descriptors.set(descriptor, filename); return descriptor;
};
const openCallback = fs.open;
(fs as any).open = (filename: unknown, flags: unknown, ...arguments_: any[]) => {
  const callback = arguments_.pop();
  try { if (writableOpen(flags)) assertSafePath(filename); }
  catch (error) { queueMicrotask(() => callback(error)); return; }
  (openCallback as any)(filename, flags, ...arguments_, (error: unknown, descriptor: number) => {
    if (error === null) descriptors.set(descriptor, filename);
    callback(error, descriptor);
  });
};
const openPromise = promises.open;
(promises as any).open = async (filename: unknown, flags: unknown, mode: unknown) => {
  if (writableOpen(flags)) assertSafePath(filename);
  const handle = await (openPromise as any)(filename, flags, mode); descriptors.set(handle.fd, filename);
  for (const name of ["write", "writev", "writeFile", "appendFile", "truncate", "chmod", "chown", "utimes", "createWriteStream"]) patch(handle, name, () => assertSafePath(filename), name !== "createWriteStream");
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
  assertSafePath(options?.fd === undefined ? arguments_[0] : options.fd);
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
// The custom promisify contract exposes both output streams and the spawned child.
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
const environmentEntries = (entries: string[]): string[] => {
  const environment = Object.fromEntries(entries.map(entry => { const index = entry.indexOf("="); return [entry.slice(0, index), entry.slice(index + 1)]; }));
  return Object.entries(guardedEnvironment(environment)).filter(([, value]) => value !== undefined).map(([name, value]) => `${name}=${value}`);
};
moduleLoader._load = function (request: string, ...arguments_: any[]) {
  const loaded = Reflect.apply(load, this, [request, ...arguments_]);
  // Native binding interception also covers packages entered through Node's ESM translator.
  if (request.endsWith(".node") && typeof loaded.Database === "function" && typeof loaded.initialize === "function" && !sqliteConstructors.has(loaded.Database)) {
    const database = loaded.Database;
    patch(database.prototype, "backup", arguments_ => assertSafePath(arguments_[2]));
    const guarded = new Proxy(database, {
      construct(target, arguments_, newTarget) { if (!arguments_[2]) assertSafePath(arguments_[0]); return Reflect.construct(target, arguments_, newTarget); },
    });
    sqliteConstructors.set(database, guarded); sqliteConstructors.set(guarded, guarded); loaded.Database = guarded;
  }
  if (request.endsWith(".node") && typeof loaded.fork === "function" && /node-pty|pty\.node/.test(request) && !loaded.fork.__isolated) {
    const fork = loaded.fork;
    const isolated = function (this: unknown, ...arguments_: any[]) { arguments_[2] = environmentEntries(arguments_[2]); return Reflect.apply(fork, this, arguments_); };
    isolated.__isolated = true; loaded.fork = isolated;
  }
  if (request.endsWith(".node") && typeof loaded.startProcess === "function" && /node-pty|(?:con)?pty\.node/.test(request) && !loaded.startProcess.__isolated) {
    const startProcess = loaded.startProcess;
    const isolated = function (this: unknown, ...arguments_: any[]) { if (Array.isArray(arguments_[2])) arguments_[2] = environmentEntries(arguments_[2]); return Reflect.apply(startProcess, this, arguments_); };
    isolated.__isolated = true; loaded.startProcess = isolated;
    if (typeof loaded.connect === "function") {
      const connect = loaded.connect;
      loaded.connect = function (this: unknown, ...arguments_: any[]) { arguments_[3] = environmentEntries(arguments_[3]); return Reflect.apply(connect, this, arguments_); };
    }
  }
  if (request !== "better-sqlite3" || typeof loaded !== "function") return loaded;
  let guarded = sqliteConstructors.get(loaded);
  if (guarded !== undefined) return guarded;
  const check = (arguments_: any[]): void => { if (typeof arguments_[0] === "string" && arguments_[0] !== "" && arguments_[0] !== ":memory:") assertSafePath(arguments_[0]); };
  patch(loaded.prototype, "backup", firstPath, true);
  const constructor = new Proxy(loaded, {
    construct(target, arguments_, newTarget) { check(arguments_); return Reflect.construct(target, arguments_, newTarget); },
    apply(target, receiver, arguments_) { check(arguments_); return Reflect.apply(target, receiver, arguments_); },
  });
  sqliteConstructors.set(loaded, constructor); return constructor;
};
moduleApi.syncBuiltinESMExports();
const isolation = {
  root: root!,
  assertSafePath,
  guardedEnvironment,
  cleanup: () => { assertSafePath(root!, true, false); original.rm(root!, { recursive: true, force: true }); },
};
module.exports = isolation;
if (ownsRoot) process.once("exit", () => isolation.cleanup());
