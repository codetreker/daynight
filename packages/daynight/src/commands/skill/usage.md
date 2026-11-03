---
name: daynight
description: Use the Daynight CLI to manage projects, tasks, dependencies, properties and attachments, and discover worker, Controller, review, update and completion commands.
---

# Daynight CLI Usage

Daynight manages projects and tasks for people and coding agents.
Use this manual for CLI operations. `daynight` and its alias `dn` accept the same
commands and options. The default service is `https://daynight.cc`.
Replace angle-bracket placeholders in examples with actual IDs or values.

## Discover Commands

```bash
daynight --version
daynight --help
daynight --skill
daynight project --help
daynight task --help
daynight task update --help
```

`--skill` prints this complete manual and accepts no other arguments.
Use a command's `--help` to inspect its supported options. A group with no
operation also prints help. Help and version options must be the sole argument
at their command level; root information options are not inherited by commands.

Successful operations exit 0. Invalid arguments exit 2 and identify the relevant
help command. Execution failures exit 1 and preserve their cause. Diagnostics
and interactive prompts go to stderr. Use `--json` only on operations that
advertise it; task and project creation return text.

## Connect and Sign In

Install the CLI with a current Node.js 22 or newer:

```bash
npm install --global @codetreker/daynight
daynight login
```

Check the terminal's code and account on the browser authorization page before
approving access. For a remote terminal, use:

```bash
daynight login --no-browser
```

The command prints the page and code without opening a browser. Service commands
require a CLI credential; `daynight logout` revokes and removes it.
Configuration uses `DN_CONFIG_DIR/config.yml`, defaulting to
`~/.daynight/config.yml`. `DN_CONFIG_DIR`, when set, must be an absolute directory.
An optional `serverUrl` selects a different service. No configuration or login is
needed to read help, the version or this manual.

## Projects

From a Git repository with an `origin` remote:

```bash
daynight project create "Example project"
daynight project list --json
daynight project show <project-id> --json
```

Creation uses the current worktree's effective origin fetch address. It returns
an existing project when exactly one has an equivalent repository address;
multiple matches require choosing the intended project by ID. An explicit
repository works outside Git:

```bash
daynight project create "Example project" --repo https://github.com/owner/repo.git
```

Task commands normally resolve the current Git origin to its project. Pass
`--project <project-id>` to a task operation to select the project explicitly,
including outside its repository. IDs are complete UUIDs.

## Create and Read Tasks

```bash
daynight task create --title "Improve installation" \
  --description "Document prerequisites and verify the setup commands."
daynight task list
daynight task list --all --json
daynight task list --status in_progress --json
daynight task ready --limit 20 --json
daynight task show <task-id> --json
```

New tasks start in `todo` with automatic execution disabled and no platform
restriction unless `--required-platform windows|linux|macos` is provided.
Creating a task does not start it. Status values are `todo`, `in_progress` and
`done`.

`task list` excludes done tasks by default and reads all matching pages. Use
`--all` for every status or `--status` for one status; they cannot be combined.
The order is in-progress tasks, ready todo tasks, blocked todo tasks, then done
tasks. Text lists omit descriptions, versions and timestamps. JSON lists omit
only descriptions; use `task show --json` for a complete task.

`task ready` reads one page, defaulting to 10 tasks; `--limit` accepts 1 through
100. A task is ready when it is todo and every prerequisite is done. Readiness
and automatic-execution permission are separate fields. Both list and ready
support `--allow-agents true|false` and
`--compatible-platform windows|linux|macos`. Filters combine with AND before
pagination. Platform filtering includes unrestricted tasks and exact matches.

```bash
daynight task list --ready --allow-agents true \
  --compatible-platform linux --json --project <project-id>
```

## Read Before Writing

Read the complete task before deciding a change and retain its exact `version`.
Supply that observed value with `--if-version` for update, status, property and
delete operations. Versions are positive decimal int64 values; preserve every
digit without rounding through a floating-point number. Reread after each write
before making another version-bound change.

```bash
daynight task show <task-id> --json
daynight task update <task-id> --title "Clarify installation" \
  --if-version <observed-version>
```

Without `--if-version`, the CLI reads the current version immediately before
submitting. That read does not protect an earlier decision. A version conflict
requires rereading and reassessing the change. Do not replace the version and
blindly replay the write. The CLI does not retry mutations.

Cancellation, timeout or a lost response can occur after a write commits.
Read back the affected fields or attachment before another write. An uncertain
creation must be reconciled before creating another task; a matching title alone
does not prove identity. Attachment operations have separate concurrency
semantics and are not protected by a task version.

## Update Fields and Status

```bash
daynight task update <task-id> --description "Updated task requirements" \
  --if-version <observed-version>
daynight task update <task-id> --description "" \
  --if-version <observed-version>
daynight task update <task-id> --allow-agents true \
  --required-platform linux --if-version <observed-version>
daynight task update <task-id> --clear-required-platform \
  --if-version <observed-version>
daynight task set-status <task-id> in_progress --if-version <observed-version>
daynight task set-status <task-id> done --if-version <observed-version>
```

`task update` requires at least one field change. An empty description clears
it. Omitted fields remain unchanged. `--required-platform` and
`--clear-required-platform` conflict. Actual permission and platform changes are
locked while the task is in progress. Automatic permission is independent of
status; use `task set-status` to change status.

Every direct prerequisite must be done before entering in_progress or done.
Reopening done work is refused while a direct successor is in_progress or done.
Returning to todo clears its execution interval. A same-status request still
checks the version.

For an explicitly identified active worker claim, its current owner can use
`task set-status <task-id> done --claim-id <claim-id> --if-version <version>`.
The CLI never infers a claim from the task or environment.

Text options accept separated values or `--option=value`. Use the inline form
for values beginning with a dash, such as `--title=-example`. Where a command
advertises `--`, place options before it to preserve dash-prefixed positional
text. Help, switches and directory options do not accept inline values.

## Dependencies and Task Graphs

Ordinary prerequisites connect tasks in one chain. External prerequisites point
to required tasks in other chains. Both kinds must be done before execution.
Supply complete UUIDs once across both sets:

```bash
daynight task create --title "Implement configuration" \
  --depends-on <ordinary-prerequisite-id> \
  --external-depends-on <external-prerequisite-id>
daynight task update <task-id> \
  --depends-on <ordinary-prerequisite-id> \
  --external-depends-on <external-prerequisite-id> \
  --if-version <observed-version>
daynight task update <task-id> --clear-dependencies \
  --if-version <observed-version>
daynight task graph <task-id> --json
daynight task graph <task-id> --depends-only --json
```

Repeat each dependency option for multiple prerequisites. Supplying either
option replaces the entire dependency set and every classification: include all
ordinary and external prerequisites to retain. Omitting both options during
update preserves them. `--clear-dependencies` clears both sets and conflicts
with either dependency option.

`task graph` requires a task ID. It returns the complete component connected by
ordinary dependencies in either direction, plus each chain member's direct
external prerequisites. External tasks are not expanded. `--depends-only`
preserves the same task set and outputs only `id`, `dependsOn` and
`externalDependsOn`; dependency references can point outside the returned set.

## Properties

Ask the server for definitions before writing unfamiliar properties:

```bash
daynight task properties --schema --json
daynight task properties <task-id> --json
daynight task set-property <task-id> pullRequests \
  '[{"url":"https://github.com/owner/repo/pull/123","title":"Clarify installation"}]' \
  --if-version <observed-version>
daynight task set-property <task-id> paused true --if-version <observed-version>
daynight task remove-property <task-id> pullRequests --if-version <observed-version>
```

`--schema` reads server-defined types and write permissions without project
selection. It cannot be combined with a task ID or `--project`.
Property names are literal keys, not object paths. The server parses JSON or,
for string properties, accepts direct text. `set-property` forwards the value
unchanged, replaces that complete property and preserves other keys. Preserve
all existing pull request entries when updating the `pullRequests` array.
`paused` is a boolean property; `worker` is read-only. Unknown and read-only
properties are rejected.

`remove-property` deletes the key. Absence, an empty array and JSON null are
distinct; null is valid only when the property's schema permits it. Set and
remove accept `--project` and `--if-version`; they do not provide `--json`.
For a dash-prefixed property or value, put options first and then `--` before
the positional arguments.

## Attachments

```bash
daynight task attachment put <task-id> ./design.md --path docs/design.md
daynight task attachment list <task-id> --tree
daynight task attachment list <task-id> --json
daynight task attachment read <task-id> docs/design.md > ./downloaded-design.md
daynight task attachment remove <task-id> docs/design.md
```

Put uploads one local regular file and replaces the same attachment path. The
default target is its source basename; content type is inferred from the target
extension. Paths are case-sensitive, use `/`, preserve Unicode spelling and
remain relative to the task attachment root. Empty, dot or parent segments,
backslashes and control characters are invalid. `--tree` and `--json` conflict.

Read writes only the original bytes to stdout, with no label or added newline.
A failed read can leave a partial file after redirection; check the exit code.
All attachment operations accept `--project`. They do not accept `--if-version`,
and attachment writes do not change the task version. After an uncertain upload
or removal, list and read back the actual resource before another mutation.

## Delete a Task

```bash
daynight task delete <task-id> --if-version <observed-version>
daynight task delete <task-id> --remove-depends --if-version <observed-version>
```

Deletion hides the task from normal queries while retaining its stored data and
attachments. Deleted tasks cannot be read or changed. Dependents prevent
deletion unless `--remove-depends` is supplied; this option removes other tasks'
ordinary and external edges to the target in the same transaction and may make
them ready. An active worker claim always prevents deletion. Confirm the target
and affected dependencies before using this operation.

## Install the Task Workflow Skill

```bash
daynight skill install
```

Use an interactive terminal to select detected Codex, Copilot CLI or Claude Code
installations, then User or Project scope. Installation replaces the selected
`using-daynight` directories, including local edits and stale files. Follow the
printed reload instructions. That skill provides task orchestration workflows;
this manual provides command use.

## Workers and Controller Sessions

```bash
daynight worker setup
daynight worker repo add --project <project-id>
daynight worker repo list --json
daynight worker repo remove --project <project-id>
daynight worker run
daynight worker attach
```

Worker setup checks prerequisites and selects an agent and existing accessible
Projects in an interactive terminal. Repository changes apply at the next worker
startup. `worker run` stays in the foreground; Ctrl+C stops its original agents
while retaining unfinished claims, worktrees and native history. `worker attach`
opens the running worker's private Herdr session from an interactive terminal;
detaching leaves execution running. Use `worker --help` and each operation's help
for configuration and manual control requirements.

Stop the runner before managing one recorded claim:

```bash
daynight worker retry <task-id> --claim-id <claim-id>
daynight worker release <task-id> --claim-id <claim-id> --if-version <observed-version>
daynight worker resume <task-id> --claim-id <released-claim-id> --if-version <observed-version>
```

Release returns the original claim's task to todo; resume starts a released task
as a fresh execution. Retry attempts one recovery for an active claim. Keep the
original claim ID and use each command's help before acting on an interrupted
execution.

Run an independent browser-controlled Test Session in the current directory:

```bash
daynight controller codex "Explain this project"
daynight controller claude
daynight controller copilot
daynight controller codex resume <test-session-id>
```

The printed Daynight page requires login; native provider credentials are also
required. The current directory is used as-is. Ctrl+C stops the owned execution.
Resume continues saved native context; noninteractive resume requires its ID.
Use the provider command's help for model, effort and permission options.

## Review, Updates and Shell Completion

```bash
daynight review add-repo https://github.com/owner/repo.git --path ./review-clone
daynight review list
daynight review run
daynight update
```

Review requires Git, authenticated GitHub CLI and Copilot CLI. Add-repo registers
the repository; `review list` (also `review ls`) reads recorded status;
`review run` monitors pull requests in the foreground until interrupted.
`--path` is a directory option and does not accept `--path=value`.

Update operates on the current npm global installation. It refreshes existing
User and current-worktree `using-daynight` copies even when the CLI version is
already current, replacing their local edits. It leaves missing skills
uninstalled. Use the original package manager for other installation types.
Restart running CLI services to use newly installed code.

```bash
daynight completion setup
daynight completion setup --shell bash --rc-file ~/.bashrc
source <(daynight completion bash)
```

Setup installs Bash or zsh startup configuration. Script generation alone does
not modify startup files. Bash requires version 4.2 or newer. For zsh, initialize
its completion system before loading the script:

```zsh
autoload -Uz compinit
compinit
source <(daynight completion zsh)
```

Use `daynight completion setup --help` for shell selection and startup-file
options. The generated completion registers both `daynight` and `dn`.
