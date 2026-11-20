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
const scope = [
  { ...option("--scope-project", "Project UUID the experience applies to; repeat for several"), repeatable: true },
  { ...option("--scope-event-type", "Assistant task event type the experience applies to; repeat for several"), repeatable: true },
  { ...option("--scope-category", "Item category the experience applies to; repeat for several"), repeatable: true },
];
const scopeDetails = "Scope options restrict where the experience applies; a dimension without values stays unrestricted. Each dimension accepts at most 20 distinct values.";
const common = [json, help];
const write = [operation, ...common];
const page = [limit, cursor];
const leaf = (name: string, description: string, options: readonly CommandOption[], arguments_: readonly CommandArgument[] = [task], details?: string): CommandDefinition => ({ name, description, arguments: arguments_, options, ...(details === undefined ? {} : { details }) });
const group = (name: string, description: string, commands: readonly CommandDefinition[]): CommandDefinition => ({ name, description, commands, options: [help] });
const unknown = "Writes are sent once. On an unknown outcome, read the original resource and operation before deciding again. --operation-id identifies the request locally; only claim and inbox operations, event acknowledgements and resource additions have server-side operation/ID deduplication.";
const itemFields = [option("--key", "Stable application item key", true), option("--episode", "Positive int64 episode", true), option("--state", "Item state", true, ["open", "closed"]), option("--category", "Application category", true, undefined, true), option("--app-state", "Application state JSON (default: {})")];

export const assistantTaskDefinition: CommandDefinition = {
  name: "assistant-task",
  description: "Read and operate account-owned assistant tasks",
  options: [help],
  details: "No Project or Git repository is required. DAYNIGHT_BOT_ID identifies a Bot; DAYNIGHT_BOT_STATE_DIR stores private claim credentials. Without Bot identity, only reads and user operations are allowed. Lists return one page with nextCursor; pass it explicitly to continue.\n" + unknown,
  commands: [
    leaf("list", "Read one page of assistant tasks", [...page, state(["active", "paused"]), target, ...common], []),
    leaf("show", "Read a task and its authoritative current claim", common),
    leaf("metrics", "Read the task's capability metrics for the last 30 days", common, [task], "Counts action records, outcome records by value, escalation and result_unknown events, and item closures in the window. averageResolutionMs covers only closures with a known open time; untimedClosureCount reports the rest. observedAt, windowStart and windowEnd come from one database snapshot."),
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
    group("inbox", "Read and manage the task's inbound message inbox as its user", [
      leaf("show", "Read the inbox state; tokens are never returned", common),
      leaf("enable", "Enable an inbox and print its token once", [version, ...write], [task], "The full token appears only in this response. Store it for the external sender; a replay of the same operation returns null. " + unknown),
      leaf("rotate", "Replace the inbox token and print the new token once", [version, option("--mode", "overlap keeps the previous token valid for 24 hours; immediate revokes it", true, ["overlap", "immediate"]), ...write], [task], "While a previous token is still in its overlap period, only immediate rotation is accepted. " + unknown),
      leaf("disable", "Disable the inbox permanently; enabling again creates a new inbox ID", [version, ...write]),
      leaf("operation", "Read the original inbox operation receipt without replaying it; tokens are never returned", common, [task, id("operation")]),
    ]),
    group("manual", "Read manual versions and restore a historical version", [
      leaf("show", "Read the current or specified manual", [option("--version", "Positive manual version; omitted selects current"), ...common]),
      leaf("list", "Read one page of manual versions", [...page, ...common]),
      leaf("rollback", "Create a new manual from an earlier version as its user", [version, option("--manual-version", "Historical manual version", true), ...write]),
    ]),
    group("appendix", "Read, append and maintain evidence-backed experience", [
      leaf("list", "Read one page of appendices", [...page, state(["active", "edited", "deleted"]), ...common]),
      leaf("related", "Read up to five appendices related to a notification context", [option("--project", "Project UUID of the context"), option("--event-type", "Assistant task event type of the context"), option("--category", "Item category of the context, matched verbatim"), ...common], [task], "Each given dimension that an appendix scope declares and contains scores one point; an undeclared dimension or an omitted option neither scores nor excludes, and a declared dimension without the given value excludes the appendix. Results are ordered by score, last validation time (never validated last) and ID, all descending, and exclude deleted appendices."),
      leaf("add", "Append experience as the responsible Bot", [option("--text", "Experience text", true), source, ...scope, ...write], [task], scopeDetails),
      leaf("update", "Edit an appendix as its user", [version, option("--text", "Replacement text", true), { ...source, description: "Replace evidence record references; repeat for several. Omission preserves them" }, { names: ["--clear-source-records"], description: "Explicitly remove every evidence record reference; conflicts with --source-record" }, ...scope, { names: ["--clear-scope"], description: "Explicitly make the appendix unrestricted; conflicts with the scope options" }, ...write], [task, id("appendix")], scopeDetails + " Any scope option replaces the whole scope; omitting all of them preserves it."),
      leaf("delete", "Delete an appendix as its user", [version, ...write], [task, id("appendix")], "Deletion also removes the appendix scope and every registered validation."),
      leaf("validate", "Register an outcome record as evidence for an appendix as the responsible Bot", [option("--outcome-record", "Outcome record UUID of this task", true), ...write], [task, id("appendix")], "An effective outcome counts as a success and an ineffective one as a failure; an inconclusive outcome is refused. One outcome record validates an appendix at most once."),
    ]),
    leaf("propose", "Propose a manual revision as the responsible Bot", [option("--base-version", "Observed manual version", true), body, rules, option("--reason", "Reason for the revision", true), { ...option("--evidence-record", "Evidence record UUID; repeat for several records"), repeatable: true }, ...write]),
    group("proposal", "Read and decide manual revision proposals", [
      leaf("list", "Read one page of proposals", [...page, state(["pending", "approved", "edited", "rejected"]), ...common]),
      leaf("decide", "Approve, edit or reject a proposal as its user", [version, option("--decision", "User decision", true, ["approved", "edited", "rejected"]), option("--note", "Decision note", false, undefined, true), { ...body, required: false }, rules, ...write], [task, id("proposal")]),
    ]),
    group("record", "Read and append immutable work records", [
      leaf("list", "Read one page of records", [...page, item, ...common]),
      leaf("add", "Append a Bot work record", [item, option("--kind", "Record kind", true, ["fact", "guess", "action", "unknown", "question", "answer", "note", "outcome"]), option("--text", "Complete record text", true), option("--outcome", "Observed result of the evaluated action; required for and only accepted by outcome records", false, ["effective", "ineffective", "inconclusive"]), option("--action-record", "Evaluated action record UUID of this task; required for and only accepted by outcome records"), option("--refs", "Reference JSON"), ...write], [task], "The holder uses its saved credential. Another Bot may append only action or note records without a claim. An outcome record evaluates one earlier action record and leaves it unchanged; later observations append further outcome records."),
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
