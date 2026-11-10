import { lstatSync, readdirSync } from "node:fs";
import path from "node:path";

/** Count private retained files once per inode, including interrupted writes. */
export const controllerMediaDiskBytes = (roots: readonly string[], reservations: ReadonlyMap<string, number>): number => {
  const inodes = new Map<string, number>(), found = new Set<string>();
  const visit = (filename: string): void => {
    const stat = lstatSync(filename, { bigint: true });
    if (stat.isSymbolicLink()) throw new Error("Controller media contains an untrusted symbolic link.");
    if (stat.isDirectory()) { for (const name of readdirSync(filename)) visit(path.join(filename, name)); return; }
    if (!stat.isFile()) throw new Error("Controller media must contain regular files.");
    if (stat.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Controller media byte count exceeds its budget.");
    const reserved = reservations.get(filename) ?? 0;
    found.add(filename);
    const key = `${stat.dev}:${stat.ino}`;
    inodes.set(key, Math.max(inodes.get(key) ?? 0, Number(stat.size), reserved));
  };
  for (const root of roots) visit(root);
  let total = [...inodes.values()].reduce((sum, bytes) => sum + bytes, 0);
  for (const [filename, bytes] of reservations) {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || !roots.some(root => filename.startsWith(`${root}${path.sep}`))) throw new Error("Invalid private media reservation.");
    if (!found.has(filename)) total += bytes;
  }
  return total;
};
