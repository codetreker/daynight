import type { CommandDefinition, CommandOption } from "../../cli/schema.js";

const help: CommandOption = { names: ["-h", "--help"], description: "Show this help", action: "help" };

export const workerDefinition: CommandDefinition = {
  name: "worker",
  description: "Run automatically claimed tasks in dedicated worktrees and Herdr",
  commands: [{
    name: "run",
    description: "Run the foreground task worker until interrupted",
    options: [help],
    details: "Read worker settings from ~/.daynight/config.yml at startup.\nState: ~/.daynight/worker/ (fixed to the current user's home directory).\nCtrl+C stops the original agents while preserving unfinished claims, worktrees and native history.",
  }],
  options: [help],
  details: "Run daynight worker run --help for command usage.",
};
