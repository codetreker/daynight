import type { CommandArgument, CommandDefinition, CommandOption } from "../../cli/schema.js";

const help: CommandOption = { names: ["-h", "--help"], description: "Show this help", action: "help" };
const json: CommandOption = { names: ["--json"], description: "Print the result as JSON" };
const personal: CommandOption = { names: ["--personal"], description: "Use the authenticated account as owner" };
const team: CommandOption = { names: ["--team"], description: "Use an explicit Team UUID as owner", value: { name: "team-id", kind: "text" } };
const confirm: CommandOption = { names: ["--confirm"], description: "Confirm the change without an interactive prompt" };
const version: CommandOption = { names: ["--if-version"], description: "Require the observed configuration version", value: { name: "config-version", kind: "text" }, required: true };
const generation: CommandOption = { names: ["--if-generation"], description: "Require the observed delivery generation", value: { name: "generation", kind: "text" }, required: true };
const file: CommandOption = { names: ["--file"], description: "Read the JSON input from a regular file", value: { name: "path", kind: "text" } };
const stdin: CommandOption = { names: ["--stdin"], description: "Read the JSON input from standard input" };
const operationId: CommandOption = { names: ["--operation-id"], description: "Use this operation UUID with --issued-at", value: { name: "operation-id", kind: "text" } };
const issuedAt: CommandOption = { names: ["--issued-at"], description: "Use this original UTC time with --operation-id", value: { name: "rfc3339", kind: "text" } };
const operationOut: CommandOption = { names: ["--operation-out"], description: "Create a private prepared operation record before sending", value: { name: "path", kind: "text" } };
const resume: CommandOption = { names: ["--resume-operation"], description: "Reconcile and explicitly resume a prepared operation", value: { name: "path", kind: "text" } };
const ownerOptions = [personal, team];
const writeOptions = [confirm, operationId, issuedAt, operationOut, resume];
const endpoint: CommandArgument = { name: "endpoint-id", description: "Endpoint UUID" };
const delivery: CommandArgument = { name: "delivery-id", description: "Delivery UUID" };
const ownerDetails = "Select exactly one owner using --personal or --team <team-id>. The current directory and default Team do not select an owner.";
const writeDetails = `${ownerDetails} Without --confirm, an interactive confirmation is required. --operation-id and --issued-at must be supplied together; --resume-operation is exclusive with them and --operation-out.`;
const inputDetails = `${writeDetails} Select exactly one of --file or --stdin; --stdin requires --confirm.`;
const limit: CommandOption = { names: ["--limit"], description: "Maximum items in this page (1–100, default 50)", value: { name: "limit", kind: "text" } };
const cursor: CommandOption = { names: ["--cursor"], description: "Continue from a previous page cursor", value: { name: "cursor", kind: "text" } };
const project: CommandOption = { names: ["--project"], description: "Filter by Project UUID", value: { name: "project-id", kind: "text" } };

export const webhookDefinition: CommandDefinition = {
  name: "webhook", description: "Manage outbound Webhooks",
  commands: [
    { name: "catalog", description: "List registered event types and service limits", options: [json, help] },
    { name: "list", description: "List all endpoints for an explicit owner", options: [...ownerOptions, { names: ["--query"], description: "Filter by name", value: { name: "query", kind: "text" } }, { names: ["--enabled"], description: "Filter by enabled state", value: { name: "enabled", kind: "text", choices: ["true", "false"] } }, json, help], details: ownerDetails },
    { name: "show", description: "Show endpoint configuration or a tombstone", arguments: [endpoint], options: [...ownerOptions, json, help], details: ownerDetails },
    { name: "create", description: "Create an endpoint from JSON", options: [...ownerOptions, file, stdin, ...writeOptions, json, help], details: inputDetails },
    { name: "update", description: "Update editable fields at an exact version", arguments: [endpoint], options: [...ownerOptions, version, file, stdin, ...writeOptions, json, help], details: inputDetails },
    ...(["enable", "disable", "delete"] as const).map((name): CommandDefinition => ({ name, description: `${name[0]!.toUpperCase()}${name.slice(1)} an endpoint at an exact version`, arguments: [endpoint], options: [...ownerOptions, version, ...writeOptions, json, help], details: writeDetails })),
    { name: "subscription", description: "Manage explicit subscriptions", options: [help], commands: [
      { name: "list", description: "List endpoint subscriptions", arguments: [endpoint], options: [...ownerOptions, json, help], details: ownerDetails },
      { name: "replace", description: "Replace the complete subscription set from JSON", arguments: [endpoint], options: [...ownerOptions, version, file, stdin, ...writeOptions, json, help], details: inputDetails },
      { name: "reconfirm", description: "Reconfirm subscriptions for explicit Projects", arguments: [endpoint], options: [...ownerOptions, version, { ...project, description: "Reconfirm this Project UUID", required: true, repeatable: true }, ...writeOptions, json, help], details: writeDetails },
    ] },
    { name: "secret", description: "Manage signing secrets", options: [help], commands: [
      { name: "show", description: "Show signing metadata or explicitly reveal the current secret", arguments: [endpoint], options: [...ownerOptions, { names: ["--reveal"], description: "Reveal the current signing secret" }, json, help], details: ownerDetails },
      { name: "rotate", description: "Rotate the signing secret", arguments: [endpoint], options: [...ownerOptions, version, { names: ["--mode"], description: "Rotation mode", value: { name: "mode", kind: "text", choices: ["overlap", "immediate"] }, required: true }, ...writeOptions, json, help], details: writeDetails },
    ] },
    { name: "delivery", description: "Inspect deliveries and register redelivery", options: [help], commands: [
      { name: "list", description: "List one page of delivery history", arguments: [endpoint], options: [...ownerOptions, { names: ["--event-type"], description: "Filter by event type", value: { name: "event-type", kind: "text" } }, { names: ["--state"], description: "Filter by delivery state", value: { name: "state", kind: "text" } }, project, { names: ["--from"], description: "Filter from this time", value: { name: "rfc3339", kind: "text" } }, { names: ["--to"], description: "Filter through this time", value: { name: "rfc3339", kind: "text" } }, limit, cursor, json, help], details: `${ownerDetails} History is one page; use --cursor to continue.` },
      { name: "show", description: "Show a delivery", arguments: [endpoint, delivery], options: [...ownerOptions, json, help], details: ownerDetails },
      { name: "payload", description: "Read the original delivery payload", arguments: [endpoint, delivery], options: [...ownerOptions, { names: ["--output"], description: "Publish the original bytes to a new private file (Linux with procfs and glibc)", value: { name: "path", kind: "text" } }, json, help], details: `${ownerDetails} Default output is the exact original bytes; --json and --output are mutually exclusive.` },
      { name: "redeliver", description: "Register a manual redelivery", arguments: [endpoint, delivery], options: [...ownerOptions, version, generation, ...writeOptions, json, help], details: `${writeDetails} A successful registration does not mean delivery has completed.` },
    ] },
    { name: "attempt", description: "Inspect delivery attempts", options: [help], commands: [
      { name: "list", description: "List one page of delivery attempts", arguments: [endpoint, delivery], options: [...ownerOptions, { names: ["--generation"], description: "Filter by delivery generation", value: { name: "generation", kind: "text" } }, limit, cursor, json, help], details: `${ownerDetails} History is one page; use --cursor to continue.` },
    ] },
    { name: "operation", description: "Inspect an original operation receipt", options: [help], commands: [
      { name: "show", description: "Show an original operation receipt", arguments: [{ name: "operation-id", description: "Operation UUID" }], options: [...ownerOptions, json, help], details: ownerDetails },
    ] },
  ], options: [help], details: "Run daynight webhook <command> --help for command usage.",
};
