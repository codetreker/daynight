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

// Scan each non-whitespace token once: backtracking address regexes can hold a
// live Git child past its stop deadline on long unbroken diagnostics.
const schemeCharacter = (char: string): boolean => /[a-z\d+.-]/i.test(char);
const wordCharacter = (char: string): boolean => /[a-z\d_]/i.test(char);
const redactUrl = (token: string): string => {
  let search = 0;
  for (;;) {
    const separator = token.indexOf("://", search);
    if (separator < 0 || separator + 3 === token.length) return token;
    let start = separator;
    while (start > 0 && schemeCharacter(token[start - 1]!)) start--;
    for (let index = start; index < separator; index++) {
      if (/[a-z]/i.test(token[index]!) && (index === 0 || !wordCharacter(token[index - 1]!))) {
        return `${token.slice(0, index)}[redacted URL]`;
      }
    }
    search = separator + 3;
  }
};
const redactAddress = (token: string): string => {
  let at = -1;
  for (let index = 0; index < token.length; index++) {
    if (token[index] === "@" && index > 0 && at < 0) at = index;
    if (token[index] === ":" && at > 0 && index > at + 1 && index + 1 < token.length) return "[redacted repository address]";
  }
  return token;
};

export const diagnostic = (value: string): string => value
  .replace(/[^\s"'<>]+/g, redactUrl)
  .replace(/[^\s"'<>]+/g, redactAddress)
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
