import { closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync } from "node:fs";
import path from "node:path";

export const syncDurableDirectory = (directory: string): void => {
  // Windows does not expose directory handles through fs.open.
  if (process.platform === "win32") return;
  const fd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
};

/** A durable child requires both its contents and its parent's directory entry. */
export const ensureDurableDirectory = (directory: string): void => {
  if (!path.isAbsolute(directory)) throw new Error("Durable directories require absolute paths.");
  const parent = path.dirname(directory);
  let stat;
  try { stat = lstatSync(directory); }
  catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT" || parent === directory) throw cause;
    ensureDurableDirectory(parent);
    try { mkdirSync(directory, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    stat = lstatSync(directory);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("A durable directory must be an original physical directory.");
  // Also sync an existing entry: an earlier mkdir may have succeeded before its
  // parent fsync failed, so visibility alone is not a durability confirmation.
  syncDurableDirectory(directory);
  if (parent !== directory) syncDurableDirectory(parent);
};
