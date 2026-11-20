import path from "node:path";

/** SQLite's Windows file API needs the extended prefix for deep Bot roots. */
export const sqliteFilename = (file: string): string => process.platform === "win32" && path.isAbsolute(file) ? path.toNamespacedPath(file) : file;

/** Keep stored identities, resource paths and diagnostics in their original form. */
export const sqliteDisplayFilename = (file: string): string => {
  if (process.platform !== "win32") return file;
  if (file.startsWith("\\\\?\\UNC\\")) return `\\\\${file.slice(8)}`;
  return file.startsWith("\\\\?\\") ? file.slice(4) : file;
};
