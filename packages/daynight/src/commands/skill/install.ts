import { mkdir, mkdtemp, rename, rm, rmdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { captureSkillBundle, validateSkillEntrypoint } from "../../platform/skill-bundle.js";
import type { BundleEntry } from "../../platform/skill-bundle.js";
import type { SkillTarget } from "./targets.js";

export type SkillBundle = readonly BundleEntry[];
export type SkillInstallFilesystem = Pick<typeof import("node:fs/promises"), "mkdir" | "mkdtemp" | "rename" | "rm" | "rmdir" | "writeFile">;
const filesystem: SkillInstallFilesystem = { mkdir, mkdtemp, rename, rm, rmdir, writeFile };
const hasCode = (cause: unknown, code: string): boolean => cause instanceof Error && "code" in cause && cause.code === code;

export const captureInstalledSkill = async (packageDirectory: string): Promise<SkillBundle> => {
  const source = path.join(packageDirectory, "dist", "commands", "skill", "skills", "using-daynight");
  try {
    const bundle = await captureSkillBundle(source, "using-daynight skill");
    validateSkillEntrypoint(bundle, "using-daynight", "using-daynight skill");
    return bundle;
  } catch (cause) { throw new Error(`Cannot capture installed using-daynight skill bundle ${source}. Reinstall the npm package and try again.`, { cause }); }
};

export class SkillInstallationError extends Error {
  constructor(
    readonly completed: readonly SkillTarget[],
    readonly failed: SkillTarget | undefined,
    readonly unattempted: readonly SkillTarget[],
    message: string,
    options: ErrorOptions,
    readonly installedAtFailedTarget = false,
  ) {
    super(message, options);
    this.name = "SkillInstallationError";
  }
}

const replaceTarget = async (
  target: SkillTarget,
  bundle: SkillBundle,
  signal: AbortSignal,
  fs: SkillInstallFilesystem,
): Promise<void> => {
  const created: string[] = [];
  let stage: string | undefined;
  let phase = "create parent directories";
  let removed = false;
  let failure: unknown;
  try {
    signal.throwIfAborted();
    let cursor = target.ancestor;
    for (const component of target.missingParents) {
      cursor = path.join(cursor, component);
      try { await fs.mkdir(cursor); created.push(cursor); }
      catch (cause) { if (!hasCode(cause, "EEXIST")) throw cause; }
      signal.throwIfAborted();
    }
    phase = "stage bundle";
    stage = await fs.mkdtemp(path.join(target.parent, ".daynight-install-"));
    for (const entry of bundle) {
      signal.throwIfAborted();
      const destination = path.join(stage, ...entry.relativePath.split("/"));
      if (entry.type === "directory") await fs.mkdir(destination);
      else await fs.writeFile(destination, entry.contents, { flag: "wx" });
    }
    signal.throwIfAborted();
    phase = "remove existing skill";
    // Cancellation is observed after publishing, so removal cannot interrupt replacement.
    await fs.rm(target.path, { recursive: true, force: true });
    removed = true;
    phase = "publish staged bundle";
    await fs.rename(stage, target.path);
    stage = undefined;
    return;
  } catch (cause) {
    failure = new Error(`Cannot ${phase} at ${target.path}.${removed ? " The previous skill was removed; the target may now be absent. Run daynight skill install again to restore it." : ""}`, { cause });
  } finally {
    const cleanup: unknown[] = [];
    if (stage !== undefined) {
      try { await fs.rm(stage, { recursive: true, force: true }); }
      catch (cause) { cleanup.push(new Error(`Cannot remove skill installation stage ${stage}.`, { cause })); }
    }
    if (failure !== undefined) for (const directory of created.toReversed()) {
      try { await fs.rmdir(directory); }
      catch (cause) {
        if (!hasCode(cause, "ENOTEMPTY") && !hasCode(cause, "EEXIST") && !hasCode(cause, "ENOENT")) cleanup.push(new Error(`Cannot remove newly created skill parent ${directory}.`, { cause }));
      }
    }
    if (cleanup.length !== 0) throw new AggregateError(cleanup, "Skill installation cleanup failed.", { cause: failure });
  }
  throw failure;
};

export const installSkillTargets = async (
  targets: readonly SkillTarget[],
  bundle: SkillBundle,
  signal: AbortSignal,
  installed: (target: SkillTarget) => void,
  fs: SkillInstallFilesystem = filesystem,
): Promise<void> => {
  const completed: SkillTarget[] = [];
  for (const [index, target] of targets.entries()) {
    try { signal.throwIfAborted(); }
    catch (cause) { throw new SkillInstallationError(completed, undefined, targets.slice(index), "Skill installation cancelled before the next target.", { cause }); }
    try { await replaceTarget(target, bundle, signal, fs); }
    catch (cause) { throw new SkillInstallationError(completed, target, targets.slice(index + 1), "Skill installation stopped at the failed target; completed targets are preserved.", { cause }); }
    try { await fs.rm(target.legacyPath, { recursive: true, force: true }); }
    catch (cause) {
      throw new SkillInstallationError(completed, target, targets.slice(index + 1), `The using-daynight skill is installed at ${target.path}, but legacy daynight cleanup failed at ${target.legacyPath}. Run daynight skill install again to finish cleanup; completed targets are preserved.`, { cause }, true);
    }
    completed.push(target);
    installed(target);
  }
  signal.throwIfAborted();
};
