import { assistantTaskDefinition } from "../commands/assistant-task/definition.js";
import { botDefinition } from "../commands/bot/definition.js";
import { controllerDefinition } from "../commands/controller/definition.js";
import type { CliCommand } from "./context.js";
import type { CommandDefinition } from "./schema.js";
import { completionDefinition } from "../commands/completion/definition.js";
import { reviewDefinition } from "../commands/review/definition.js";
import { workerDefinition } from "../commands/worker/definition.js";
import { projectDefinition } from "../commands/project/definition.js";
import { taskDefinition } from "../commands/task/definition.js";
import { invitationDefinition } from "../commands/invitation/definition.js";
import { teamDefinition } from "../commands/team/definition.js";
import { webhookDefinition } from "../commands/webhook/definition.js";
import { updateDefinition } from "../commands/update/definition.js";
import { skillDefinition } from "../commands/skill/definition.js";
import { loginDefinition, logoutDefinition } from "../commands/auth/definition.js";

export type CommandRegistration = CommandDefinition & {
  load: () => Promise<CliCommand>;
};

export const commands: readonly CommandRegistration[] = [
  { ...assistantTaskDefinition, load: async () => ({ run: (await import("../commands/assistant-task/command.js")).runAssistantTaskCommand }) },
  { ...botDefinition, load: async () => ({ run: (await import("../commands/bot/commands.js")).runBotCommand }) },
  { ...controllerDefinition, load: async () => ({ run: (await import("../commands/controller/index.js")).runControllerCommand }) },
  { ...workerDefinition, load: async () => ({ run: (await import("../commands/worker/index.js")).runWorkerCommand }) },
  { ...loginDefinition, load: async () => ({ run: (await import("../commands/auth/command.js")).runLoginCommand }) },
  { ...logoutDefinition, load: async () => ({ run: (await import("../commands/auth/command.js")).runLogoutCommand }) },
  { ...skillDefinition, load: async () => ({ run: (await import("../commands/skill/command.js")).runSkillCommand }) },
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
  { ...invitationDefinition, load: async () => ({ run: (await import("../commands/invitation/command.js")).runInvitationCommand }) },
  { ...teamDefinition, load: async () => ({ run: (await import("../commands/team/command.js")).runTeamCommand }) },
  { ...webhookDefinition, load: async () => ({ run: (await import("../commands/webhook/command.js")).runWebhookCommand }) },
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
    { names: ["--skill"], description: "Print the bundled CLI usage manual for coding agents", action: "skill" },
    { names: ["-h", "--help"], description: "Show this help", action: "help" },
    { names: ["-v", "--version"], description: "Show the installed version", action: "version" },
  ],
  details: "Run daynight <command> --help for command usage.",
};
