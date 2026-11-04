import type { CommandDefinition, CommandOption } from "../../cli/schema.js";

const help: CommandOption = { names: ["-h", "--help"], description: "Show this help", action: "help" };
const json: CommandOption = { names: ["--json"], description: "Print the complete API resource data as JSON" };
const team: CommandOption = { names: ["--team"], description: "Team UUID or personal", value: { name: "team", kind: "text" } };
const confirm: CommandOption = { names: ["--confirm"], description: "Confirm this change without an interactive prompt" };
const version: CommandOption = { names: ["--if-version"], description: "Require the observed Team version", value: { name: "version", kind: "text" } };
const name = { name: "name", description: "Team name (preserved exactly)" };
const memberVersion: CommandOption = { names: ["--if-version"], description: "Require the observed Team membership version", value: { name: "version", kind: "text" } };
const memberId = { name: "user-id", description: "Existing Team member UUID" };
const memberDetails = "Uses the observed Team membership version; --if-version must match it exactly. Without --confirm, interactive confirmation is required.";
export const teamDefinition: CommandDefinition = {
  name: "team", description: "Manage Teams and their projects",
  commands: [
    { name: "create", description: "Create an ordinary Team", arguments: [name], options: [confirm, json, help], allowOptionsTerminator: true, details: "Without --confirm, an interactive confirmation is required." },
    { name: "rename", description: "Rename an ordinary Team", arguments: [name], options: [team, version, confirm, json, help], allowOptionsTerminator: true, details: "Uses the current Team snapshot and its version unless --if-version is supplied. Without --confirm, an interactive confirmation is required." },
    { name: "delete", description: "Delete an empty ordinary Team", options: [team, version, confirm, json, help], details: "Without --confirm, enter the displayed Team name as a JSON string literal. The original name and version are sent as preconditions." },
    { name: "member", description: "Manage existing Team members", commands: [
      { name: "list", description: "List members of a Team", options: [team, json, help], details: "Only current Team members may read the directory." },
      { name: "set-role", description: "Change a Team member role", arguments: [memberId, { name: "role", description: "New role", choices: ["member", "admin"] }], options: [team, memberVersion, confirm, json, help], details: memberDetails },
      { name: "remove", description: "Remove a Team member", arguments: [memberId], options: [team, memberVersion, confirm, json, help], details: memberDetails },
    ], options: [help] },
    { name: "leave", description: "Leave an ordinary Team", options: [team, memberVersion, confirm, json, help], details: memberDetails },
    { name: "list", description: "List Teams joined by the current user", options: [json, help], details: "Read every page before printing the complete result." },
    { name: "show", description: "Show a Team and the current membership", options: [team, json, help], details: "Use --team when specified, otherwise the configured default or Personal Team." },
    { name: "projects", description: "List projects owned by a Team", options: [team, json, help], details: "Read every page before printing the complete result. Use --team when specified, otherwise the configured default or Personal Team." },
    { name: "invitation", description: "Manage ordinary Team invitation links", commands: [
      { name: "create", description: "Create a single-use Team invitation", options: [team, confirm, json, help], details: "The link is printed once to stdout and cannot be recovered from the invitation list. Without --confirm, an interactive confirmation is required." },
      { name: "list", description: "List Team invitation metadata", options: [team, json, help], details: "The list never contains invitation links or secrets." },
      { name: "revoke", description: "Revoke a Team invitation", arguments: [{ name: "invite-id", description: "Invitation UUID" }], options: [team, confirm, json, help], details: "Without --confirm, an interactive confirmation is required. An already revoked invitation is a no-op." },
    ], options: [help] },
    { name: "default", description: "Manage the current account's default Team", commands: [
      { name: "show", description: "Show and validate the default Team", options: [json, help], details: "An unconfigured default resolves to the current account's Personal Team." },
      { name: "set", description: "Set the default Team", arguments: [{ name: "team", description: "Team UUID or personal" }], options: [confirm, json, help], details: "Verifies membership before saving the default for this server and account. Without --confirm, an interactive confirmation is required." },
    ], options: [help] },
  ], options: [help], details: "Run daynight team <command> --help for command usage.",
};
