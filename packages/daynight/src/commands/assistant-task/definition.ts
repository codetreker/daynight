import type { CommandArgument, CommandDefinition, CommandOption } from "../../cli/schema.js";

const help: CommandOption = { names: ["-h", "--help"], description: "Show this help", action: "help" };
const json: CommandOption = { names: ["--json"], description: "Print one complete JSON resource; failures use JSON on stderr" };
const option = (name: string, description: string, required = false, choices?: readonly string[], allowEmpty = false): CommandOption => ({ names: [name], description, value: { name: name.slice(2), kind: "text", ...(choices === undefined ? {} : { choices }), ...(allowEmpty ? { allowEmpty: true } : {}) }, ...(required ? { required: true } : {}) });
const version = option("--if-version", "Exact observed positive int64 decimal version", true);
const operation = option("--operation-id", "Original operation UUID; generated once if omitted. Resource additions use it as their ID");
const generation = option("--expected-generation", "Exact observed nonnegative claim generation", true);
const task: CommandArgument = { name: "task-id", description: "Assistant task UUID, independent of Project Tasks" };
const id = (name: string): CommandArgument => ({ name: `${name}-id`, description: `${name} UUID within this assistant task` });
const limit = option("--limit", "Maximum resources in this page, 1 to 200 (default: 50)");
const cursor = option("--cursor", "Opaque cursor returned by the previous page");
const state = (choices: readonly string[]) => option("--state", "Filter by state", false, choices);
const target = option("--target-bot", "Target Bot UUID");
const item = option("--item", "Associated item UUID");
const body = option("--body", "Complete manual Markdown body", true);
const rules = option("--rules", "Rules JSON (default: {})");
const source = { ...option("--source-record", "Evidence record UUID; repeat to reference several records"), repeatable: true };
const common = [json, help];
const write = [operation, ...common];
const page = [limit, cursor];
const leaf = (name: string, description: string, options: readonly CommandOption[], arguments_: readonly CommandArgument[] = [task], details?: string): CommandDefinition => ({ name, description, arguments: arguments_, options, ...(details === undefined ? {} : { details }) });
const group = (name: string, description: string, commands: readonly CommandDefinition[]): CommandDefinition => ({ name, description, commands, options: [help] });
const unknown = "Writes are sent once. On an unknown outcome, read the original resource and operation before deciding again. --operation-id identifies the request locally; only claim operations, event acknowledgements and resource additions have server-side operation/ID deduplication.";
const itemFields = [option("--key", "Stable application item key", true), option("--episode", "Positive int64 episode", true), option("--state", "Item state", true, ["open", "closed"]), option("--category", "Application category", true, undefined, true), option("--app-state", "Application state JSON (default: {})")];

export const assistantTaskDefinition: CommandDefinition = {
  name: "assistant-task",
  description: "Read and operate account-owned assistant tasks",
  options: [help],
  details: "No Project or Git repository is required. DAYNIGHT_BOT_ID identifies a Bot; DAYNIGHT_BOT_STATE_DIR stores private claim credentials. Without Bot identity, only reads and user operations are allowed. Lists return one page with nextCursor; pass it explicitly to continue.\n" + unknown,
  commands: [
    leaf("list", "Read one page of assistant tasks", [...page, state(["active", "paused"]), target, ...common], []),
    leaf("show", "Read a task and its authoritative current claim", common),
    leaf("create", "Create a user-owned assistant task and initial manual", [option("--name", "Task name", true), option("--purpose", "Task purpose", false, undefined, true), option("--scope", "Task scope", false, undefined, true), option("--kind", "Task kind (default: continuous)", false, ["continuous", "once"]), option("--takeover", "Takeover policy (default: manual)", false, ["manual", "auto"]), option("--application", "Registered application name"), option("--trigger", "Trigger JSON; null means none"), body, rules, ...write], [], unknown),
    leaf("update", "Update a task definition as its user", [version, option("--name", "Task name"), option("--purpose", "Task purpose", false, undefined, true), option("--scope", "Task scope", false, undefined, true), option("--takeover", "Takeover policy", false, ["manual", "auto"]), option("--trigger", "Trigger JSON; null clears it"), ...write], [task], unknown),
    leaf("pause", "Pause application work while retaining the claim", [version, ...write]),
    leaf("resume", "Resume a paused task", [version, ...write]),
    leaf("delete", "Delete a task and its materials as its user", [version, ...write]),
    leaf("claim", "Claim an unowned or expired task as this Bot", [version, generation, ...write], [task], "Save a new random token before submission. An effective claim, including pending transfer, cannot be replaced. " + unknown),
    leaf("bind", "Bind this Bot's private credential to a pending transfer", [generation, ...write], [task], "Binding does not renew the lease. A confirmed immediate renewal is required before application work."),
    leaf("renew", "Renew this Bot's current claim with its saved credential", write),
    leaf("release", "Release the current claim without deleting task material", [option("--if-version", "Observed task version; required for a user release"), generation, ...write]),
    leaf("transfer", "Transfer responsibility to another Bot", [version, generation, { ...target, required: true }, ...write]),
    group("claim-operation", "Read the original claim operation without replaying it", [leaf("show", "Verify a historical receipt and its separate current claim", common, [task, id("operation")])]),
    group("manual", "Read manual versions and restore a historical version", [
      leaf("show", "Read the current or specified manual", [option("--version", "Positive manual version; omitted selects current"), ...common]),
      leaf("list", "Read one page of manual versions", [...page, ...common]),
      leaf("rollback", "Create a new manual from an earlier version as its user", [version, option("--manual-version", "Historical manual version", true), ...write]),
    ]),
    group("appendix", "Read, append and maintain evidence-backed experience", [
      leaf("list", "Read one page of appendices", [...page, state(["active", "edited", "deleted"]), ...common]),
      leaf("add", "Append experience as the responsible Bot", [option("--text", "Experience text", true), source, ...write]),
      leaf("update", "Edit an appendix as its user", [version, option("--text", "Replacement text", true), { ...source, description: "Replace evidence record references; repeat for several. Omission preserves them" }, { names: ["--clear-source-records"], description: "Explicitly remove every evidence record reference; conflicts with --source-record" }, ...write], [task, id("appendix")]),
      leaf("delete", "Delete an appendix as its user", [version, ...write], [task, id("appendix")]),
    ]),
    leaf("propose", "Propose a manual revision as the responsible Bot", [option("--base-version", "Observed manual version", true), body, rules, option("--reason", "Reason for the revision", true), { ...option("--evidence-record", "Evidence record UUID; repeat for several records"), repeatable: true }, ...write]),
    group("proposal", "Read and decide manual revision proposals", [
      leaf("list", "Read one page of proposals", [...page, state(["pending", "approved", "edited", "rejected"]), ...common]),
      leaf("decide", "Approve, edit or reject a proposal as its user", [version, option("--decision", "User decision", true, ["approved", "edited", "rejected"]), option("--note", "Decision note", false, undefined, true), { ...body, required: false }, rules, ...write], [task, id("proposal")]),
    ]),
    group("record", "Read and append immutable work records", [
      leaf("list", "Read one page of records", [...page, item, ...common]),
      leaf("add", "Append a Bot work record", [item, option("--kind", "Record kind", true, ["fact", "guess", "action", "unknown", "question", "answer", "note"]), option("--text", "Complete record text", true), option("--refs", "Reference JSON"), ...write], [task], "The holder uses its saved credential. Another Bot may append only action or note records without a claim."),
    ]),
    group("item", "Read and maintain application items", [
      leaf("list", "Read one page of items", [...page, state(["open", "closed"]), ...common]),
      leaf("show", "Read one item", common, [task, id("item")]),
      leaf("add", "Create an item as the responsible Bot", [...itemFields, ...write]),
      leaf("update", "Update an item as the responsible Bot", [version, ...itemFields, ...write], [task, id("item")]),
    ]),
    leaf("ask", "Ask the responsible Bot a question with a five-minute deadline", [item, option("--question", "Complete question", true), ...write]),
    leaf("answer", "Answer an inquiry as the responsible Bot", [option("--answer", "Complete answer", true), ...write], [task, id("inquiry")]),
    group("inquiry", "Read cross-Bot questions and their outcomes", [leaf("list", "Read one page of inquiries", [...page, item, state(["open", "answered", "timed_out"]), ...common])]),
    group("events", "Read and acknowledge assistant task events", [
      leaf("pull", "Read one page of events across tasks or for one task", [...page, state(["pending", "delivered", "expired"]), target, ...common], [{ ...task, optional: true }]),
      leaf("add", "Create an event as the responsible Bot", [{ ...target, required: true }, option("--type", "Event type", true), option("--payload", "Event payload JSON"), ...write]),
      leaf("ack", "Acknowledge this Bot's event with an operation UUID", [option("--state", "Acknowledgement state (default: delivered)", false, ["delivered", "expired"]), ...write], [task, id("event")]),
      leaf("clear-attention", "Clear a Bot's attention markers as its user", [{ ...target, required: true }, ...write], []),
    ]),
  ],
};
