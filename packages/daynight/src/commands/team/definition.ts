import type { CommandDefinition, CommandOption } from "../../cli/schema.js";

const help: CommandOption = { names: ["-h", "--help"], description: "Show this help", action: "help" };
const json: CommandOption = { names: ["--json"], description: "Print the complete API resource data as JSON" };
const team: CommandOption = { names: ["--team"], description: "Team UUID or personal", value: { name: "team", kind: "text" } };
const confirm: CommandOption = { names: ["--confirm"], description: "Confirm this change without an interactive prompt" };
const version: CommandOption = { names: ["--if-version"], description: "Require the observed Team version", value: { name: "version", kind: "text" } };
const name = { name: "name", description: "Team name (preserved exactly)" };
export const teamDefinition: CommandDefinition = {
  name: "team", description: "Manage Teams and their projects",
  commands: [
    { name: "create", description: "Create an ordinary Team", arguments: [name], options: [confirm, json, help], allowOptionsTerminator: true, details: "Without --confirm, an interactive confirmation is required." },
    { name: "rename", description: "Rename an ordinary Team", arguments: [name], options: [team, version, confirm, json, help], allowOptionsTerminator: true, details: "Uses the current Team snapshot and its version unless --if-version is supplied. Without --confirm, an interactive confirmation is required." },
    { name: "delete", description: "Delete an empty ordinary Team", options: [team, version, confirm, json, help], details: "Without --confirm, enter the displayed Team name as a JSON string literal. The original name and version are sent as preconditions." },
    { name: "list", description: "List Teams joined by the current user", options: [json, help], details: "Read every page before printing the complete result." },
    { name: "show", description: "Show a Team and the current membership", options: [team, json, help], details: "Use --team when specified, otherwise the configured default or Personal Team." },
    { name: "projects", description: "List projects owned by a Team", options: [team, json, help], details: "Read every page before printing the complete result. Use --team when specified, otherwise the configured default or Personal Team." },
    { name: "default", description: "Manage the current account's default Team", commands: [
      { name: "show", description: "Show and validate the default Team", options: [json, help], details: "An unconfigured default resolves to the current account's Personal Team." },
      { name: "set", description: "Set the default Team", arguments: [{ name: "team", description: "Team UUID or personal" }], options: [confirm, json, help], details: "Verifies membership before saving the default for this server and account. Without --confirm, an interactive confirmation is required." },
    ], options: [help] },
  ], options: [help], details: "Run daynight team <command> --help for command usage.",
};
