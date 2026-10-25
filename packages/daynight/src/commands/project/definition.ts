import type { CommandDefinition, CommandOption } from "../../cli/schema.js";

const helpOption: CommandOption = { names: ["-h", "--help"], description: "Show this help", action: "help" };
const jsonOption: CommandOption = { names: ["--json"], description: "Print the complete API resource data as JSON" };

export const projectDefinition: CommandDefinition = {
  name: "project",
  description: "Create and query projects on the configured server",
  commands: [
    {
      name: "create",
      description: "Create a project unless its repository is already registered",
      arguments: [{ name: "name", description: "Project name" }],
      allowOptionsTerminator: true,
      options: [
        { names: ["--repo"], description: "Repository address (defaults to the current Git origin)", value: { name: "repo", kind: "text" } },
        helpOption,
      ],
      details: "Without --repo, use the current Git worktree's effective origin fetch address.\nAn explicit --repo works outside Git and overrides the current repository.\nRead all server projects and return an existing project with an equivalent repository address.\nMultiple matching projects require choosing an existing project by its ID.\nOtherwise, submit the original name and repository address to the configured server.\nFor a name beginning with a dash, put options first and use -- before the name.",
    },
    {
      name: "list",
      description: "List all projects on the configured server",
      options: [jsonOption, helpOption],
      details: "Read every project page before printing the complete result.\n--json prints one array containing all projects.",
    },
    {
      name: "show",
      description: "Show a project by its ID",
      arguments: [{ name: "project-id", description: "Project UUID" }],
      options: [jsonOption, helpOption],
      details: "Read a project by its explicit ID, including outside a Git repository.\n--json prints the complete project object.",
    },
  ],
  options: [helpOption],
  details: "Server: https://daynight.cc (optional serverUrl override in ~/.daynight/config.yml)\nRun daynight project <command> --help for command usage.",
};
