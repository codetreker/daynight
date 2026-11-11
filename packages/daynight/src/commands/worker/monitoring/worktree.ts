import path from "node:path";
import type { FailureWorktree } from "./types.js";

const invalidCharacters = /[\u0000-\u001f\u007f-\u009f\ud800-\udfff]/u;

/** Validate the wire representation without resolving it against a filesystem. */
export const validWorktreePath = (value: string): boolean => {
  if (!value || Buffer.byteLength(value, "utf8") > 4096 || invalidCharacters.test(value) || value.includes("\\") || value.startsWith("/") || /^[a-zA-Z]:/.test(value)) return false;
  if (value === ".") return true;
  const parts = value.split("/");
  let normal = false;
  for (const part of parts) {
    if (!part || part === "." || part === ".." && normal) return false;
    if (part !== "..") normal = true;
  }
  return true;
};

/** Encode an explicitly bound checkout and worktree without probing the filesystem. */
export const encodeWorktree = (projectRoot: string, worktreePath: string, flavor: typeof path.posix = path): FailureWorktree => {
  const unavailable = (reason: "different-volume" | "invalid-path" | "limit-exceeded"): FailureWorktree => ({ kind: "unavailable", reason });
  try {
    if (typeof projectRoot !== "string" || typeof worktreePath !== "string" || invalidCharacters.test(projectRoot) || invalidCharacters.test(worktreePath)) return unavailable("invalid-path");
    const windows = flavor === path.win32;
    const absolute = (value: string): boolean => windows ? /^(?:[a-zA-Z]:[\\/]|[\\/]{2}[^\\/]+[\\/]+[^\\/]+(?:[\\/]|$))/.test(value) : flavor.isAbsolute(value);
    if (!absolute(projectRoot) || !absolute(worktreePath)) return unavailable("invalid-path");
    if (windows && flavor.parse(flavor.resolve(projectRoot)).root.toLowerCase() !== flavor.parse(flavor.resolve(worktreePath)).root.toLowerCase()) return unavailable("different-volume");
    const relative = flavor.relative(projectRoot, worktreePath);
    if (windows && flavor.isAbsolute(relative)) return unavailable("different-volume");
    const normalized = (windows ? relative.replaceAll("\\", "/") : relative) || ".";
    if (Buffer.byteLength(normalized, "utf8") > 4096) return unavailable("limit-exceeded");
    return validWorktreePath(normalized) ? { kind: "project-relative", path: normalized } : unavailable("invalid-path");
  } catch {
    return unavailable("invalid-path");
  }
};
