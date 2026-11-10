import type { CommandDefinition, CommandOption } from "../../../cli/schema.js";

const help: CommandOption = { names: ["-h", "--help"], description: "Show this help", action: "help" };
const project: CommandOption = { names: ["--project"], description: "Use this project UUID", value: { name: "project-id", kind: "text" } };
const json: CommandOption = { names: ["--json"], description: "Print the original operation and its actual state as JSON" };
const operation: CommandOption = { names: ["--operation-id"], description: "Operation UUID", value: { name: "operation-id", kind: "text" } };
export const sessionSendDefinitions: readonly CommandDefinition[] = [
  {
    name: "send", description: "Send text to one explicit Task Session",
    arguments: [{ name: "task-id", description: "Task UUID" }, { name: "session-id", description: "Session UUID" }],
    options: [
      { names: ["--text"], description: "Exact message text", value: { name: "text", kind: "text", allowEmpty: true } },
      { names: ["--file"], description: "Read exact UTF-8 text from a regular file", value: { name: "path", kind: "text" } },
      { names: ["--stdin"], description: "Read exact UTF-8 text from stdin" },
      operation, { names: ["--wait-seconds"], description: "Receipt wait from 0 to 60 seconds (default: 30)", value: { name: "seconds", kind: "text" } }, project, json, help,
    ],
    details: "Select exactly one of --text, --file or --stdin. Text is preserved, including BOM and final newlines; the limit is 1048576 UTF-8 bytes and 2 MiB for the complete command JSON. Slash text is an ordinary message.\nA supplied operation ID without a local record means the caller is submitting that ID for the first time. Existing local records are query-only, even after a crash. For recovery from another machine or an unknown previous submission, use operation with all original IDs. Never retry by selecting a new ID.\nThe wait ends at provider acceptance or a terminal receipt, not Agent task completion. Exit codes: 0 provider_accepted/confirmed; 1 failure; 2 usage; 3 pending/unknown; 130 interruption.",
  },
  {
    name: "operation", description: "Query an original Task Session operation without sending",
    arguments: [{ name: "task-id", description: "Original Task UUID", optional: true }, { name: "session-id", description: "Original Session UUID", optional: true }, { name: "operation-id", description: "Original operation UUID", optional: true }],
    options: [operation, project, json, help],
    details: "Provide all three original IDs, or only --operation-id to recover a local record for the current authenticated actor and server. Partial targets are rejected. A missing receipt is unknown and never authorizes resending. Historical operations remain queryable after the current Session binding changes.\nExit codes: 0 provider_accepted/confirmed; 1 rejected/failed/expired or request/output failure; 2 usage; 3 pending/unknown/not_found; 130 interruption.",
  },
];
