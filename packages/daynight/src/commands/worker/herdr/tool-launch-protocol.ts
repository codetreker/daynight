import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, unlink } from "node:fs/promises";
import path from "node:path";
import { canonicalId } from "../../../api/parse.js";
import { syncDurableDirectory } from "../../../platform/durable-directory.js";
import { parseResolvedToolLaunch } from "../../../platform/tool-launch-record.js";
import type { ResolvedToolLaunch } from "../../../platform/tool-executables.js";
import { canonicalResourceOwner, sameResourceOwner } from "../resource-owner.js";
import type { HerdrExecutionOwner } from "./agents.js";

export const toolManifestEnvironment = "DAYNIGHT_HERDR_TOOL_MANIFEST";
export type HerdrToolLaunchManifest = {
  schemaVersion: 1;
  owner: HerdrExecutionOwner;
  nonce: string;
  launch: ResolvedToolLaunch;
  nativePath: string | null;
  nodeExecutable: string;
  childEntry: string;
  platform: NodeJS.Platform;
};
export type HerdrToolLaunchIntent = {
  schemaVersion: 1;
  owner: HerdrExecutionOwner;
  nonce: string;
  selectionKey: string;
  logicalArgvDigest: string;
  file: string;
  prefixArgs: string[];
  helperPid: number;
};
export type HerdrToolLaunchReceipt = HerdrToolLaunchIntent & { childPid: number };
export const launchArgvDigest = (agent: string, args: readonly string[]): string => createHash("sha256").update(JSON.stringify([agent, ...args])).digest("hex");
export const mappingFiles = (manifestPath: string) => ({ nativeStart: path.join(path.dirname(manifestPath), "native-start.json"), intent: path.join(path.dirname(manifestPath), "launch-intent.json"), receipt: path.join(path.dirname(manifestPath), "launch-receipt.json"), ready: path.join(path.dirname(manifestPath), "shell-ready.json"), layout: path.join(path.dirname(manifestPath), "layout-intent.json"), initialInput: path.join(path.dirname(manifestPath), "initial-input.json") });
const missing = (cause: unknown) => (cause as NodeJS.ErrnoException)?.code === "ENOENT";
export const assertOwnedDirectory = async (directory: string, create = false): Promise<void> => {
  if (!path.isAbsolute(directory)) throw new Error("A Herdr tool mapping directory must be absolute.");
  if (create) { try { await mkdir(directory, { mode: 0o700 }); syncDurableDirectory(path.dirname(directory)); } catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause; } }
  const entry = await lstat(directory);
  if (!entry.isDirectory() || entry.isSymbolicLink() || process.platform !== "win32" && ((entry.mode & 0o077) !== 0 || entry.uid !== process.getuid?.())) throw new Error("A Herdr tool mapping requires an original owner-only directory.");
};

/** Publish a complete file once. A second launcher cannot overwrite the original intent. */
export const publishOwnedFile = async (file: string, contents: string): Promise<void> => {
  await assertOwnedDirectory(path.dirname(file));
  const temporary = path.join(path.dirname(file), `.tool-${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    try { await handle.writeFile(contents); await handle.sync(); }
    finally { await handle.close(); }
    await link(temporary, file); syncDurableDirectory(path.dirname(file));
  }
  finally { await unlink(temporary); syncDurableDirectory(path.dirname(file)); }
};
export const publishOwnedJson = (file: string, value: unknown): Promise<void> => publishOwnedFile(file, JSON.stringify(value));
export const readOwnedJson = async (file: string): Promise<unknown> => {
  await assertOwnedDirectory(path.dirname(file));
  const original = await lstat(file);
  if (!original.isFile() || original.isSymbolicLink()) throw new Error("A Herdr tool mapping must be an original ordinary file.");
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const entry = await handle.stat();
    if (!entry.isFile() || entry.size > 256 * 1024 || process.platform !== "win32" && ((entry.mode & 0o077) !== 0 || entry.uid !== process.getuid?.())) throw new Error("A Herdr tool mapping requires a bounded owner-only ordinary file.");
    const buffer = Buffer.alloc(256 * 1024 + 1), { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 256 * 1024) throw new Error("The Herdr tool mapping exceeded its read bound.");
    return JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
  } finally { await handle.close(); }
};
export const optionalOwnedJson = async (file: string): Promise<unknown | null> => { try { return await readOwnedJson(file); } catch (cause) { if (missing(cause)) return null; throw cause; } };
const object = (value: unknown): Record<string, unknown> => { if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Invalid Herdr tool launch evidence."); return value as Record<string, unknown>; };
const absolute = (value: unknown): string => { if (typeof value !== "string" || !path.isAbsolute(value) || /[\0\r\n]/.test(value)) throw new TypeError("Herdr tool launch paths must be absolute data."); return value; };
export const parseToolManifest = (value: unknown): HerdrToolLaunchManifest => {
  const row = object(value);
  if (Object.keys(row).sort().join() !== ["schemaVersion", "owner", "nonce", "launch", "nativePath", "nodeExecutable", "childEntry", "platform"].sort().join() || row.schemaVersion !== 1 || typeof row.nonce !== "string" || canonicalId(row.nonce) !== row.nonce || !["darwin", "linux", "win32"].includes(String(row.platform)) || row.nativePath !== null && (typeof row.nativePath !== "string" || row.nativePath.includes("\0"))) throw new TypeError("Invalid Herdr tool launch manifest.");
  const owner = canonicalResourceOwner(object(row.owner) as HerdrExecutionOwner);
  if (JSON.stringify(owner) !== JSON.stringify(row.owner)) throw new TypeError("Herdr tool manifest owner must be canonical.");
  const launch = parseResolvedToolLaunch(row.launch, { context: "herdr" });
  if (launch.tool === "herdr") throw new TypeError("A pane tool mapping must select a native agent.");
  return { schemaVersion: 1, owner, nonce: row.nonce, launch, nativePath: row.nativePath as string | null, nodeExecutable: absolute(row.nodeExecutable), childEntry: absolute(row.childEntry), platform: row.platform as NodeJS.Platform };
};
export const readToolManifest = async (file: string): Promise<HerdrToolLaunchManifest> => {
  if (path.basename(file) !== "manifest.json") throw new Error("A Herdr tool mapping must reference its registered manifest.");
  return parseToolManifest(await readOwnedJson(absolute(file)));
};
export const parseToolReceipt = (value: unknown, manifest: HerdrToolLaunchManifest, withChild = true): HerdrToolLaunchReceipt => {
  const row = object(value), fields = ["schemaVersion", "owner", "nonce", "selectionKey", "logicalArgvDigest", "file", "prefixArgs", "helperPid", ...(withChild ? ["childPid"] : [])];
  const positive = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647;
  if (Object.keys(row).sort().join() !== fields.sort().join() || row.schemaVersion !== 1 || !sameResourceOwner(object(row.owner) as HerdrExecutionOwner, manifest.owner) || row.nonce !== manifest.nonce || row.selectionKey !== manifest.launch.selectionKey || row.file !== manifest.launch.command.file || JSON.stringify(row.prefixArgs) !== JSON.stringify(manifest.launch.command.prefixArgs) || typeof row.logicalArgvDigest !== "string" || !/^[a-f0-9]{64}$/.test(row.logicalArgvDigest) || !positive(row.helperPid) || withChild && (!positive(row.childPid) || row.childPid === row.helperPid)) throw new Error("The Herdr tool launch receipt does not match its original manifest.");
  return structuredClone(row) as HerdrToolLaunchReceipt;
};
