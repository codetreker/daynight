import type { CommandDefinition } from "../../cli/schema.js";

export const skillDefinition: CommandDefinition = {
  name: "skill",
  description: "Install the using-daynight CLI operation manual for coding agents",
  commands: [{
    name: "install",
    description: "Choose detected agents and install or replace their using-daynight skill",
    options: [{ names: ["-h", "--help"], description: "Show this help", action: "help" }],
    details: "Requires interactive terminal input and stderr. Choose agents, then User or Project scope.\nReplaces the complete using-daynight skill directory, including local edits and obsolete files. Removes the selected scope's legacy daynight skill after installation succeeds.",
  }],
  options: [{ names: ["-h", "--help"], description: "Show this help", action: "help" }],
};
