import path from "node:path";
import { lstat, realpath } from "node:fs/promises";
import { resolvePhysicalDirectory } from "../../platform/filesystem.js";

const pointerPath = (base: string, raw: string): string => {
  if (!raw || /[\r\n\0]/.test(raw)) throw new Error("A Git pointer must contain a path without line breaks or NUL.");
  if (path.isAbsolute(raw)) {
    if (path.sep === "\\" && path.parse(raw).root.length === 1) throw new Error("A drive-root-relative Git pointer cannot establish its volume.");
    return raw;
  }
  if (path.parse(raw).root) throw new Error("A drive-relative Git pointer cannot establish its target.");
  // Keep the original traversal for platform-specific proof before lookup.
  return `${base}${path.sep}${raw}`;
};

const proveWindowsParentTraversal = async (target: string): Promise<void> => {
  if (path.sep !== "\\") return;
  const root = path.parse(target).root;
  let cursor = root;
  for (const component of target.slice(root.length).split(/[\\/]+/)) {
    if (component === "..") {
      // Node normalizes Windows paths before opening them. Prove each directory
      // that normalization erases; a junction or failed observation is unknown.
      const entry = await lstat(cursor);
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("A Windows Git pointer parent traversal requires an ordinary directory.");
      cursor = path.dirname(cursor);
    } else if (component && component !== ".") cursor = path.join(cursor, component);
  }
};

export type GitFileTarget = { path: string; missing: boolean };
// Missing objects supply no evidence that case variants name independent targets.
export const ambiguousMissingGitTargets = (left: GitFileTarget, right: GitFileTarget): boolean =>
  left.missing && right.missing && left.path !== right.path && left.path.toLowerCase() === right.path.toLowerCase();

export const resolveGitFile = async (base: string, raw: string): Promise<GitFileTarget> => {
  const target = pointerPath(base, raw);
  await proveWindowsParentTraversal(target);
  let entry;
  try { entry = await lstat(target); }
  catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    const parent = await resolvePhysicalDirectory(path.dirname(target));
    const descendants = [...parent.missingComponents, path.basename(target)];
    if (descendants.some(part => part === "." || part === "..")) throw new Error("A missing Git pointer target has unresolved parent traversal.", { cause: error });
    return { path: path.join(parent.ancestorPath, ...descendants), missing: true };
  }
  if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1) throw new Error("A Git registration target must be an ordinary file with one link.");
  // Canonicalize existing case aliases; never treat a later read failure as missing.
  return { path: await realpath(target), missing: false };
};

export const resolveGitDirectory = async (base: string, raw: string): Promise<string> => {
  const target = pointerPath(base, raw);
  await proveWindowsParentTraversal(target);
  const entry = await lstat(target);
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("A Git directory pointer must identify an ordinary directory.");
  return realpath(target);
};
