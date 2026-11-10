import path from "node:path";
import type { PathApi } from "./filesystem.js";

export type Tool = "codex" | "copilot" | "herdr";
export type ToolContext = "web" | "herdr";
export type ToolPathChoice = { readonly kind: "auto" } | { readonly kind: "path"; readonly path: string };
export type ToolPaths = Readonly<Record<Tool, ToolPathChoice>>;

/** Validate path syntax without expansion, normalization or filesystem access. */
export const validateToolPath = (value: unknown, field = "tool path", pathApi: PathApi = path): string => {
  if (typeof value !== "string" || value.trim() === "" || !value.isWellFormed() || /\p{Cc}/u.test(value)) {
    throw new TypeError(`${field} must be a nonempty path without control characters or invalid Unicode.`);
  }
  if (Buffer.byteLength(value, "utf8") > 4096) throw new TypeError(`${field} must be at most 4096 UTF-8 bytes.`);
  const fullyQualified = pathApi.sep !== "\\" || /^[a-z]:[\\/]/i.test(value) || /^[\\/]{2}[^\\/]+[\\/][^\\/]+(?:[\\/]|$)/.test(value);
  if (!pathApi.isAbsolute(value) || !fullyQualified) throw new TypeError(`${field} must be an absolute file path for this platform; environment and tilde expansion are not supported.`);
  return value;
};

/** Project local YAML choices; omission and per-tool null select auto. */
export const parseLocalToolPaths = (value: unknown, pathApi: PathApi = path): ToolPaths => {
  if (value !== undefined && (typeof value !== "object" || value === null || Array.isArray(value))) {
    throw new TypeError("worker.toolPaths must be a mapping containing only codex, copilot and herdr.");
  }
  const mapping = (value ?? {}) as Record<string, unknown>;
  if (Object.keys(mapping).some(key => key !== "codex" && key !== "copilot" && key !== "herdr")) {
    throw new TypeError("worker.toolPaths must contain only codex, copilot and herdr.");
  }
  const choice = (tool: Tool): ToolPathChoice => {
    const configured = Object.hasOwn(mapping, tool) ? mapping[tool] : undefined;
    return configured === undefined || configured === null
      ? { kind: "auto" }
      : { kind: "path", path: validateToolPath(configured, `worker.toolPaths.${tool}`, pathApi) };
  };
  return { codex: choice("codex"), copilot: choice("copilot"), herdr: choice("herdr") };
};
