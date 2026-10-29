import { execFileSync, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import crossSpawn from "cross-spawn";
import { parse } from "yaml";

export type InstalledCliReceipt = {
  readonly schemaVersion: 1;
  readonly root: string;
  readonly packageVersion: string;
  readonly tarballPath: string;
  readonly tarballSha256: string;
  readonly nodePath: string;
  readonly entryPath: string;
  readonly entrySha256: string;
  readonly launcherPath: string;
  readonly source: { readonly gitSha: string; readonly gitTreeSha: string; readonly dirty: boolean };
};

const workspace = path.resolve(import.meta.dirname, "../../../..");
const digest = (content: Uint8Array): string => createHash("sha256").update(content).digest("hex");

const boundedClose = async (closed: Promise<unknown>): Promise<void> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([closed, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Owned process did not close within two seconds.")), 2_000); })]); }
  finally { if (timer !== undefined) clearTimeout(timer); }
};

export const terminateInstalledProcess = async (child: ChildProcess, closed: Promise<unknown>): Promise<void> => {
  const failures: unknown[] = [];
  try {
    if (child.pid !== undefined) {
      if (process.platform === "win32") {
        const systemRoot = Object.entries(process.env).find(([name]) => name.toLowerCase() === "systemroot")?.[1];
        if (systemRoot === undefined || !path.isAbsolute(systemRoot)) throw new Error("Windows system directory is unavailable for owned process-tree termination.");
        const killer = spawn(path.join(systemRoot, "System32", "taskkill.exe"), ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
        let launchFailure: unknown;
        killer.once("error", (cause) => { launchFailure = cause; });
        const killed = new Promise<number | null>((resolve) => killer.once("close", resolve));
        try {
          await boundedClose(killed);
          const code = await killed;
          if (launchFailure !== undefined) throw launchFailure;
          if (code !== 0 && child.exitCode === null && child.signalCode === null) throw new Error(`Owned process-tree termination failed with code ${String(code)}.`);
        } catch (cause) {
          killer.kill("SIGKILL");
          try { await boundedClose(killed); } catch (reapError) { throw new AggregateError([cause, reapError], "Process-tree termination tool could not be reaped."); }
          throw cause;
        }
      } else {
        try { process.kill(-child.pid, "SIGKILL"); }
        catch (cause) { if (!(cause instanceof Error && "code" in cause && cause.code === "ESRCH")) throw cause; }
      }
    }
  } catch (cause) { failures.push(cause); }
  try { await boundedClose(closed); } catch (cause) { failures.push(cause); }
  if (failures.length !== 0) throw new AggregateError(failures, "Owned installation process-tree cleanup failed.");
};

export const createInstalledCli = async (options: { readonly signal?: AbortSignal; readonly temporaryRoot?: string; readonly rootDirectory?: string; readonly onSpawn?: (child: ChildProcess) => void | Promise<void> } = {}): Promise<{
  readonly receipt: InstalledCliReceipt;
  readonly receiptPath: string;
  cleanup(): Promise<void>;
}> => {
  const check = (): void => options.signal?.throwIfAborted();
  check();
  const temporary = options.temporaryRoot === undefined ? path.join(workspace, ".tmp") : options.temporaryRoot;
  if (!path.isAbsolute(temporary)) throw new Error("Installed CLI temporary root must be absolute.");
  await mkdir(temporary, { recursive: true });
  check();
  let root: string;
  if (options.rootDirectory === undefined) root = await mkdtemp(path.join(temporary, "Installed project task 中文 "));
  else {
    if (!path.isAbsolute(options.rootDirectory) || path.dirname(options.rootDirectory) !== temporary) throw new Error("Installed CLI root must be an immediate child of its temporary root.");
    await mkdir(options.rootDirectory, { mode: 0o700 });
    root = options.rootDirectory;
  }
  try {
    check();
    await chmod(root, 0o700);
    check();
    const packageDirectory = path.join(workspace, "packages/daynight");
    const consumer = path.join(root, "consumer install");
    await mkdir(consumer);
    check();
    const modules: unknown = parse(await readFile(path.join(workspace, "node_modules/.modules.yaml"), "utf8"));
    if (typeof modules !== "object" || modules === null || !("storeDir" in modules) || typeof modules.storeDir !== "string") throw new Error("Workspace dependency installation does not identify its pnpm store.");
    check();
    const storeDirectory = path.dirname(modules.storeDir);
    const pnpm = async (args: readonly string[], cwd: string): Promise<void> => {
      check();
      const child = crossSpawn("pnpm", [...args], { cwd, stdio: "inherit", windowsHide: true, detached: process.platform !== "win32", env: { ...process.env, NO_COLOR: "1", XDG_CACHE_HOME: path.join(root, "cache") } });
      let failure: Error | undefined;
      child.once("error", (cause) => { failure = cause; });
      const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.once("close", (code, signal) => resolve({ code, signal })));
      let timer: ReturnType<typeof setTimeout> | undefined;
      let cancelled = (): void => {};
      const cancellation = new Promise<"cancelled">((resolve) => { cancelled = () => resolve("cancelled"); });
      options.signal?.addEventListener("abort", cancelled, { once: true });
      if (options.signal?.aborted) cancelled();
      let result: Awaited<typeof closed> | "timeout" | "cancelled";
      try {
        const registered = Promise.resolve(options.onSpawn?.(child));
        result = await Promise.race([registered.then(() => closed), cancellation, new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), 120_000); })]);
      } catch (cause) {
        try { await terminateInstalledProcess(child, closed); }
        catch (cleanupError) { throw new AggregateError([cause, cleanupError], "Installation registration and cleanup failed."); }
        throw cause;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        options.signal?.removeEventListener("abort", cancelled);
      }
      if (result === "timeout" || result === "cancelled") {
        const cause: unknown = result === "cancelled" ? options.signal!.reason : new Error(`Installed CLI preparation exceeded the pnpm ${args[0]} deadline.`);
        try { await terminateInstalledProcess(child, closed); }
        catch (cleanupError) { throw new AggregateError([cause, cleanupError], "Installation preparation and cleanup failed."); }
        throw cause;
      }
      if (failure !== undefined) throw failure;
      if (result.code !== 0) throw new Error(`pnpm ${args[0]} failed with code ${String(result.code)} and signal ${String(result.signal)}.`);
      check();
    };
    const tarballPath = path.join(root, "daynight.tgz");
    await pnpm(["pack", "--out", tarballPath], packageDirectory);
    await writeFile(path.join(consumer, "package.json"), `${JSON.stringify({ name: "daynight-project-task-acceptance", private: true, dependencies: { "@codetreker/daynight": `file:${tarballPath.replaceAll("\\", "/")}` } })}\n`);
    check();
    await pnpm(["install", "--prod", "--ignore-scripts", "--ignore-workspace", "--no-frozen-lockfile", "--store-dir", storeDirectory, "--reporter", "append-only"], consumer);
    const installedPackage = path.join(consumer, "node_modules/@codetreker/daynight");
    check();
    const installed = JSON.parse(await readFile(path.join(installedPackage, "package.json"), "utf8")) as { name: string; version: string; bin: { daynight: string } };
    const source = JSON.parse(await readFile(path.join(packageDirectory, "package.json"), "utf8")) as { version: string };
    if (installed.name !== "@codetreker/daynight" || installed.version !== source.version || installed.bin.daynight !== "dist/main.js") throw new Error("Installed CLI package identity differs from the packed workspace package.");
    const entryPath = path.join(installedPackage, "dist/main.js");
    const launcherPath = path.join(consumer, "node_modules/.bin", process.platform === "win32" ? "daynight.cmd" : "daynight");
    await readFile(launcherPath);
    check();
    const git = (args: string[]): string => execFileSync("git", ["--no-pager", "-c", "core.fsmonitor=false", "-C", workspace, ...args], { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"], env: Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith("GIT_"))) }).trim();
    const receipt: InstalledCliReceipt = {
      schemaVersion: 1, root, packageVersion: installed.version, tarballPath,
      tarballSha256: digest(await readFile(tarballPath)), nodePath: process.execPath, entryPath,
      entrySha256: digest(await readFile(entryPath)), launcherPath,
      source: { gitSha: git(["rev-parse", "HEAD"]), gitTreeSha: git(["rev-parse", "HEAD^{tree}"]), dirty: git(["status", "--porcelain"]) !== "" },
    };
    check();
    const receiptPath = path.join(root, "installed-cli.json");
    await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
    check();
    return { receipt, receiptPath, cleanup: async () => { await rm(root, { recursive: true, force: true }); } };
  } catch (cause) {
    try { await rm(root, { recursive: true, force: true }); }
    catch (cleanupError) { throw new AggregateError([cause, cleanupError], "Installed CLI preparation and cleanup failed."); }
    throw cause;
  }
};
