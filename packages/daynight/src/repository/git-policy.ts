import type { Operation } from "../api/operation.js";

export const maxOutputBytes = 1_048_576;
export const maxGitMs = 30_000;
export const cleanupMs = 1_000;
const repositorySelectors = new Set([
  "GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_GRAFT_FILE", "GIT_NAMESPACE", "GIT_PREFIX",
  "GIT_SUPER_PREFIX", "GIT_INTERNAL_SUPER_PREFIX", "GIT_CEILING_DIRECTORIES",
  "GIT_DISCOVERY_ACROSS_FILESYSTEM", "GIT_SHALLOW_FILE", "GIT_REPLACE_REF_BASE",
  "GIT_IMPLICIT_WORK_TREE", "GIT_QUARANTINE_PATH",
]);

export const gitEnvironment = (overrides: Readonly<Record<string, string | undefined>> = {}): NodeJS.ProcessEnv => ({
  ...Object.fromEntries(Object.entries({ ...process.env, ...overrides }).filter(([name, value]) => {
    const key = name.toUpperCase();
    return value !== undefined && !repositorySelectors.has(key) && !key.startsWith("GIT_TRACE");
  })),
  GIT_OPTIONAL_LOCKS: "0",
  GIT_TERMINAL_PROMPT: "0",
});

export const diagnostic = (value: string): string => value
  .replace(/\b[a-z][a-z\d+.-]*:\/\/[^\s"'<>]+/gi, "[redacted URL]")
  .replace(/[^\s"'<>]+@[^\s"'<>]+:[^\s"'<>]+/g, "[redacted repository address]")
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
  .slice(0, 8192);

export type RepositoryGitResult = {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
};

export class RepositoryGitError extends Error {
  constructor(
    message: string,
    readonly exitCode: number | null,
    readonly signal: NodeJS.Signals | null,
    readonly stderr: string,
    options?: ErrorOptions,
  ) {
    super(`${message}${exitCode === null ? "" : ` (exit ${exitCode})`}${signal === null ? "" : ` (${signal})`}${stderr === "" ? "" : `: ${stderr}`}`, options);
    this.name = "RepositoryGitError";
  }
}

export type RepositoryGitOptions = {
  readonly allowExitOne?: boolean;
  /** Inherited groups require an outer supervisor to terminate descendants after this operation exits. */
  readonly processGroup?: "own" | "inherit";
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly timeoutMs?: number;
};

export const gitArgs = (args: readonly string[]): string[] => ["--no-pager", "-c", "core.fsmonitor=false", ...args];

export const gitTimeout = (operation: Operation, commandMs = maxGitMs): number => {
  operation.check();
  if (!Number.isSafeInteger(commandMs) || commandMs <= 0 || commandMs > 2_147_483_647) throw new RangeError("Git command timeout must be a positive supported integer.");
  return Math.max(1, Math.ceil(Math.min(commandMs, operation.remainingMs())));
};
