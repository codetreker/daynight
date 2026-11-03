import { lstat } from "node:fs/promises";
import path from "node:path";
import { createOperation } from "../../api/operation.js";
import type { CliContext } from "../../cli/context.js";
import { discoverWorktreeRoot } from "../../repository/git.js";
import type { RepositoryGitOptions } from "../../repository/git.js";
import { skillAgents } from "./agents.js";
import { captureInstalledSkill, installSkillTargets, SkillInstallationError } from "./install.js";
import { mergeSkillTargets, planSkillTargets } from "./targets.js";
import type { SkillScope, SkillTarget } from "./targets.js";

const isMissing = (cause: unknown): boolean => cause instanceof Error && "code" in cause && cause.code === "ENOENT";

export const findSkillProjectRoot = async (cwd: string, signal: AbortSignal, gitOptions: Pick<RepositoryGitOptions, "processGroup"> = {}): Promise<string | undefined> => {
  let directory = path.resolve(cwd);
  while (true) {
    signal.throwIfAborted();
    let marker = false;
    try { await lstat(path.join(directory, ".git")); marker = true; }
    catch (cause) { if (!isMissing(cause)) throw cause; }
    if (marker) {
      const operation = createOperation({ signal, limits: { totalMs: 30_000 } });
      try { return await discoverWorktreeRoot(cwd, operation, gitOptions); }
      finally { operation.dispose(); }
    }
    const parent = path.dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
};

type ScopedTarget = { target: SkillTarget; scope: SkillScope };
const scopeName = (scope: SkillScope): string => scope === "user" ? "User" : "Project";
const comparisonPath = (value: string): string => process.platform === "win32" ? value.toLowerCase() : value;

export const refreshInstalledSkills = async (context: CliContext, signal: AbortSignal, gitOptions: Pick<RepositoryGitOptions, "processGroup"> = {}): Promise<void> => {
  signal.throwIfAborted();
  const bases: { base: string; scope: SkillScope }[] = [{ base: context.homeDirectory(), scope: "user" }];
  const projectRoot = await findSkillProjectRoot(context.workingDirectory(), signal, gitOptions);
  if (projectRoot !== undefined) bases.push({ base: projectRoot, scope: "project" });
  const existing: ScopedTarget[] = [];
  for (const { base, scope } of bases) {
    for (const agent of skillAgents) {
      const target = (await planSkillTargets(base, [agent]))[0]!;
      signal.throwIfAborted();
      let entry;
      try { entry = await lstat(target.path); }
      catch (cause) { if (isMissing(cause)) continue; throw cause; }
      if (!entry.isDirectory() && !entry.isSymbolicLink()) throw new Error(`Cannot refresh using-daynight skill at ${target.path}: the installed target must be a directory or symbolic link.`);
      existing.push({ target, scope });
    }
  }
  const targets = mergeSkillTargets(existing.map(({ target }) => target));
  if (targets.length === 0) return;
  const bundle = await captureInstalledSkill(context.packageDirectory);
  const report = (target: SkillTarget, status: string, output: (text: string) => void, detail = ""): void => {
    for (const entry of existing.filter((entry) => comparisonPath(entry.target.path) === comparisonPath(target.path))) {
      for (const agent of entry.target.agents) output(`${status} ${agent.name}: ${scopeName(entry.scope)} using-daynight skill at ${target.path} (package ${context.version}).${detail}\n${status === "Updated" ? `${agent.reload}\n` : ""}`);
    }
  };
  try {
    await installSkillTargets(targets, bundle, signal, (target) => report(target, "Updated", context.stdout));
  } catch (cause) {
    if (cause instanceof SkillInstallationError) {
      if (cause.failed !== undefined) report(cause.failed, cause.installedAtFailedTarget ? "Updated" : "Failed", context.stderr,
        cause.installedAtFailedTarget ? ` Legacy daynight cleanup failed at ${cause.failed.legacyPath}.` : "");
      for (const target of cause.unattempted) report(target, "Not attempted", context.stderr);
    }
    throw cause;
  }
};
