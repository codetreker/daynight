import { execFile, spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, chmod, copyFile, cp, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const marker = "daynight-local-development-build-v1";
const repositoryDirectory = fileURLToPath(new URL("../", import.meta.url));
const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const missing = (error) => error?.code === "ENOENT" || error?.code === "ENOTDIR";
const readJson = async (filename) => JSON.parse(await readFile(filename, "utf8"));

const assertOwnedLauncher = async (filename) => {
  let stat;
  try { stat = await lstat(filename); }
  catch (error) { if (missing(error)) return; throw error; }
  if (stat.isSymbolicLink()) {
    try {
      const target = await realpath(filename);
      const info = await readJson(path.join(path.dirname(target), "build-info.json"));
      if (path.basename(target) === "daynight-dev" && info.format === marker) return;
    } catch { /* An incomplete or unknown installation must not be overwritten. */ }
  }
  throw new Error(`Refusing to replace ${filename}: it is not an owned daynight-dev launcher. Move it explicitly before installing.`);
};

const resolveInstalledPackage = async (from, name) => {
  let directory = from;
  for (;;) {
    const candidate = path.join(directory, "node_modules", name);
    try {
      await access(path.join(candidate, "package.json"));
      return await realpath(candidate);
    } catch (error) { if (!missing(error)) throw error; }
    const parent = path.dirname(directory);
    if (parent === directory) {
      const error = new Error(`Missing installed dependency ${name} from ${from}; run pnpm install first.`);
      error.code = "DEPENDENCY_NOT_INSTALLED";
      throw error;
    }
    directory = parent;
  }
};

/** Copy the production closure, including peer resolutions, without links into mutable node_modules. */
const copyDependencies = async (packageDirectory, destination, manifest) => {
  const copied = new Map();
  const store = path.join(destination, "node_modules", ".dev-store");
  const copyPackage = async (source) => {
    const previous = copied.get(source);
    if (previous !== undefined) return previous;
    const target = path.join(store, String(copied.size));
    copied.set(source, target);
    await mkdir(path.dirname(target), { recursive: true });
    await cp(source, target, {
      recursive: true, dereference: true, mode: constants.COPYFILE_FICLONE,
      filter: (filename) => filename !== path.join(source, "node_modules"),
    });
    await connect(source, target, await readJson(path.join(source, "package.json")));
    return target;
  };
  const connect = async (source, target, metadata) => {
    const required = new Set(Object.keys(metadata.dependencies ?? {}));
    const optional = new Set(Object.keys(metadata.optionalDependencies ?? {}));
    const peers = Object.keys(metadata.peerDependencies ?? {});
    for (const name of new Set([...required, ...optional, ...peers])) {
      let dependency;
      try { dependency = await resolveInstalledPackage(source, name); }
      catch (error) {
        if (error.code === "DEPENDENCY_NOT_INSTALLED" && (optional.has(name) || (!required.has(name) && metadata.peerDependenciesMeta?.[name]?.optional === true))) continue;
        throw error;
      }
      const copiedDependency = await copyPackage(dependency);
      const link = path.join(target, "node_modules", name);
      await mkdir(path.dirname(link), { recursive: true });
      await symlink(path.relative(path.dirname(link), copiedDependency), link);
    }
  };
  await connect(packageDirectory, destination, manifest);
};

const build = async (sourceDirectory) => {
  const manager = process.env.npm_execpath;
  const command = manager === undefined ? "pnpm" : process.execPath;
  const args = [...(manager === undefined ? [] : [manager]), "--filter", "@codetreker/daynight", "build"];
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: sourceDirectory, stdio: "inherit", timeout: 180_000 });
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`Development build failed (${signal ?? code}).`)));
  });
};

export const installDevelopmentBuild = async (options = {}) => {
  if (process.platform === "win32") throw new Error("daynight-dev installation currently requires macOS or Linux.");
  if (Number(process.versions.node.split(".")[0]) !== 24) throw new Error("Build daynight-dev using Node.js 24 LTS.");
  const sourceDirectory = await realpath(options.sourceDirectory ?? repositoryDirectory);
  const nodeExecutable = await realpath(process.execPath);
  const binDirectory = path.resolve(options.binDirectory ?? path.dirname(process.execPath));
  const installed = path.join(binDirectory, "daynight-dev");
  await mkdir(binDirectory, { recursive: true });
  const lock = path.join(binDirectory, ".daynight-dev-install.lock");
  try { await mkdir(lock); }
  catch (error) {
    if (error.code === "EEXIST") throw new Error(`Another development install may be running. If it has stopped, remove ${lock} and retry.`);
    throw error;
  }
  let snapshot;
  let published = false;
  const temporaryLink = path.join(lock, "daynight-dev");
  try {
    await assertOwnedLauncher(installed);
    if (options.build !== false) await build(sourceDirectory);
    const packageDirectory = path.join(sourceDirectory, "packages", "daynight");
    const manifest = await readJson(path.join(packageDirectory, "package.json"));
    if (manifest.name !== "@codetreker/daynight") throw new Error("The source directory does not contain the Daynight CLI package.");
    await access(path.join(packageDirectory, "dist", "main.js"));
    const git = options.metadata ?? {
      commit: (await exec("git", ["rev-parse", "HEAD"], { cwd: sourceDirectory, timeout: 10_000 })).stdout.trim(),
      dirty: (await exec("git", ["status", "--porcelain"], { cwd: sourceDirectory, timeout: 10_000 })).stdout.length !== 0,
    };
    const snapshots = path.join(sourceDirectory, ".tmp", "dev-builds");
    await mkdir(snapshots, { recursive: true });
    snapshot = await mkdtemp(path.join(snapshots, "build-"));
    const destination = path.join(snapshot, "package");
    await mkdir(destination);
    await cp(path.join(packageDirectory, "dist"), path.join(destination, "dist"), { recursive: true, dereference: true, mode: constants.COPYFILE_FICLONE });
    await copyFile(path.join(packageDirectory, "package.json"), path.join(destination, "package.json"), constants.COPYFILE_FICLONE);
    try { await copyFile(path.join(packageDirectory, "config.example.yml"), path.join(destination, "config.example.yml")); }
    catch (error) { if (!missing(error)) throw error; }
    await copyDependencies(packageDirectory, destination, manifest);
    const info = { format: marker, sourceDirectory, commit: git.commit, dirty: git.dirty, version: manifest.version, builtAt: new Date().toISOString(), nodeExecutable, snapshotDirectory: snapshot };
    await writeFile(path.join(snapshot, "build-info.json"), `${JSON.stringify(info, null, 2)}\n`);
    const main = path.join(destination, "dist", "main.js");
    const verifiedVersion = (await exec(nodeExecutable, [main, "--version"], { cwd: snapshot, timeout: 30_000 })).stdout.trim();
    if (verifiedVersion !== manifest.version) throw new Error(`The development snapshot returned version ${JSON.stringify(verifiedVersion)}; expected ${manifest.version}.`);
    const launcher = path.join(snapshot, "launcher.mjs");
    await writeFile(launcher, `import { homedir } from "node:os";
import path from "node:path";
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--build-info") {
  console.log(${JSON.stringify(JSON.stringify(info, null, 2))});
} else if (args[0] === "update") {
  console.error("daynight-dev is a local build. Rebuild and install it with pnpm dev:install in " + ${JSON.stringify(sourceDirectory)} + ". The npm installation was not changed.");
  process.exitCode = 1;
} else {
  process.env.DN_CONFIG_DIR ??= path.join(homedir(), ".daynight-dev");
  process.argv = [process.execPath, ${JSON.stringify(main)}, ...args];
  await import(${JSON.stringify(pathToFileURL(main).href)});
}
`);
    const executable = path.join(snapshot, "daynight-dev");
    await writeFile(executable, `#!/bin/sh\nexec ${shellQuote(nodeExecutable)} ${shellQuote(launcher)} "$@"\n`, { mode: 0o755 });
    await chmod(executable, 0o755);
    await symlink(executable, temporaryLink);
    await assertOwnedLauncher(installed);
    await rename(temporaryLink, installed);
    published = true;
    return { executable, installed, info };
  } finally {
    if (!published && snapshot !== undefined) await rm(snapshot, { recursive: true, force: true });
    await rm(lock, { recursive: true, force: true });
  }
};

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
      console.log("Usage: pnpm dev:install [--bin-dir <directory>]\n\nBuild and install an immutable local daynight-dev snapshot. Defaults to the current Node.js executable directory. Requires Node.js 24 and macOS or Linux.");
    } else {
      if (args.length !== 0 && !(args.length === 2 && args[0] === "--bin-dir" && args[1] !== "")) throw new Error("Usage: pnpm dev:install [--bin-dir <directory>]");
      const result = await installDevelopmentBuild(args.length === 0 ? {} : { binDirectory: args[1] });
      console.log(`Installed ${result.installed}\nSnapshot: ${result.info.snapshotDirectory}\nSource: ${result.info.sourceDirectory}\nCommit: ${result.info.commit}${result.info.dirty ? " (dirty)" : ""}\nVersion: ${result.info.version}\nConfiguration defaults to ~/.daynight-dev; agentCliAliases remains opt-in.\nUse daynight-dev --build-info to inspect this build. Keep the snapshot while any execution uses it.`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
