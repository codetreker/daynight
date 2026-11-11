import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, openSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const syncDirectory = (directory: string): void => {
  // Windows does not expose directory handles through fs.open; file flush remains mandatory.
  if (process.platform === "win32") return;
  const fd = openSync(directory, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
};
export const writeDurableJson = (file: string, value: unknown): void => {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  let published = false;
  try {
    try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); }
    catch (error) {
      try { closeSync(fd); }
      catch (closeError) { throw new AggregateError([error, closeError], "Durable JSON write and close failed.", { cause: error }); }
      throw error;
    }
    closeSync(fd);
    renameSync(temporary, file);
    published = true;
    syncDirectory(dirname(file));
  } catch (error) {
    if (!published) {
      try { unlinkSync(temporary); }
      catch (cleanup) {
        if ((cleanup as NodeJS.ErrnoException).code !== "ENOENT") throw new AggregateError([error, cleanup], "Durable JSON publication and temporary-file cleanup failed.", { cause: error });
      }
    }
    throw error;
  }
};
