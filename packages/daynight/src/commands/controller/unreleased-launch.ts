import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, open, unlink } from "node:fs/promises";
import path from "node:path";
import { syncDurableDirectory } from "../../platform/durable-directory.js";
import { controllerPayloadHash, controllerTicketPath, parseLaunchTicket, type ControllerLaunchTicket } from "./launch-ticket.js";

export type UnreleasedLaunchReceipt = { readonly kind: "controller-unreleased"; readonly ticketHash: string; readonly pid: number };
const MAX_RECEIPT_BYTES = 1024;
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === "ENOENT";

export const unreleasedLaunchPath = (home: string, ticket: ControllerLaunchTicket, storageStateDirectory?: string): string => {
  parseLaunchTicket(ticket);
  return path.join(path.dirname(controllerTicketPath(home, ticket.launchId, storageStateDirectory)), `${ticket.launchId}.unreleased.json`);
};

const parseReceipt = (value: unknown, ticket: ControllerLaunchTicket): UnreleasedLaunchReceipt => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Unreleased launch receipt must be an object.");
  const data = value as Record<string, unknown>;
  if (Object.keys(data).sort().join() !== "kind,pid,ticketHash" || data.kind !== "controller-unreleased"
    || typeof data.ticketHash !== "string" || !/^[a-f0-9]{64}$/.test(data.ticketHash) || data.ticketHash !== controllerPayloadHash(ticket)
    || !Number.isSafeInteger(data.pid) || (data.pid as number) <= 0 || (data.pid as number) > 2_147_483_647) throw new Error("Unreleased launch receipt is invalid or conflicts with its ticket.");
  return data as UnreleasedLaunchReceipt;
};

/** Absence is distinct from malformed, conflicting or unreadable evidence. */
export const readUnreleasedLaunch = async (home: string, ticket: ControllerLaunchTicket, storageStateDirectory?: string): Promise<UnreleasedLaunchReceipt | undefined> => {
  const file = unreleasedLaunchPath(home, ticket, storageStateDirectory);
  let handle;
  // Windows requires a writable handle for fsync; inability to open one leaves
  // the receipt unconfirmed rather than treating visibility as durability.
  try { handle = await open(file, process.platform === "win32" ? constants.O_RDWR : constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if (missing(error)) return undefined; throw error; }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_RECEIPT_BYTES || (process.platform !== "win32" && (stat.mode & 0o077) !== 0)) throw new Error("Unreleased launch receipt must be a private regular file within its size limit.");
    const bytes = Buffer.alloc(MAX_RECEIPT_BYTES + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > MAX_RECEIPT_BYTES) throw new Error("Unreleased launch receipt exceeds its size limit.");
    const text = bytes.subarray(0, offset).toString("utf8");
    const receipt = parseReceipt(JSON.parse(text) as unknown, ticket);
    // JSON.parse otherwise silently accepts duplicate object keys.
    const keys = [...text.matchAll(/"(?:\\["\\/bfnrt]|\\u[0-9a-fA-F]{4}|[^"\\\u0000-\u001f])*"\s*:/g)]
      .map(match => JSON.parse(match[0].slice(0, match[0].lastIndexOf(":"))) as string);
    if (keys.length !== 3 || new Set(keys).size !== 3) throw new Error("Unreleased launch receipt has duplicate fields.");
    // A prior publisher may have linked the file but failed before syncing it.
    await handle.sync();
    syncDurableDirectory(path.dirname(file));
    return receipt;
  } finally { await handle.close(); }
};

/** Call only after the original child exited and its gate was never released. */
export const writeUnreleasedLaunch = async (home: string, ticket: ControllerLaunchTicket, pid: number, storageStateDirectory?: string): Promise<UnreleasedLaunchReceipt> => {
  const file = unreleasedLaunchPath(home, ticket, storageStateDirectory);
  const receipt = parseReceipt({ kind: "controller-unreleased", ticketHash: controllerPayloadHash(ticket), pid }, ticket);
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  let failure: unknown;
  try {
    try { await handle.writeFile(`${JSON.stringify(receipt)}\n`); await handle.sync(); }
    finally { await handle.close(); }
    try { await link(temporary, file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const saved = await readUnreleasedLaunch(home, ticket, storageStateDirectory);
    if (!saved || saved.pid !== pid) throw new Error("Unreleased launch receipt conflicts with the original result.");
    return saved;
  } catch (error) { failure = error; throw error; }
  finally {
    try { await unlink(temporary); }
    catch (cleanup) {
      if (failure !== undefined) throw new AggregateError([failure, cleanup], "Unreleased launch publication and cleanup failed.", { cause: failure });
      throw cleanup;
    }
  }
};
