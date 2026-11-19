import { createHash } from "node:crypto";
import { lstat, mkdir } from "node:fs/promises";
import path from "node:path";
import { resolveConfigurationPaths } from "../../config/paths.js";

/** Storage placement is independent of CLI authentication and native provider homes. */
export const resolveControllerStateDirectory = (home: string, storageStateDirectory?: string): string => {
  if (storageStateDirectory === undefined) return resolveConfigurationPaths(home).stateDirectory;
  if (!path.isAbsolute(storageStateDirectory) || path.resolve(storageStateDirectory) !== storageStateDirectory || /[\0\r\n]/.test(storageStateDirectory)) throw new Error("Controller storage root must be a normalized absolute directory.");
  return storageStateDirectory;
};

export const resolveControllerIpcEndpoint = (home: string, launchId: string, platform: NodeJS.Platform = process.platform, storageStateDirectory?: string): string => {
  const stateDirectory = resolveControllerStateDirectory(home, storageStateDirectory);
  // Preserve existing default identities, while custom roots own separate pipes.
  const identity = storageStateDirectory === undefined && process.env.DN_CONFIG_DIR === undefined ? home : stateDirectory;
  const key = createHash("sha256").update(`${identity}:${launchId}`).digest("hex").slice(0, 20);
  if (platform === "win32") return `\\\\.\\pipe\\daynight-${key}`;
  const endpoint = path.join(stateDirectory, "c", `${key}.sock`);
  const maximum = platform === "darwin" ? 103 : 107;
  if (Buffer.byteLength(endpoint) <= maximum) return endpoint;
  // Unix socket addresses have a small byte limit independent of filesystem
  // path limits. Only this authenticated, ephemeral endpoint uses a short root;
  // tickets, credentials and recovery evidence remain in the configured root.
  const rootKey = createHash("sha256").update(stateDirectory).digest("hex").slice(0, 24);
  return `/tmp/daynight-${process.getuid!()}-${rootKey}/${key}.sock`;
};

export const prepareControllerIpcEndpoint = async (home: string, launchId: string, storageStateDirectory?: string): Promise<string> => {
  const endpoint = resolveControllerIpcEndpoint(home, launchId, process.platform, storageStateDirectory);
  if (process.platform === "win32") return endpoint;
  const directory = path.dirname(endpoint);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== process.getuid!() || (metadata.mode & 0o077) !== 0) {
    throw new Error("Controller IPC requires a private owned directory without symlinks.");
  }
  return endpoint;
};
