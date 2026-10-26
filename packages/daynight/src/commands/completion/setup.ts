import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat, mkdir, open, readFile, realpath, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { setTimeout } from "node:timers/promises";
import { UsageError } from "../../cli/context.js";
import type { CliContext } from "../../cli/context.js";

export type CompletionShell = "bash" | "zsh";
type SetupOptions = { shell: CompletionShell | undefined; rcFile: string | undefined };
type SetupResult = { shell: CompletionShell; files: { path: string; installed: boolean }[] };
export type SetupDependencies = {
  environment: NodeJS.ProcessEnv;
  callingShell: () => Promise<CompletionShell | undefined>;
};

const execute = promisify(execFile);
const begin = "# >>> daynight completion >>>";
const end = "# <<< daynight completion <<<";
const isMissing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === "ENOENT";

export const detectCallingShell = async (): Promise<CompletionShell | undefined> => {
  if (process.platform === "win32") return undefined;
  const { stdout } = await execute("ps", ["-p", String(process.ppid), "-o", "comm="], { timeout: 3_000, encoding: "utf8" });
  const name = path.basename(stdout.trim()).replace(/^-/, "");
  return name === "bash" || name === "zsh" ? name : undefined;
};

const loadScript = (shell: CompletionShell, indent: string): string[] => [
  `if __daynight_completion_script="$(daynight completion ${shell})"; then`,
  '  if eval "$__daynight_completion_script"; then',
  '    unset __daynight_completion_script',
  '  else',
  '    __daynight_completion_status=$?',
  '    unset __daynight_completion_script',
  '    return "$__daynight_completion_status"',
  '  fi',
  'else',
  '  __daynight_completion_status=$?',
  '  unset __daynight_completion_script',
  '  return "$__daynight_completion_status"',
  'fi',
].map((line) => `${indent}${line}`);

export const renderSetupBlock = (shell: CompletionShell): string => {
  const lines = shell === "bash" ? [
    begin,
    'if [ -n "${BASH_VERSION-}" ]; then',
    '  case $- in',
    '    *i*)',
    '      if ! declare -F _daynight_completion >/dev/null ||',
    '        [ "$(complete -p daynight 2>/dev/null)" != \'complete -F _daynight_completion daynight\' ] ||',
    '        [ "$(complete -p dn 2>/dev/null)" != \'complete -F _daynight_completion dn\' ]; then',
    ...loadScript(shell, "        "),
    '      fi',
    '      ;;',
    '  esac',
    'fi',
    end,
  ] : [
    begin,
    'if [[ -o interactive ]]; then',
    '  if (( $+functions[compdef] )) || { autoload -Uz compinit && compinit; }; then',
    '    if [[ "${_comps[daynight]-}" != _daynight || "${_comps[dn]-}" != _daynight ]] || (( ! $+functions[_daynight] )); then',
    ...loadScript(shell, "      "),
    '    fi',
    '  else',
    '    return $?',
    '  fi',
    'fi',
    end,
  ];
  return `${lines.join("\n")}\n`;
};

const configured = (content: Buffer, shell: CompletionShell, file: string): boolean => {
  const lines = content.toString("utf8").split(/\r?\n/);
  const starts = lines.flatMap((line, index) => line.includes(begin) ? [index] : []);
  const ends = lines.flatMap((line, index) => line.includes(end) ? [index] : []);
  if (starts.length !== 0 || ends.length !== 0) {
    if (starts.length !== 1 || ends.length !== 1 || starts[0]! >= ends[0]!) {
      throw new Error(`Malformed or duplicate daynight completion block in ${file}. Remove or repair its markers before running setup.`);
    }
    const block = lines.slice(starts[0], ends[0]! + 1).join("\n");
    if (block !== renderSetupBlock(shell).trimEnd()) throw new Error(`Unrecognized daynight completion block in ${file}. Remove or repair it before running setup.`);
    return true;
  }
  return lines.some((line) => line.trim() === `source <(daynight completion ${shell})`);
};

const targetPath = async (file: string): Promise<string> => {
  try {
    const info = await lstat(file);
    if (info.isSymbolicLink()) {
      const resolved = await realpath(file);
      if (!(await lstat(resolved)).isFile()) throw new Error(`Completion startup target is not a regular file: ${file}`);
      return resolved;
    }
    if (!info.isFile()) throw new Error(`Completion startup target is not a regular file: ${file}`);
    return file;
  } catch (error) {
    if (isMissing(error)) {
      // A dangling link is not a new startup file: creating through it hides a broken configuration.
      try { await lstat(file); } catch (missing) { if (isMissing(missing)) return file; throw missing; }
    }
    throw error;
  }
};

const acquireLock = async (file: string): Promise<FileHandle> => {
  for (let attempt = 0; ; attempt += 1) {
    try { return await open(file, "wx", 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || attempt === 40) {
        throw new Error(`Cannot lock completion startup file. Another setup may be running; inspect ${file}.`, { cause: error });
      }
      await setTimeout(50);
    }
  }
};

const install = async (file: string, shell: CompletionShell): Promise<boolean> => {
  const resolved = await targetPath(file);
  try { if (configured(await readFile(resolved), shell, file)) return false; }
  catch (error) { if (!isMissing(error)) throw error; }
  await mkdir(path.dirname(resolved), { recursive: true });
  const lockPath = `${resolved}.daynight-completion.lock`;
  const lock = await acquireLock(lockPath);
  try {
    if (await targetPath(file) !== resolved) throw new Error(`Completion startup target changed during setup: ${file}`);
    // Append keeps existing bytes, mode and symlink identity, including concurrent unrelated appends.
    const handle = await open(resolved, constants.O_RDWR | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o666);
    try {
      const before = await handle.stat();
      if (!before.isFile()) throw new Error(`Completion startup target is not a regular file: ${file}`);
      const content = await handle.readFile();
      if (configured(content, shell, file)) return false;
      const current = await lstat(resolved);
      if (await targetPath(file) !== resolved || current.dev !== before.dev || current.ino !== before.ino || current.size !== before.size || current.mtimeMs !== before.mtimeMs) {
        throw new Error(`Completion startup file changed during setup; run setup again: ${file}`);
      }
      const separator = content.length === 0 || content.at(-1) === 10 ? "" : "\n";
      await handle.writeFile(`${separator}${renderSetupBlock(shell)}`);
      await handle.sync();
      return true;
    } finally { await handle.close(); }
  } catch (error) {
    throw new Error(`Cannot configure completion in ${file}.`, { cause: error });
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
};

const bashTargets = async (home: string): Promise<string[]> => {
  let unreadable: unknown;
  for (const name of [".bash_profile", ".bash_login", ".profile"]) {
    const file = path.join(home, name);
    try { await lstat(file); }
    catch (error) { if (isMissing(error)) continue; throw error; }
    try {
      await access(file, constants.R_OK);
      return [path.join(home, ".bashrc"), file];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EACCES") throw error;
      unreadable = error;
    }
  }
  if (unreadable !== undefined) throw new Error("No existing Bash login profile is readable. Make a profile readable before running setup.", { cause: unreadable });
  return [path.join(home, ".bashrc"), path.join(home, ".bash_profile")];
};

export const setupCompletion = async (
  options: SetupOptions,
  context: Pick<CliContext, "homeDirectory" | "workingDirectory">,
  dependencies: SetupDependencies = { environment: process.env, callingShell: detectCallingShell },
): Promise<SetupResult> => {
  let shell = options.shell;
  if (shell === undefined) {
    try { shell = await dependencies.callingShell(); }
    catch (error) { throw new Error("Cannot detect the calling shell. Specify --shell bash or --shell zsh.", { cause: error }); }
  }
  if (shell === undefined) throw new UsageError("Cannot identify the calling Bash or zsh shell. Specify --shell bash or --shell zsh.", "daynight completion setup --help");
  const targets = options.rcFile !== undefined ? [path.resolve(context.workingDirectory(), options.rcFile)] : shell === "bash"
    ? await bashTargets(context.homeDirectory())
    : [path.resolve(context.workingDirectory(), `${dependencies.environment.ZDOTDIR === undefined ? context.homeDirectory() : dependencies.environment.ZDOTDIR}/.zshrc`)];
  const files: SetupResult["files"] = [];
  for (const file of targets) files.push({ path: file, installed: await install(file, shell) });
  return { shell, files };
};
