import type { CommandDefinition, CommandOption } from "../../cli/schema.js";

const help: CommandOption = { names: ["-h", "--help"], description: "Show this help", action: "help" };
const json: CommandOption = { names: ["--json"], description: "Print the complete API resource data as JSON" };
const team: CommandOption = { names: ["--team"], description: "Team UUID or personal", value: { name: "team", kind: "text" } };
export const teamDefinition: CommandDefinition = {
  name: "team", description: "Read Teams and their projects",
  commands: [
    { name: "list", description: "List Teams joined by the current user", options: [json, help], details: "Read every page before printing the complete result." },
    { name: "show", description: "Show a Team and the current membership", options: [team, json, help], details: "Use --team when specified, otherwise the configured default or Personal Team." },
    { name: "projects", description: "List projects owned by a Team", options: [team, json, help], details: "Read every page before printing the complete result. Use --team when specified, otherwise the configured default or Personal Team." },
    { name: "default", description: "Read the current account's default Team", commands: [
      { name: "show", description: "Show and validate the default Team", options: [json, help], details: "An unconfigured default resolves to the current account's Personal Team." },
    ], options: [help] },
  ], options: [help], details: "Run daynight team <command> --help for command usage.",
};
