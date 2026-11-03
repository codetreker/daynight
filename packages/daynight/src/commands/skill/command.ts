import { withCliCancellation } from "../../cli/cancellation.js";
import type { CliContext } from "../../cli/context.js";
import { parseCommand, renderCommandHelp } from "../../cli/schema.js";
import { skillDefinition } from "./definition.js";
import type { SkillAgent, SkillAgentId } from "./agents.js";
import type { SkillBundle } from "./install.js";
import type { SkillScope, SkillTarget } from "./targets.js";

export type SkillCommandDependencies = {
  detectAgents: () => Promise<SkillAgent[]>;
  projectRoot: (cwd: string, signal: AbortSignal) => Promise<string>;
  captureBundle: (packageDirectory: string) => Promise<SkillBundle>;
  planTargets: (base: string, agents: readonly SkillAgent[]) => Promise<SkillTarget[]>;
  install: (targets: readonly SkillTarget[], bundle: SkillBundle, signal: AbortSignal, installed: (target: SkillTarget) => void) => Promise<void>;
};

const defaultDependencies: SkillCommandDependencies = {
  detectAgents: async () => (await import("./agents.js")).detectSkillAgents(),
  projectRoot: async (cwd, signal) => {
    const { createOperation } = await import("../../api/operation.js");
    const operation = createOperation({ signal, limits: { totalMs: 30_000 } });
    try { return await (await import("../../repository/git.js")).discoverWorktreeRoot(cwd, operation); }
    finally { operation.dispose(); }
  },
  captureBundle: async (packageDirectory) => (await import("./install.js")).captureInstalledSkill(packageDirectory),
  planTargets: async (...args) => (await import("./targets.js")).planSkillTargets(...args),
  install: async (...args) => (await import("./install.js")).installSkillTargets(...args),
};

export const runSkillCommand = async (
  args: readonly string[],
  context: CliContext,
  dependencies: SkillCommandDependencies = defaultDependencies,
  suppliedSignal?: AbortSignal,
): Promise<void> => {
  const command = parseCommand(skillDefinition, args, ["daynight", "skill"], "daynight skill --help");
  if (command.kind !== "run") { context.stdout(renderCommandHelp(command.command, command.path)); return; }
  await withCliCancellation(context, async (signal) => {
    const prompt = context.prompt;
    if (prompt?.isInteractive !== true) throw new Error("Skill installation requires terminal input and stderr. Run daynight skill install from an interactive terminal.");
    signal.throwIfAborted();
    const detected = await dependencies.detectAgents();
    signal.throwIfAborted();
    if (detected.length === 0) throw new Error("No supported agent launchers were detected on PATH (codex, copilot, claude). Install an agent and run daynight skill install again.");
    const selection = await prompt.selectMany<SkillAgentId>({
      message: "Install the using-daynight skill for which agents?",
      choices: detected.map(({ id, name }) => ({ name, value: id })),
      requiredMessage: "Select at least one agent.",
    }, signal);
    signal.throwIfAborted();
    const agents = detected.filter(({ id }) => selection.includes(id));
    if (agents.length === 0) throw new Error("Select at least one detected agent to install the using-daynight skill.");
    const scope = await prompt.select<SkillScope>({
      message: "Where should the skill be installed?",
      choices: [{ name: "User", value: "user" }, { name: "Project", value: "project" }],
      default: "user",
    }, signal);
    signal.throwIfAborted();
    const scopeName = scope === "user" ? "User" : "Project";
    const base = scope === "user" ? context.homeDirectory() : await dependencies.projectRoot(context.workingDirectory(), signal);
    const bundle = await dependencies.captureBundle(context.packageDirectory);
    const targets = await dependencies.planTargets(base, agents);
    signal.throwIfAborted();
    try {
      await dependencies.install(targets, bundle, signal, (target) => {
        for (const [index, agent] of target.agents.entries()) {
          context.stdout(`Installed ${agent.name}: ${scopeName} using-daynight skill at ${target.path} (package ${context.version}${index === 0 ? "" : "; shared installation"}).\n${agent.reload}\n`);
        }
      });
    } catch (cause) {
      const { SkillInstallationError } = await import("./install.js");
      if (cause instanceof SkillInstallationError) {
        if (cause.failed !== undefined) for (const agent of cause.failed.agents) context.stderr(cause.installedAtFailedTarget
          ? `Installed ${agent.name}: ${scopeName} using-daynight skill at ${cause.failed.path}; legacy daynight cleanup failed at ${cause.failed.legacyPath}.\n`
          : `Failed ${agent.name}: ${scopeName} using-daynight skill at ${cause.failed.path}.\n`);
        for (const target of cause.unattempted) for (const agent of target.agents) context.stderr(`Not attempted ${agent.name}: ${scopeName} using-daynight skill at ${target.path}.\n`);
      }
      throw cause;
    }
  }, suppliedSignal);
};
