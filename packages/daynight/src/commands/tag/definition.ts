import type { CommandDefinition, CommandOption } from "../../cli/schema.js";

const help: CommandOption = { names: ["-h", "--help"], description: "Show this help", action: "help" };
const json: CommandOption = { names: ["--json"], description: "Print the complete API result as JSON" };
const project: CommandOption = { names: ["--project"], description: "Project UUID (defaults to the current repository)", value: { name: "project-id", kind: "text" } };
const version: CommandOption = { names: ["--if-version"], description: "Submit this exact Tag version", value: { name: "version", kind: "text" } };
const tagId = { name: "tag-id", description: "Tag UUID" };
const name = { name: "name", description: "Tag name" };

export const tagDefinition: CommandDefinition = {
  name: "tag", description: "Manage a project's Tag catalog",
  commands: [
    { name: "list", description: "List Tags in a project", options: [
      { names: ["--query"], description: "Filter by name", value: { name: "query", kind: "text", allowEmpty: true } },
      { names: ["--limit"], description: "Page size from 1 to 100", value: { name: "limit", kind: "text" } },
      { names: ["--cursor"], description: "Start from a catalog cursor", value: { name: "cursor", kind: "text" } },
      project, json, help,
    ], details: "Read all pages before printing. A cursor is bound to the project, identity, query, limit and catalog epoch. A changed catalog or failed page fails the whole command." },
    { name: "show", description: "Show a Tag by UUID", arguments: [tagId], options: [project, json, help] },
    { name: "create", description: "Create a Tag", arguments: [name], options: [project, json, help], allowOptionsTerminator: true, details: "Names are validated by the server. Place options before -- for a dash-prefixed name. An unknown write outcome is not retried." },
    { name: "rename", description: "Rename a Tag", arguments: [tagId, name], options: [project, version, json, help], allowOptionsTerminator: true, details: "Without --if-version, read the current Tag version before submitting. An explicit version is submitted unchanged; conflicts and unknown writes are not retried. Place options before -- for a dash-prefixed name." },
    { name: "delete", description: "Delete a Tag and all its associations", arguments: [tagId], options: [project, version, { names: ["--confirm"], description: "Confirm deletion in non-interactive use" }, json, help], details: "Read the Tag and preview its name, version and visible Task and Goal counts. Deletion removes all associations, including associations added after the preview. Interactive use requires the exact name as a JSON string literal, even with --confirm; non-interactive use requires --confirm. The supplied version is submitted unchanged; otherwise use the preview version. Conflicts and unknown writes are not retried." },
  ], options: [help], details: "Without --project, resolve the current Git origin to its project. Run daynight tag <command> --help for command usage.",
};
