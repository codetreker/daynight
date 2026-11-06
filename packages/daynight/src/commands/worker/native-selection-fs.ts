import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { SessionFsProvider, SessionFsFileInfo } from "@github/copilot-sdk";

/** Native discovery can read its cwd; every probe write remains in memory. */
export const createNativeSelectionFs = (cwd: string): SessionFsProvider => {
  const entries = new Map<string, string | null>(), removed = new Set<string>();
  const resolve = (value: string) => path.resolve(cwd, value);
  const missing = () => Object.assign(new Error("Probe filesystem entry does not exist."), { code: "ENOENT" });
  const hidden = (value: string) => [...removed].some(parent => value === parent || value.startsWith(parent + path.sep));
  const mkdir = async (value: string): Promise<void> => {
    const target = resolve(value); removed.delete(target); entries.set(target, null);
    if (path.dirname(target) !== target) await mkdir(path.dirname(target));
  };
  const write = async (value: string, content: string): Promise<void> => {
    const target = resolve(value); await mkdir(path.dirname(target)); removed.delete(target); entries.set(target, content);
  };
  const info = async (value: string): Promise<SessionFsFileInfo> => {
    const target = resolve(value);
    if (hidden(target)) throw missing();
    if (entries.has(target)) {
      const content = entries.get(target), directory = content === null;
      return { isFile: !directory, isDirectory: directory, size: content === null || content === undefined ? 0 : Buffer.byteLength(content), mtime: new Date(0).toISOString(), birthtime: new Date(0).toISOString() };
    }
    const actual = await stat(target);
    return { isFile: actual.isFile(), isDirectory: actual.isDirectory(), size: actual.size, mtime: actual.mtime.toISOString(), birthtime: actual.birthtime.toISOString() };
  };
  const read = async (value: string): Promise<string> => {
    const target = resolve(value); if (hidden(target)) throw missing();
    const content = entries.get(target);
    if (content === null) throw new Error("Probe filesystem entry is a directory.");
    return content ?? await readFile(target, "utf8");
  };
  const list = async (value: string): Promise<string[]> => {
    const target = resolve(value); if (!(await info(target)).isDirectory) throw new Error("Probe filesystem entry is not a directory.");
    const names = new Set<string>();
    try { for (const name of await readdir(target)) names.add(name); } catch (error) { if (!entries.has(target)) throw error; }
    for (const entry of entries.keys()) if (entry !== target && path.dirname(entry) === target) names.add(path.basename(entry));
    return [...names].filter(name => !hidden(path.join(target, name)));
  };
  const remove = async (value: string): Promise<void> => {
    const target = resolve(value); removed.add(target);
    for (const entry of entries.keys()) if (entry === target || entry.startsWith(target + path.sep)) entries.delete(entry);
  };
  const copy = async (source: string, destination: string): Promise<void> => {
    if ((await info(source)).isDirectory) { await mkdir(destination); for (const name of await list(source)) await copy(path.join(source, name), path.join(destination, name)); }
    else await write(destination, await read(source));
  };
  return { readFile: read, writeFile: write, appendFile: async (value, content) => { let before = ""; try { before = await read(value); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } await write(value, before + content); },
    exists: async value => { try { await info(value); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; } },
    stat: info, mkdir, readdir: list, readdirWithTypes: async value => Promise.all((await list(value)).map(async name => ({ name, type: (await info(path.join(value, name))).isDirectory ? "directory" as const : "file" as const }))),
    rm: remove, rename: async (source, destination) => { await copy(source, destination); await remove(source); } };
};
