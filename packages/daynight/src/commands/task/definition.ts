import type { CommandDefinition, CommandOption } from "../../cli/schema.js";
import { taskStatuses } from "../../task/status.js";
import type { TaskSessionCommandModule } from "./session/registry.js";
import { taskSessionReadModule } from "./session/read-definition.js";
import { sessionSendDefinitions } from "./session/send-definition.js";

// Session modules register metadata here and load their handlers only on dispatch.
export const taskSessionModules: readonly TaskSessionCommandModule[] = [taskSessionReadModule, { definitions: sessionSendDefinitions, load: () => import("./session/send.js") }];
const sessionDefinitions = taskSessionModules.flatMap(module => module.definitions);
export const taskSessionDefinitions: readonly CommandDefinition[] = sessionDefinitions.length === 0 ? [] : [{
  name: "session", description: "Inspect and interact with a specific Task Session", commands: sessionDefinitions,
  options: [{ names: ["-h", "--help"], description: "Show this help", action: "help" }],
}];

const helpOption: CommandOption = { names: ["-h", "--help"], description: "Show this help", action: "help" };
const projectOption: CommandOption = { names: ["--project"], description: "Use this project UUID for this invocation", value: { name: "project-id", kind: "text" } };
const jsonOption: CommandOption = { names: ["--json"], description: "Print the complete API resource data as JSON" };
const listJsonOption: CommandOption = { names: ["--json"], description: "Print task fields except description as JSON" };
const titleOption: CommandOption = { names: ["--title"], description: "Task title", value: { name: "title", kind: "text" } };
const descriptionOption: CommandOption = { names: ["--description"], description: "Task description; an empty value clears it", value: { name: "description", kind: "text", allowEmpty: true } };
const tagOption: CommandOption = { names: ["--tag"], description: "Tag UUID; repeat for the complete tag set", value: { name: "tag-id", kind: "text" }, repeatable: true };
const filterTagOption: CommandOption = { names: ["--tag"], description: "Filter by tag UUID; repeat for multiple tags", value: { name: "tag-id", kind: "text" }, repeatable: true };
const tagMatchOption: CommandOption = { names: ["--tag-match"], description: "Match all or any selected tags (default: all)", value: { name: "all|any", kind: "text", choices: ["all", "any"] } };
const untaggedOption: CommandOption = { names: ["--untagged"], description: "Filter for items without tags; conflicts with --tag" };
const dependencyOption: CommandOption = { names: ["--depends-on"], description: "Ordinary prerequisite UUID; repeat for the complete ordinary set", value: { name: "task-id", kind: "text" }, repeatable: true };
const externalDependencyOption: CommandOption = { names: ["--external-depends-on"], description: "External prerequisite UUID; repeat for the complete external set", value: { name: "task-id", kind: "text" }, repeatable: true };
const dependencyDetails = "Supplying either dependency option replaces every dependency and its classification. --depends-on supplies ordinary prerequisites; --external-depends-on supplies external prerequisites. External-only input keeps only those external prerequisites; ordinary-only input makes every supplied prerequisite ordinary. IDs must be valid UUIDs and occur once across both options. Both kinds block execution until done or cancelled.";
const assignedToOption: CommandOption = { names: ["--assigned-to"], description: "Task assignee UUID", value: { name: "user-id", kind: "text" } };
const assignedToFilterOption: CommandOption = { names: ["--assigned-to"], description: "Include tasks assigned to this user, me, or unassigned", value: { name: "user-id|me|unassigned", kind: "text" } };
const typeOption: CommandOption = { names: ["--type"], description: "Resource type (default: task)", value: { name: "task|goal", kind: "text", choices: ["task", "goal"] } };
const parentOption: CommandOption = { names: ["--parent"], description: "Goal UUID or none", value: { name: "goal-id|none", kind: "text" } };
const forceOption: CommandOption = { names: ["--force"], description: "Skip the Goal impact confirmation" };
const statusOption: CommandOption = { names: ["--status"], description: "Task status", value: { name: "status", kind: "text", choices: taskStatuses } };
const allowAgentsOption: CommandOption = { names: ["--allow-agents"], description: "Automatic-execution permission", value: { name: "true|false", kind: "text", choices: ["true", "false"] } };
const platformChoices = ["windows", "linux", "macos"] as const;
const requiredPlatformOption: CommandOption = { names: ["--required-platform"], description: "Required execution platform", value: { name: "platform", kind: "text", choices: platformChoices } };
const compatiblePlatformOption: CommandOption = { names: ["--compatible-platform"], description: "Include unrestricted tasks and tasks requiring this execution platform", value: { name: "platform", kind: "text", choices: platformChoices } };
const versionOption: CommandOption = { names: ["--if-version"], description: "Use this expected task version without reading a newer version", value: { name: "version", kind: "text" } };
const claimOption: CommandOption = { names: ["--claim-id"], description: "Complete this active worker claim; valid only with done", value: { name: "claim-id", kind: "text" } };
const tagFilterDetails = "Repeat --tag with tag UUIDs to match all selected tags by default; --tag-match any matches at least one. --untagged selects items with no tags and conflicts with --tag. These filters combine with other conditions; invalid or inaccessible tags are rejected.";
const taskArgument = { name: "task-id", description: "Task UUID" };

export const taskDefinition: CommandDefinition = {
  name: "task",
  description: "Create, query, update, and delete project tasks on the configured server",
  commands: [
    ...taskSessionDefinitions,
    {
      name: "create",
      description: "Create a Task or Goal",
      options: [{ ...titleOption, required: true }, descriptionOption, typeOption, parentOption, { names: ["--status"], description: "Initial status (Task: proposed or todo; Goal: todo, in_progress, done or cancelled)", value: { name: "status", kind: "text", choices: taskStatuses } }, assignedToOption, { names: ["--clear-assigned-to"], description: "Create without an assignee" }, requiredPlatformOption, dependencyOption, externalDependencyOption, tagOption, forceOption, projectOption, helpOption],
      details: `Ordinary Tasks default to proposed with automatic execution disabled; Goals default to todo. --type selects the resource type. --parent accepts a Goal UUID or none; omission leaves the new Task unassigned to a Goal. Goals cannot have a parent. Use --status todo for confirmed work, including internal multi-step tasks. Creating a task does not start execution. Without --assigned-to, the task is assigned to the signed-in account; an explicit UUID overrides this default and must identify a project member; --clear-assigned-to explicitly creates an unassigned resource. Creating a done or cancelled Goal requires interactive confirmation or --force. For ordinary Tasks, if the current account cannot be read, creation fails without submitting a Task. Goal creation leaves an omitted assignee to the server default. Without --required-platform, execution has no platform restriction. Omitting both dependency options creates a task with no prerequisites. Repeat --tag to set the initial tag set atomically; omission creates no associations.\n${dependencyDetails}`,
    },
    {
      name: "list",
      description: "List unfinished tasks, with in-progress and ready tasks first",
      options: [{ names: ["--all"], description: "Include completed tasks; conflicts with --status" }, statusOption, assignedToFilterOption, typeOption, parentOption, { names: ["--ready"], description: "Include only tasks ready to start" }, allowAgentsOption, compatiblePlatformOption, filterTagOption, tagMatchOption, untaggedOption,
        { names: ["--group-by"], description: "Return one page of ordinary chains and independent tasks", value: { name: "chain", kind: "text", choices: ["chain"] } },
        { names: ["--limit"], description: "Groups per page, 1–50 (default: 20); requires --group-by chain", value: { name: "count", kind: "text" } },
        { names: ["--cursor"], description: "Continue a group page; requires --group-by chain", value: { name: "cursor", kind: "text" } },
        { names: ["--group-id"], description: "Group UUID for a target continuation", value: { name: "group-id", kind: "text" } },
        { names: ["--targets-cursor"], description: "Continue at most 20 targets with --group-id", value: { name: "cursor", kind: "text" } },
        projectOption, listJsonOption, helpOption],
      details: tagFilterDetails + "\nBy default, exclude done and cancelled tasks. Use --all for every status or --status for a specific status.\n--type defaults to task; --parent none selects unassigned Tasks and a UUID selects that Goal. Combine these with --assigned-to, --ready, --allow-agents, --compatible-platform and the selected statuses using AND. --assigned-to accepts a user UUID, me or unassigned; me uses the authenticated response principal. Platform compatibility includes unrestricted tasks and exact matches, without changing readiness. Ordinary lists read every matching page before printing, in_progress first, then ready todo, blocked todo, proposed, and terminal tasks; preserve server order within each group.\nOrdinary text lists omit description, Task version, and Task timestamps. --json remains an array, omits description, and adds each Task's Session observation. Observations from different pages have separate observedAt/freshUntil values and may be stale by output time. A partial observation preserves Task data and exits 3; an old service reports unsupported with an upgrade instruction.\n--group-by chain requires --status in_progress; --assigned-to defaults to me and cannot be unassigned. Other list filters and --all do not apply. This mode returns one page, including chains whose roots are already done, and does not expand external prerequisites. --cursor continues groups; --group-id and --targets-cursor must be paired and cannot combine with --cursor. Target pages contain at most 20 in-progress members regardless of --limit. Each group aggregates all accessible in-progress members, with each target's assignee and independent send eligibility. A changed Task graph requires restarting pagination. Session changes do not change pagination membership.",
    },
    {
      name: "search",
      description: "Search task IDs, titles and descriptions in one project",
      arguments: [{ name: "expression", description: "Complete search expression" }],
      options: [statusOption, assignedToFilterOption, typeOption, parentOption, { names: ["--ready"], description: "Include only tasks ready to start" }, allowAgentsOption, compatiblePlatformOption, filterTagOption, tagMatchOption, untaggedOption, projectOption, { names: ["--json"], description: "Print search results as a JSON array" }, helpOption],
      allowOptionsTerminator: true,
      details: tagFilterDetails + "\nPass the complete expression as one argument; use -- before an expression starting with a dash. Supports AND, OR, NOT, parentheses, quoted phrases, id:, title: and description:.\nAll statuses, including done, are searched by default. --type defaults to task; --parent none selects unassigned Tasks and a UUID selects that Goal. Filters combine with the expression. Every page is read before output, preserving server order. Search output omits assignee and update time; use task show for complete details.",
    },
    {
      name: "ready",
      description: "Show the first ready tasks in the project",
      options: [{ names: ["--limit"], description: "Maximum number of tasks to return, from 1 to 100 (default: 10)", value: { name: "count", kind: "text" } }, parentOption, allowAgentsOption, compatiblePlatformOption, filterTagOption, tagMatchOption, untaggedOption, projectOption, jsonOption, helpOption],
      details: tagFilterDetails + "\nRead one bounded page ordered by creation time, then task UUID, ascending. A task is ready when it is todo and every dependency is done or cancelled. --parent none selects unassigned Tasks and a UUID selects that Goal. --allow-agents and --compatible-platform combine with ready before the page limit and do not change readiness. Platform compatibility includes unrestricted tasks and exact matches.",
    },
    {
      name: "show",
      description: "Show a task by its ID",
      arguments: [taskArgument],
      options: [projectOption, jsonOption, helpOption],
      details: "Include a read-only Session observation with identity, activity, freshness and the caller's ordinary-message eligibility. Task status and indicator colors do not grant sending permission. Partial observations preserve Task data and exit 3.",
    },
    {
      name: "properties",
      description: "Read task properties or server-defined property schemas",
      arguments: [{ ...taskArgument, optional: true }],
      options: [{ names: ["--schema"], description: "Read server-defined property schemas and write permissions" }, projectOption, jsonOption, helpOption],
      details: "Provide a task ID to read its current property values, or --schema to read the server's definitions without project discovery. The task ID and --schema are mutually exclusive; --project cannot be supplied with --schema. Missing property keys remain absent. --json preserves the complete property resource or schema directory.",
    },
    {
      name: "set-property",
      description: "Set one task property using server-side value parsing and validation",
      arguments: [taskArgument, { name: "property", description: "Literal property name" }, { name: "value", description: "Raw JSON or string value text", allowEmpty: true }],
      allowOptionsTerminator: true,
      options: [versionOption, projectOption, helpOption],
      details: "Replace one complete property value and preserve every other property. The server interprets JSON and accepts direct text when the property requires a string; the CLI forwards the value unchanged. Property names are literal, not object paths. Use -- before dash-prefixed text or negative JSON numbers, placing options before the terminator. Without --if-version, read the current property resource's version before submitting. Conflicts and mutations are not retried.",
    },
    {
      name: "remove-property",
      description: "Remove one task property and omit its key from later reads",
      arguments: [taskArgument, { name: "property", description: "Literal property name" }],
      allowOptionsTerminator: true,
      options: [versionOption, projectOption, helpOption],
      details: "Delete the property record, preserving other properties. An absent key differs from an explicitly empty array or JSON null. Unknown or read-only property names are rejected by the server. Without --if-version, read the current property resource's version before submitting. Conflicts and mutations are not retried.",
    },
    {
      name: "update",
      description: "Atomically update task fields and dependencies",
      arguments: [taskArgument],
      options: [titleOption, descriptionOption, parentOption, assignedToOption,
        { names: ["--clear-assigned-to"], description: "Remove the task assignee" }, allowAgentsOption, requiredPlatformOption,
        { names: ["--clear-required-platform"], description: "Remove the execution-platform requirement" }, dependencyOption, externalDependencyOption,
        { names: ["--clear-dependencies"], description: "Clear the complete dependency set" }, tagOption,
        { names: ["--clear-tags"], description: "Clear the complete tag set" },
        versionOption,
        projectOption, helpOption],
      details: `Provide at least one changed field. --parent sets a Goal UUID or none to remove membership; omission preserves it. --assigned-to sets a project member UUID; --clear-assigned-to sends null and conflicts with setting it. Omitting both preserves the assignee. An actual assignee change disables automatic execution and is refused during in_progress; pure same-assignee updates with the current exact version preserve permission, version and timestamps. --allow-agents changes the automatic-execution permission independently of status. --required-platform sets the execution-platform requirement; --clear-required-platform removes it and conflicts with --required-platform. Omitting both platform options preserves the requirement. Actual permission or platform changes are locked during in_progress; exact-version same-value updates keep version and timestamps. Use daynight task set-status to change status.\n${dependencyDetails}\nOmitting both dependency options preserves all dependencies and classifications. --clear-dependencies clears both sets and conflicts with either dependency option.\nRepeat --tag to replace the complete tag set; --clear-tags clears it and conflicts with --tag. Omitting both preserves tags.\nWithout --if-version, read the current version before submitting the update. Conflicts and uncertain mutations are not retried.`,
    },
    {
      name: "tag",
      description: "Add or remove one Task or Goal tag",
      options: [helpOption],
      commands: ["add", "remove"].map(name => ({
        name,
        description: `${name === "add" ? "Add" : "Remove"} one tag association`,
        arguments: [taskArgument, { name: "tag-id", description: "Tag UUID" }],
        options: [versionOption, projectOption, helpOption],
        details: "Read the current Task and submit its complete tag set in one version-conditional PATCH. An explicit --if-version must match the read and is submitted unchanged; without it, use the read version. Adding an existing tag or removing an absent tag still checks the version. Conflicts and uncertain mutations are not retried; read the Task to reconcile an unknown outcome.",
      })),
    },
    {
      name: "set-status",
      description: "Set a task to proposed, todo, in_progress, done, or cancelled",
      arguments: [taskArgument, { name: "status", description: "Target task status", choices: taskStatuses }],
      options: [claimOption, { names: ["--force"], description: "Skip the Goal impact confirmation" }, versionOption, projectOption, helpOption],
      details: "Ordinary Task status values do not impose an approval sequence; proposed may move directly to in_progress or done. Every direct prerequisite must be done or cancelled when entering in_progress or done. Reopening done work is refused while a direct successor is in_progress or done. Cancellation does not require satisfied prerequisites and cannot be reversed for an ordinary Task. An active worker must be released before cancellation; release clears current ownership and leaves Session history readable.\nGoal supports todo, in_progress, done and cancelled. Completing or cancelling a Goal preserves its Tasks' statuses and excludes new automatic claims; existing claims continue. The CLI reads the target and requires interactive confirmation or --force for these Goal changes. --force only skips this confirmation, not server rules.\nA current-version same-status request preserves all stored fields; a stale version still conflicts. For ordinary Tasks, entering in_progress starts a new execution interval; returning to proposed or todo clears it; direct proposed or todo to done records an unknown duration. Cancellation preserves execution timestamps and records cancelledAt; task records and materials remain readable. Use --claim-id with done to complete an explicitly identified active worker claim as its current owner. The claim is never inferred from the task or environment.\nThe target is read even with --if-version; the supplied exact version is submitted unchanged. Without it, the read version is used. Conflicts and mutations are not retried.",
    },
    {
      name: "delete",
      description: "Soft-delete a task while preserving its stored data and attachments",
      arguments: [taskArgument],
      options: [{ names: ["--remove-depends"], description: "Remove other tasks' ordinary and external dependencies on this task atomically with deletion" }, { names: ["--force"], description: "Skip the Goal impact confirmation" }, versionOption, projectOption, helpOption],
      details: "Deleted Tasks disappear from normal queries and cannot be read or changed. Stored task data, its own prerequisite references, and attachments are retained. Without --remove-depends, ordinary Task deletion is refused if an undeleted task depends on the target. With --remove-depends, explicitly authorize removing all other tasks' ordinary and external dependencies on the target in the same transaction as soft deletion; affected tasks may become ready. An active worker claim on an ordinary Task prevents deletion.\nDeleting a Goal makes it and all its Tasks invisible without removing their Goal membership. Running Tasks stop through the existing process after a subsequent successful observation. Goal deletion requires interactive confirmation or --force; --force only skips the confirmation, and --remove-depends is not applicable to Goals.\nThe target is read even with --if-version; the supplied exact version is submitted unchanged. Without it, the read version is used. Conflicts and mutations are not retried. An interrupted deletion may already have taken effect; read the task to reconcile before considering another request.",
    },
    {
      name: "graph",
      description: "Show a task's complete chain and direct external prerequisites",
      arguments: [taskArgument],
      options: [{ names: ["--depends-only"], description: "Print only task IDs and complete dependency sets" }, projectOption, jsonOption, helpOption],
      details: "Include every task connected through ordinary dependencies, in either direction and in every status, plus the chain members' direct external prerequisites. Do not expand those external tasks or include external dependents. Each node includes its Session observation and member/external relation. sessionSummary aggregates in-progress members only; its observedAt is independent of the graph snapshot time.\n--depends-only does not request Session observations. It preserves the same task set and prints only id, dependsOn and externalDependsOn with complete UUIDs and dependency references, including references outside the returned task set. With --json, print an array containing only those three fields; otherwise print three labeled lines per task.",
    },
    {
      name: "step",
      description: "Read and maintain task-owned Steps independently from Sessions",
      options: [helpOption],
      commands: [
        {
          name: "list",
          description: "Read every Step in its saved order",
          arguments: [taskArgument],
          options: [projectOption, jsonOption, helpOption],
          details: "Display the parent task version, total count, full Step IDs, statuses and titles. --json preserves the complete collection, including every Markdown description and timestamp. No paging or filtering is applied.",
        },
        {
          name: "show",
          description: "Read one Task-local Step and its complete Markdown description",
          arguments: [taskArgument, { name: "step-id", description: "Exactly eight hexadecimal characters, case-insensitive" }],
          options: [projectOption, jsonOption, helpOption],
          details: "Read only the specified Step under this Task. Preserve its full title, description, status and content timestamps; --json returns the complete item resource and exact parent version.",
        },
        {
          name: "add",
          description: "Add one independent Step and return the complete confirmed collection",
          arguments: [taskArgument],
          options: [
            { ...titleOption, description: "Step title, preserving its original text", required: true },
            { ...descriptionOption, description: "Step Markdown description; omitted means empty" },
            { names: ["--status"], description: "Initial Step status: todo, in_progress, done or skipped (default: todo)", value: { name: "status", kind: "text", choices: ["todo", "in_progress", "done", "skipped"] } },
            { names: ["--id"], description: "Task-local eight-hex ID (default: UUIDv4 first segment)", value: { name: "step-id", kind: "text" } },
            { names: ["--before"], description: "Insert immediately before this Task-local Step", value: { name: "step-id", kind: "text" } },
            { names: ["--after"], description: "Insert immediately after this Task-local Step", value: { name: "step-id", kind: "text" } },
            versionOption, projectOption, jsonOption, helpOption,
          ],
          details: "Without an anchor, append to the saved order. --before and --after are mutually exclusive. Same titles create independent records; an existing ID is a conflict and is never regenerated or retried. Without --if-version, read the current Steps version before one POST. An explicit project/version performs one POST without parent pre-reads. Unknown results retain the original ID and request UUID; at most one same-operation read observes current facts, never historical attribution or a retry. --json prints only the complete confirmed collection.",
        },
        {
          name: "update",
          description: "Update a Step title or description and return the complete confirmed collection",
          arguments: [taskArgument, { name: "step-id", description: "Exactly eight hexadecimal characters, case-insensitive" }],
          options: [
            { ...titleOption, description: "Replace the Step title, preserving its original text" },
            { ...descriptionOption, description: "Replace the Step Markdown description; an empty string clears it" },
            versionOption, projectOption, jsonOption, helpOption,
          ],
          details: "Provide --title or --description, or both for one atomic update. Omitted fields keep their values. Titles require at least one non-Unicode-White_Space character; text is never trimmed. Status uses the separate set-status command. Without --if-version, read complete Steps before one PATCH; an explicit project/version performs one PATCH without pre-reads. Same values are no-op, but stale versions still conflict. Success returns the complete confirmed collection; unknown results preserve the original identity and request UUID with no replay.",
        },
        {
          name: "set-status",
          description: "Set a Step to todo, in_progress, done or skipped",
          arguments: [taskArgument, { name: "step-id", description: "Exactly eight hexadecimal characters, case-insensitive" }, { name: "status", description: "Target Step status", choices: ["todo", "in_progress", "done", "skipped"] }],
          options: [versionOption, projectOption, jsonOption, helpOption],
          details: "Any of the four Step states may be set directly, independently from Task status or other Steps. Same status is no-op, but stale versions still conflict. Without --if-version, read complete Steps before one PUT; an explicit project/version performs one PUT without pre-reads. --json prints only the complete confirmed collection. Unknown results preserve the original identity and request UUID with no replay.",
        },
        {
          name: "move",
          description: "Move one Step and return the complete confirmed collection",
          arguments: [taskArgument, { name: "step-id", description: "Exactly eight hexadecimal characters, case-insensitive" }],
          options: [
            { names: ["--before"], description: "Move immediately before another Task-local Step", value: { name: "step-id", kind: "text" } },
            { names: ["--after"], description: "Move immediately after another Task-local Step", value: { name: "step-id", kind: "text" } },
            { names: ["--first"], description: "Move to the beginning of the saved order" },
            { names: ["--last"], description: "Move to the end of the saved order" },
            versionOption, projectOption, jsonOption, helpOption,
          ],
          details: "Exactly one of --before, --after, --first or --last is required. Anchors must be another Step in the same Task. Moving to the current position is a no-op; all Step content and timestamps remain unchanged. Without --if-version, read complete Steps before one PUT; an explicit project/version performs one PUT without pre-reads. A confirmed resource must match the requested position and no-op/+1 version. Unknown results retain original identities and request UUID; at most one correlated read observes current facts, without replay. --json prints only the complete confirmed collection.",
        },
        {
          name: "delete",
          description: "Delete one Step and return the complete confirmed remaining collection",
          arguments: [taskArgument, { name: "step-id", description: "Exactly eight hexadecimal characters, case-insensitive" }],
          options: [versionOption, projectOption, jsonOption, helpOption],
          details: "Remove the specified Task-local record in any Step status. Referenced attachments, PRs and other materials remain. There is no history or restore command. Without --if-version, read the current Steps version before one JSON DELETE. An explicit project/version performs one DELETE without parent pre-reads. Success requires parent version +1 and target absence; --json prints only the complete confirmed remaining collection, including steps: [] after the last deletion. Unknown results preserve the original identity and request UUID; at most one same-operation read reports current facts without attributing absence to this request or replaying it.",
        },
      ],
      details: "Without --project, resolve the current Git origin. An explicit project UUID avoids project or Task pre-reads and works outside a repository. Step IDs are Task-local eight-character identities, not prefixes or display numbers. Run daynight task step <command> --help for usage.",
    },
    {
      name: "thread",
      description: "Read and append immutable task discussion messages",
      options: [helpOption],
      commands: [
        {
          name: "read",
          description: "Read one bounded page of complete messages, oldest first",
          arguments: [taskArgument],
          options: [
            { names: ["--before-id"], description: "Read messages before this task-local message UUID", value: { name: "message-id", kind: "text" } },
            { names: ["--after-id"], description: "Read messages after this task-local message UUID", value: { name: "message-id", kind: "text" } },
            { names: ["--count"], description: "Maximum messages, from 1 to 100 (default: 20)", value: { name: "count", kind: "text" } },
            { names: ["--details"], description: "Include verified Agent execution provenance" }, projectOption, helpOption,
          ],
          details: "Without a boundary, read the latest page. --before-id and --after-id are mutually exclusive. Return one page, bounded to 256 KiB of readable text, with complete bodies. Continue history with the first displayed Id; continue after with the last displayed Id. An empty page preserves the supplied boundary. Messages are never partially printed. Text options accept --option=value.",
        },
        {
          name: "post",
          description: "Append one message with optional same-task reply and Agent provenance",
          arguments: [taskArgument],
          options: [
            { names: ["--body"], description: "Complete message body, preserving whitespace", value: { name: "text", kind: "text" }, required: true },
            { names: ["--reply-to"], description: "Reply to this task-local message UUID", value: { name: "message-id", kind: "text" } },
            { names: ["--claim-id"], description: "Identify this account's active Agent claim; never inferred", value: { name: "claim-id", kind: "text" } }, projectOption, helpOption,
          ],
          details: "Without --claim-id, post as the authenticated account with Agent=false. The service validates any supplied claim. Use --body=--text for dash-prefixed text. Preserve the original body until the result is known. An interrupted or invalid response may leave the outcome unknown; read the thread before explicitly sending again. Every new post appends a new message. No automatic retries. A post receipt cannot advance a continuous read position. Posting does not change task state or trigger execution.",
        },
      ],
      details: "Message IDs are interpreted within the selected task. Without --project, resolve the current Git origin. Run daynight task thread <command> --help for usage.",
    },
    {
      name: "attachment",
      description: "Manage files attached to a task",
      commands: [
        {
          name: "put",
          description: "Upload one local regular file, replacing the same attachment path",
          arguments: [taskArgument, { name: "file", description: "Local regular file to upload" }],
          options: [{ names: ["--path"], description: "Attachment relative path (default: source basename)", value: { name: "relative-path", kind: "text" } }, projectOption, helpOption],
          allowOptionsTerminator: true,
          details: "Infer the content type from the attachment path. Unknown extensions use application/octet-stream.\nUse -- before a file name starting with a dash, or --path=value for a dash-prefixed target path. Writes are not retried; an interrupted operation may already have taken effect.",
        },
        {
          name: "list",
          description: "List every attachment and its metadata",
          arguments: [taskArgument],
          options: [{ names: ["--tree"], description: "Display attachment paths as a directory tree" }, projectOption, jsonOption, helpOption],
          details: "Read every page before printing. --tree and --json are mutually exclusive.",
        },
        {
          name: "read",
          description: "Write the attachment's original bytes to stdout",
          arguments: [taskArgument, { name: "relative-path", description: "Complete attachment relative path" }],
          options: [projectOption, helpOption],
          allowOptionsTerminator: true,
          details: "Output contains only the original bytes, with no labels or extra newline. Diagnostics go to stderr.\nA failed read may leave incomplete content on stdout. Use -- before a path starting with a dash.",
        },
        {
          name: "remove",
          description: "Remove one attachment by its complete relative path",
          arguments: [taskArgument, { name: "relative-path", description: "Complete attachment relative path" }],
          options: [projectOption, helpOption],
          allowOptionsTerminator: true,
          details: "Use -- before a path starting with a dash. Deletes are not retried; an interrupted operation may already have taken effect.",
        },
      ],
      options: [helpOption],
      details: "Paths are case-sensitive, use / separators, and preserve Unicode spelling.\nWithout --project, resolve the current Git origin to its project.\nRun daynight task attachment <command> --help for command usage.",
    },
  ],
  options: [helpOption],
  details: "Without --project, resolve the current Git origin to its project using the repository binding.\nText options also accept --option=value; use this form for values starting with a dash.\nServer: https://daynight.cc (optional serverUrl override in DN_CONFIG_DIR/config.yml (default: ~/.daynight/config.yml))\nRun daynight task <command> --help for command usage.",
};
