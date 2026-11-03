import type { CommandDefinition, CommandOption } from "../../cli/schema.js";

const helpOption: CommandOption = { names: ["-h", "--help"], description: "Show this help", action: "help" };

export const reviewDefinition: CommandDefinition = {
  name: "review",
  description: "Review GitHub pull requests and manage local review configuration",
  commands: [
    {
      name: "run",
      description: "Run foreground PR review until interrupted",
      options: [helpOption],
      details: "Run foreground PR review using DN_CONFIG_DIR/config.yml (default: ~/.daynight/config.yml) until interrupted.",
    },
    {
      name: "list",
      aliases: ["ls"],
      description: "List tracked ongoing PRs and recorded review status",
      options: [helpOption],
      details: "Print a local persisted snapshot of configured repositories and tracked open PRs.\nIncludes Draft PRs, saved review status, attempts, retry deadlines and errors.\nLast observed identifies the latest successful repository observation.\nRunning is a recorded review state and does not establish process liveness.",
    },
    {
      name: "add-repo",
      description: "Add a repository to configuration for the next review startup",
      arguments: [{ name: "remote", description: "HTTPS or SSH GitHub repository address" }],
      options: [
        { names: ["--path"], description: "Dedicated review clone path (relative to the current directory)", value: { name: "path", kind: "directory" } },
        helpOption,
      ],
      details: "Without --path, review.repositoryRoot (default: ~/daynights) determines the clone path.\nThe resolved absolute path is saved in DN_CONFIG_DIR/config.yml (default: ~/.daynight/config.yml).\nChanges take effect the next time daynight review run starts.",
    },
  ],
  options: [helpOption],
  details: "Configuration: DN_CONFIG_DIR/config.yml (default: ~/.daynight/config.yml)\nRuntime state: DN_CONFIG_DIR (default: ~/.daynight/)\nRun daynight review <command> --help for command usage.",
};
