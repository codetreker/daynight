import type { CommandDefinition, CommandOption } from "../../cli/schema.js";

const helpOption: CommandOption = { names: ["-h", "--help"], description: "Show this help", action: "help" };
const projectOption: CommandOption = { names: ["--project"], description: "Use this project UUID for this invocation", value: { name: "project-id", kind: "text" } };
const jsonOption: CommandOption = { names: ["--json"], description: "Print the complete API resource data as JSON" };
const listJsonOption: CommandOption = { names: ["--json"], description: "Print task fields except description as JSON" };
const titleOption: CommandOption = { names: ["--title"], description: "Task title", value: { name: "title", kind: "text" } };
const descriptionOption: CommandOption = { names: ["--description"], description: "Task description; an empty value clears it", value: { name: "description", kind: "text", allowEmpty: true } };
const dependencyOption: CommandOption = { names: ["--depends-on"], description: "Ordinary prerequisite UUID; repeat for the complete ordinary set", value: { name: "task-id", kind: "text" }, repeatable: true };
const externalDependencyOption: CommandOption = { names: ["--external-depends-on"], description: "External prerequisite UUID; repeat for the complete external set", value: { name: "task-id", kind: "text" }, repeatable: true };
const dependencyDetails = "Supplying either dependency option replaces every dependency and its classification. --depends-on supplies ordinary prerequisites; --external-depends-on supplies external prerequisites. External-only input keeps only those external prerequisites; ordinary-only input makes every supplied prerequisite ordinary. IDs must be valid UUIDs and occur once across both options. Both kinds block execution until completed.";
const statusOption: CommandOption = { names: ["--status"], description: "Task status", value: { name: "status", kind: "text", choices: ["todo", "in_progress", "done"] } };
const allowAgentsOption: CommandOption = { names: ["--allow-agents"], description: "Automatic-execution permission", value: { name: "true|false", kind: "text", choices: ["true", "false"] } };
const platformChoices = ["windows", "linux", "macos"] as const;
const requiredPlatformOption: CommandOption = { names: ["--required-platform"], description: "Required execution platform", value: { name: "platform", kind: "text", choices: platformChoices } };
const compatiblePlatformOption: CommandOption = { names: ["--compatible-platform"], description: "Include unrestricted tasks and tasks requiring this execution platform", value: { name: "platform", kind: "text", choices: platformChoices } };
const versionOption: CommandOption = { names: ["--if-version"], description: "Use this expected task version without reading a newer version", value: { name: "version", kind: "text" } };
const claimOption: CommandOption = { names: ["--claim-id"], description: "Complete this active worker claim; valid only with done", value: { name: "claim-id", kind: "text" } };
const pullRequestOptions: readonly CommandOption[] = [
  { names: ["--pull-request-url"], description: "PR URL text; repeat for the complete list", value: { name: "text", kind: "text", allowEmpty: true }, repeatable: true },
  { names: ["--pull-request-title"], description: "PR title text; pair by position with each URL", value: { name: "text", kind: "text", allowEmpty: true }, repeatable: true },
];
const taskArgument = { name: "task-id", description: "Task UUID" };

export const taskDefinition: CommandDefinition = {
  name: "task",
  description: "Create, query, update, and delete project tasks on the configured server",
  commands: [
    {
      name: "create",
      description: "Create a todo task with optional dependencies and PR references",
      options: [{ ...titleOption, required: true }, descriptionOption, requiredPlatformOption, dependencyOption, externalDependencyOption, ...pullRequestOptions, projectOption, helpOption],
      details: `New tasks start in todo with automatic execution disabled. Creating a task does not start execution. Without --required-platform, execution has no platform restriction. Omitting both dependency options creates a task with no prerequisites.\n${dependencyDetails}\nPR URL and title counts must match; the nth URL pairs with the nth title. Empty values are accepted, and all text is stored as supplied.`,
    },
    {
      name: "list",
      description: "List unfinished tasks, with in-progress and ready tasks first",
      options: [{ names: ["--all"], description: "Include completed tasks; conflicts with --status" }, statusOption, { names: ["--ready"], description: "Include only tasks ready to start" }, allowAgentsOption, compatiblePlatformOption, projectOption, listJsonOption, helpOption],
      details: "By default, exclude done tasks. Use --all for every status or --status for a specific status.\nCombine --ready, --allow-agents and --compatible-platform with the selected statuses using AND. Platform compatibility includes unrestricted tasks and exact matches, without changing readiness. All filters apply before pagination; read every page before printing.\nOrder in_progress first, then ready todo, blocked todo, and done tasks; preserve server order within each group.\nText lists omit description, version, and timestamps. --json omits description and preserves every other task field with the same filtering and ordering.",
    },
    {
      name: "ready",
      description: "Show the first ready tasks in the project",
      options: [{ names: ["--limit"], description: "Maximum number of tasks to return, from 1 to 100 (default: 10)", value: { name: "count", kind: "text" } }, allowAgentsOption, compatiblePlatformOption, projectOption, jsonOption, helpOption],
      details: "Read one bounded page ordered by creation time, then task UUID, ascending. A task is ready when it is todo and every dependency is done. --allow-agents and --compatible-platform combine with ready before the page limit and do not change readiness. Platform compatibility includes unrestricted tasks and exact matches.",
    },
    {
      name: "show",
      description: "Show a task by its ID",
      arguments: [taskArgument],
      options: [projectOption, jsonOption, helpOption],
    },
    {
      name: "get-properties",
      description: "Print the complete task properties resource as JSON",
      arguments: [taskArgument],
      options: [projectOption, helpOption],
      details: "Print the server response verbatim, including its decimal version string and every property. Property names, values, and future fields are not interpreted by the CLI.",
    },
    {
      name: "set-property",
      description: "Set one task property using value text interpreted by the server",
      arguments: [taskArgument, { name: "property", description: "Property path interpreted by the server", allowEmpty: true }, { name: "value", description: "Original value text sent to the server", allowEmpty: true }],
      options: [versionOption, projectOption, helpOption],
      allowOptionsTerminator: true,
      details: `The CLI sends the property name and value text without property or JSON validation. The server owns allowed names, writable fields, and value types. Use JSON values; string properties also accept raw text. For example, worker.signaling accepts both 'Needs attention' and '"Needs attention"'; an empty argument or '""' clears it.\nWithout --if-version, read the current properties resource immediately before submitting and use its version. An explicit version skips that read. Conflicts and mutations are not retried. Print the returned properties resource verbatim.\nUse -- before a property or value starting with a dash; put options before --.`,
    },
    {
      name: "remove-property",
      description: "Remove one task property using the server-defined removal behavior",
      arguments: [taskArgument, { name: "property", description: "Property path interpreted by the server", allowEmpty: true }],
      options: [versionOption, projectOption, helpOption],
      allowOptionsTerminator: true,
      details: "The CLI sends the property name without property validation. The server defines which properties can be removed and how removal affects their values.\nWithout --if-version, read the current properties resource immediately before submitting and use its version. An explicit version skips that read. Conflicts and mutations are not retried. Print the returned properties resource verbatim.\nUse -- before a property starting with a dash; put options before --.",
    },
    {
      name: "update",
      description: "Atomically update task fields, dependencies, and PR references",
      arguments: [taskArgument],
      options: [titleOption, descriptionOption, allowAgentsOption, requiredPlatformOption,
        { names: ["--clear-required-platform"], description: "Remove the execution-platform requirement" }, dependencyOption, externalDependencyOption,
        { names: ["--clear-dependencies"], description: "Clear the complete dependency set" },
        ...pullRequestOptions,
        { names: ["--clear-pull-requests"], description: "Clear the complete PR reference list" },
        versionOption,
        projectOption, helpOption],
      details: `Provide at least one changed field. --allow-agents changes the automatic-execution permission independently of status. --required-platform sets the execution-platform requirement; --clear-required-platform removes it and conflicts with --required-platform. Omitting both platform options preserves the requirement. Actual permission or platform changes are locked during in_progress; exact-version same-value updates keep version and timestamps. Use daynight task set-status to change status.\n${dependencyDetails}\nOmitting both dependency options preserves all dependencies and classifications. --clear-dependencies clears both sets and conflicts with either dependency option.\nPR URL and title counts must match; the nth URL pairs with the nth title. Pairs replace the complete list; empty values are accepted. --clear-pull-requests conflicts with either PR option. Omitted PR options preserve the current list.\nWithout --if-version, read the current version before submitting the update. Conflicts are not retried.`,
    },
    {
      name: "set-status",
      description: "Set a task to todo, in_progress, or done",
      arguments: [taskArgument, { name: "status", description: "Target task status", choices: ["todo", "in_progress", "done"] }],
      options: [claimOption, versionOption, projectOption, helpOption],
      details: "Every direct prerequisite must be done when entering in_progress or done. Reopening done work is refused while a direct successor is in_progress or done.\nA current-version same-status request preserves all stored fields; a stale version still conflicts. Entering in_progress starts a new execution interval; returning to todo clears it; direct todo to done records an unknown duration.\nUse --claim-id with done to complete an explicitly identified active worker claim as its current owner. The claim is never inferred from the task or environment. Without --claim-id, use ordinary task status setting.\nWithout --if-version, read the current version immediately before submitting. With --if-version, submit exactly that version without reading the task. Conflicts and mutations are not retried.",
    },
    {
      name: "delete",
      description: "Soft-delete a task while preserving its stored data and attachments",
      arguments: [taskArgument],
      options: [{ names: ["--remove-depends"], description: "Remove other tasks' ordinary and external dependencies on this task atomically with deletion" }, versionOption, projectOption, helpOption],
      details: "Deleted tasks disappear from normal queries and cannot be read or changed. Stored task data, its own prerequisite references, and attachments are retained. Without --remove-depends, deletion is refused if an undeleted task depends on the target. With --remove-depends, explicitly authorize removing all other tasks' ordinary and external dependencies on the target in the same transaction as soft deletion; affected tasks may become ready. An active worker claim on the target always prevents deletion.\nWithout --if-version, read the current version immediately before submitting. With --if-version, submit exactly that version without reading the task. Conflicts and mutations are not retried. An interrupted deletion may already have taken effect; read the task to reconcile before considering another request.",
    },
    {
      name: "graph",
      description: "Show the complete task graph and summary",
      options: [projectOption, jsonOption, helpOption],
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
  details: "Without --project, resolve the current Git origin to its project using the repository binding.\nText options also accept --option=value; use this form for values starting with a dash.\nServer: https://daynight.cc (optional serverUrl override in ~/.daynight/config.yml)\nRun daynight task <command> --help for command usage.",
};
