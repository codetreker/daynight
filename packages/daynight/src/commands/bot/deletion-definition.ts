import type { CommandDefinition, CommandOption } from "../../cli/schema.js";
const help: CommandOption = { names: ["-h", "--help"], description: "Show this help", action: "help" };
const json: CommandOption = { names: ["--json"], description: "Print recovery state as JSON; operation failures use JSON on stderr" };
const target = [{ name: "bot-id", description: "Original Bot UUID" }];
const deletion: CommandOption = { names: ["--deletion-id"], description: "Original deletion UUID", value: { name: "uuid", kind: "text" }, required: true };
const version: CommandOption = { names: ["--if-version"], description: "Exact version observed with deletion inspect", value: { name: "version", kind: "text" }, required: true };
const operation: CommandOption = { names: ["--operation-id"], description: "Stable decision UUID, retained for reconciliation and cleanup retry", value: { name: "uuid", kind: "text" }, required: true };
export const botDeletionDefinition: CommandDefinition = {
  name: "deletion", description: "Inspect or recover a deletion that needs execution evidence", options: [help],
  commands: [
    { name: "inspect", description: "Read server recovery state and inspect the original machine's retained evidence", arguments: target, options: [
      { names: ["--server-only"], description: "Read only the server decision, including from another machine" }, json, help,
    ], details: "This command does not stop processes, remove files or submit a recovery decision. Missing local evidence does not prove that execution stopped. Use the original DN_CONFIG_DIR for local inspection." },
    { name: "recover", description: "Stop and clean the original execution using retained local evidence", arguments: target, options: [deletion, json, help],
      details: "Run on the hosting Worker's machine with its original DN_CONFIG_DIR after stopping the Worker. Recovery requires the Worker lock and original execution identity; it never reconstructs a stop proof from missing files or process names." },
    { name: "resolve", description: "Accept unverified local cleanup and request actual server cleanup", arguments: target, options: [version, deletion, operation,
      { names: ["--accept-local-unverified"], description: "Acknowledge that original execution and local files have not been verified", required: true },
      { names: ["--reason"], description: "Reason for accepting unverified local cleanup (1 to 1000 characters)", value: { name: "reason", kind: "text" }, required: true }, json, help,
    ], details: "Only the Bot owner may resolve execution_evidence_missing. Server cleanup does not prove that native processes stopped or that ordinary working directories and Provider history were removed. Preserve the operation ID. Unknown results must be read with inspect --server-only; writes are never automatically replayed." },
    { name: "retry-cleanup", description: "Explicitly retry server cleanup for an existing unverified-local decision", arguments: target, options: [version, deletion, operation, json, help],
      details: "Read the current state first. Use the saved decision's operation ID and the exact current version. A timeout is not rollback: inspect the original decision before considering another retry." },
  ],
};
