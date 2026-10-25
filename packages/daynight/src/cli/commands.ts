import type { CliCommand } from "./context.js";
import type { CommandDefinition } from "./schema.js";
import { completionDefinition } from "../commands/completion/definition.js";
import { reviewDefinition } from "../commands/review/definition.js";
import { projectDefinition } from "../commands/project/definition.js";
import { taskDefinition } from "../commands/task/definition.js";
import { updateDefinition } from "../commands/update/definition.js";
import { skillDefinition } from "../commands/skill/definition.js";
import { loginDefinition, logoutDefinition } from "../commands/auth/definition.js";
import { setupDefinition } from "../commands/setup/definition.js";

export type CommandRegistration = CommandDefinition & {
  load: () => Promise<CliCommand>;
};

export const commands: readonly CommandRegistration[] = [
  { ...loginDefinition, load: async () => ({ run: (await import("../commands/auth/command.js")).runLoginCommand }) },
  { ...logoutDefinition, load: async () => ({ run: (await import("../commands/auth/command.js")).runLogoutCommand }) },
  { ...skillDefinition, load: async () => ({ run: (await import("../commands/skill/command.js")).runSkillCommand }) },
  { ...setupDefinition, load: async () => ({ run: (await import("../commands/setup/command.js")).runSetupCommand }) },
  {
    ...reviewDefinition,
    load: async () => ({ run: (await import("../commands/review/command.js")).runReviewCommand }),
  },
  {
    ...updateDefinition,
    load: async () => ({ run: (await import("../commands/update/command.js")).runUpdateCommand }),
  },
  {
    ...completionDefinition,
    load: async () => ({ run: (await import("../commands/completion/command.js")).runCompletionCommand }),
  },
  {
    ...projectDefinition,
    load: async () => ({ run: (await import("../commands/project/command.js")).runProjectCommand }),
  },
  {
    ...taskDefinition,
    load: async () => ({ run: (await import("../commands/task/command.js")).runTaskCommand }),
  },
];

export const commandTree: CommandDefinition = {
  name: "daynight",
  aliases: ["dn"],
  description: "A client command toolkit for development workflows",
  commands: commands.map(({ load, ...definition }) => definition),
  options: [
    { names: ["-h", "--help"], description: "Show this help", action: "help" },
    { names: ["-v", "--version"], description: "Show the installed version", action: "version" },
  ],
  details: "Run daynight <command> --help for command usage.",
};
