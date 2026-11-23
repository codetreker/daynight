import type { CommandDefinition, CommandOption } from "../../cli/schema.js";

const helpOption: CommandOption = { names: ["-h", "--help"], description: "Show this help", action: "help" };
const jsonOption: CommandOption = { names: ["--json"], description: "Print the complete API resource data as JSON" };

export const projectDefinition: CommandDefinition = {
  name: "project",
  description: "Manage projects on the configured server",
  commands: [
    {
      name: "set-repository",
      description: "Change a project's repository address",
      options: [
        { names: ["--project"], description: "Project UUID (defaults to the current repository)", value: { name: "project-id", kind: "text" } },
        { names: ["--repo"], description: "New repository address", value: { name: "repo", kind: "text" }, required: true },
        { names: ["--confirm"], description: "Confirm the preview without prompting" },
        { names: ["--allow-unverified-switch"], description: "Explicitly treat an unverified identity as a repository switch" },
        { names: ["--json"], description: "Print only the confirmed receipt as JSON" }, helpOption,
      ],
      details: "Preview the current and new addresses and their effects on stderr.\nA switch disconnects the GitHub App and removes existing Worker cloud selections; applying the change takes time and may stop existing executions.\nInteractive use asks for confirmation. Noninteractive use requires --confirm; an unverified identity also requires --allow-unverified-switch.\nA conflict requires a new preview and confirmation. An unknown write outcome must be checked without automatically repeating the write.\nThis command requires a server that supports project repository changes.",
    },
    {
      name: "create",
      description: "Create a project unless its repository is already registered in the target Team",
      arguments: [{ name: "name", description: "Project name" }],
      allowOptionsTerminator: true,
      options: [
        { names: ["--repo"], description: "Repository address (defaults to the current Git origin)", value: { name: "repo", kind: "text" } },
        { names: ["--team"], description: "Owner Team UUID or personal", value: { name: "team", kind: "text" } },
        { names: ["--confirm"], description: "Confirm creation without prompting" },
        helpOption,
      ],
      details: "Without --repo, use the current Git worktree's effective origin fetch address.\nAn explicit --repo works outside Git and overrides the current repository.\nResolve --team, the configured default, or Personal, then read all accessible projects.\nReturn an equivalent repository owned by that Team; multiple matches are an error.\nOnly a new project requires Team membership and creation confirmation.\nNew creation submits the original name and repository address to the configured server.\nFor a name beginning with a dash, put options first and use -- before the name.",
    },
    {
      name: "delete",
      description: "Delete a project while retaining its history",
      options: [
        { names: ["--project"], description: "Project UUID (defaults to the current repository)", value: { name: "project-id", kind: "text" } },
        { names: ["--confirm"], description: "Required: confirm permanent Goal dependency removal" },
        { names: ["--json"], description: "Print only the deletion receipt as JSON" }, helpOption,
      ],
      details: "Only an administrator of the current owner Team can delete a Project.\nThe Project becomes unavailable with no in-product recovery; its history and files remain on the server.\nDeletion permanently removes all Goal dependencies involving the Project, within and across Projects; they cannot be restored.\n--confirm is required. Interactive use also requires the exact JSON string literal of its name.\nThe preview is written to stderr.\nA lost or invalid receipt leaves the outcome unknown; a later 404 does not establish success.",
    },
    {
      name: "transfer",
      description: "Transfer a project to another Team",
      options: [
        { names: ["--to-team"], description: "Destination Team UUID or same-service Team link", value: { name: "team", kind: "text" }, required: true },
        { names: ["--project"], description: "Project UUID (defaults to the current repository)", value: { name: "project-id", kind: "text" } },
        { names: ["--if-version"], description: "Require the observed ownership version", value: { name: "version", kind: "text" } },
        { names: ["--confirm"], description: "Required: confirm permanent Goal dependency removal" },
        jsonOption, helpOption,
      ],
      details: "Only an administrator of the current owner Team can transfer a Project. The destination need not include you.\n--confirm is required. An actual transfer permanently removes all Goal dependencies involving the Project, within and across Projects; they cannot be restored.\nThe preview is written to stderr.\nA lost receipt leaves the outcome unknown; a later 404 does not establish success.\nThe transfer does not change Team defaults or repository bindings.",
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
  details: "Server: https://daynight.cc (optional serverUrl override in DN_CONFIG_DIR/config.yml (default: ~/.daynight/config.yml))\nRun daynight project <command> --help for command usage.",
};
