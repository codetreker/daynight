import type { CommandDefinition, CommandOption } from "../../cli/schema.js";
const help: CommandOption = { names: ["-h", "--help"], description: "Show this help", action: "help" };
const json: CommandOption = { names: ["--json"], description: "Print the resource as JSON; operation failures use JSON on stderr" };
const request: CommandOption = { names: ["--request-id"], description: "Use this stable request UUID (generated before submission when omitted)", value: { name: "uuid", kind: "text" } };
const target = [{ name: "bot-id", description: "Bot UUID" }];
export const botDefinition: CommandDefinition = {
  name: "bot", description: "Create and query account-owned Bot definitions on the configured server",
  options: [help],
  details: "No project or Git repository is required. Bot execution depends on a compatible online Worker.\nRun daynight bot <command> --help for command usage.",
  commands: [
    { name: "list", description: "List all visible Bot definitions", options: [json, help], details: "Read every page before printing. --json prints one array. Deleted Bots are hidden; query their IDs with show." },
    { name: "show", description: "Read a Bot definition or its minimal deletion responsibility", arguments: target, options: [json, help], details: "--json prints the Bot object. Pending startup is not readiness, and recorded ready does not prove current connectivity." },
    { name: "create", description: "Create a Bot using server-resolved Worker defaults", options: [
      { names: ["--name"], description: "Bot name (1 to 40 Unicode characters, without control characters)", value: { name: "name", kind: "text" }, required: true },
      { names: ["--worker"], description: "Explicit hosting Worker UUID", value: { name: "worker-id", kind: "text" } },
      { names: ["--cwd"], description: "Absolute directory on the hosting Worker", value: { name: "path", kind: "directory" } },
      { names: ["--agent"], description: "Explicit provider", value: { name: "provider", kind: "text", choices: ["codex", "claude", "copilot"] } },
      { names: ["--model"], description: "Explicit native model on the hosting Worker", value: { name: "model", kind: "text" } },
      { names: ["--reasoning-effort"], description: "Explicit reasoning effort supported by the selected native model", value: { name: "effort", kind: "text" } },
      request, json, help,
    ], details: "Only --name is required. --request-id is the Bot ID. Omitted overrides remain omitted.\nA persisted pending definition is not a running Bot. On an unconfirmed response, query the original ID with bot show; this command never automatically repeats POST." },
    { name: "delete", description: "Request version-protected Bot deletion and report actual cleanup state", arguments: target, options: [
      { names: ["--if-version"], description: "Exact observed positive int64 decimal version", value: { name: "version", kind: "text" }, required: true }, request, json, help,
    ], details: "--request-id is the deletionId. No implicit version read or conflict retry occurs.\nOnly both cleanup phases completed means deletion completed. Pending or failed cleanup remains visible through bot show. On an unconfirmed response, reconcile the original Bot and deletion ID before another write.", },
  ],
};
