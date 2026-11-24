# Worker operations

Writes require [write safety](write-safety.md). Use `daynight worker --help` and
subcommand help for setup, execution and management. Worker observations and Task
status are separate; an active claim identifies execution, not extra authority.
Determine assignment from the Task, Worker, claim, worktree and original runtime,
not status or directory alone.

Current execution monitoring uses direct POST with fresh observations; it does not
read or replay an earlier snapshot. Deploy a compatible Server before upgrading a
Worker. A monitoring failure does not establish that execution or cleanup stopped.

## Legacy Bot storage migration

Explicitly authorized migration moves one stopped original Bot's Worker and
Controller records into its dedicated directory. Stop the original Worker and
assistant execution first; unknown process state or an occupied lock refuses
migration rather than terminating a process.

```bash
daynight worker migrate-bot <bot-id> --confirm
daynight worker migrated-bot-history <bot-id> --json
```

The command verifies the configured service, authenticated account, original
Worker and Bot. It snapshots committed SQLite/WAL data and owned resources,
retaining original tickets, Session IDs and unresolved operations. Durable
phases and the source transaction's receipt distinguish copied data from a
committed transfer. After an interruption, inspect the original result and
identity before continuing the same migration; do not create a replacement Bot.

Local completion leaves recovery registration pending. It grants no remote
execution authority and proves no Provider resume. The history command reads
the verified copy without starting an Agent. Source evidence, ordinary working
directories and shared Provider homes are not implicitly deleted.

## Tool path configuration

Worker-level choices cover `codex` and `copilot`; they do not configure
independent Controllers, other Workers or the Agent's own command aliases.
Identify the intended Worker, machine and service before changing a path.

Before cloud adoption, edit `worker.toolPaths` in the Worker's `config.yml`
under its absolute `DN_CONFIG_DIR` (default `~/.daynight`). Preserve the other
settings. For example, on macOS:

```yaml
worker:
  toolPaths:
    codex: /Users/example/.nvm/versions/node/v24.22.1/bin/codex
    copilot: null
```

Each value is an absolute file path on the Worker machine, or `null` for automatic
discovery. Omitting a tool or the mapping also means automatic; an empty string
and `toolPaths: null` are invalid. Paths retain spaces and punctuation. They do
not expand `~` or environment variables, execute shell text or accept appended
arguments. Windows requires a drive-qualified or complete UNC path; use YAML
single quotes for backslash paths. Native arguments keep their existing settings.

The first tool-path-capable cloud exchange imports each unadopted local choice;
an explicit choice already saved in the cloud wins. Afterwards use **My Workers →
the intended Worker → Configuration → Tool launch paths**. Expand the section, edit a
path and use the panel's normal Save or Cancel action. **Restore automatic** is
explicit: clearing the input is not a reset. Cloud automatic discovery does not
reactivate an old local path. Editing local YAML after adoption does not replace
the cloud target. A service using the older tool-path protocol requires an upgrade.

Tool paths are editable only when the service and Worker report support. A
previously supported Worker may be offline while a cloud target is saved; it has
not applied that target yet. Preserve unrelated drafts. On a conflict, read the
current configuration and reconsider the edit. For an unknown save result, use
the panel's result query before deciding on another write; do not replay Save.
There is no `daynight config` or `daynight worker config` command for this edit.

### Automatic sources and Node

| Tool and execution mode | Automatic source |
| --- | --- |
| Codex | Captured Worker command environment (`PATH`) |
| Copilot, Web Tasks and Worker assistants | Runtime bundled with this Daynight installation |

An explicit path selects that installation and never silently falls back to
`PATH` or the bundled runtime. Version/capability checks and execution use the
same verified selection. Web Copilot still uses Daynight's SDK and requires a
compatible external runtime. After adopting the cloud target, the Worker checks
both configured tool choices within bounded operations, even when current work
does not use one of them. Successful checks are reused; failed checks retain their
actual errors during retry backoff. A failure does not establish failure of
unrelated tools or Provider availability. Overall configuration success still
requires current applied evidence for both editable tools. These checks do not
start a task or replace demand-based Provider capability discovery.

Native executables, symlinks, supported Node entries and recognized npm shims
are resolved on the Worker. npm shim text is inspected, not run as shell code;
unsupported wrappers require their native executable or supported Node entry.
Selecting a CLI under an nvm directory does not switch the Worker's Node or select
the Node beside that CLI. Node entries use the frozen Worker Node executable;
inspect `interpreterPath` to confirm it. Official Copilot npm entries resolve
their own installation's native runtime. A supported Web Copilot runtime profile
may report a private JS entry and Node interpreter while retaining the selected
source path; these are distinct facts, not interchangeable paths.

## Observe and troubleshoot tool paths

```bash
daynight worker list --json
daynight worker show <worker-id> --json
```

These commands read the configured service; they do not start or attach to a
Worker. Confirm its machine/platform and report time. In the JSON result inspect
`worker.telemetry.toolPaths.entries`, selecting both `tool` and `context`
(`web`). The same facts appear in the configuration panel and software
details, where complete paths can be expanded and copied.

| Report field | Meaning |
| --- | --- |
| `configurationSource`, `targetRevision`, `target` | Local/cloud authority and the reported target; cloud revision must match the current saved desired revision |
| `state`, `reason`, `error` | Application state and its failure or waiting reason; saving alone does not establish `applied` |
| `actual` | Verified selection for new execution admission; an older value can remain visible when a new target fails |
| `candidate` | Inspected target awaiting safe application, not an applied selection |
| `activeSelections` | Grouped original selections still running or awaiting confirmed stopping, with execution/instance/unconfirmed counts |
| `activeSelectionsComplete`, `activeSelectionCount`, `activeObservationError` | Whether the bounded active inventory is complete; omitted groups or an unknown count cannot prove no old execution remains |

For each actual selection compare `selection`, `entryPath`, `executablePath`,
`interpreterPath`, `source`, `version` and `checkedAt`. Source is `explicit`,
`path` or `bundled`. Confirm the correct tool/context, current cloud target and
revision, matching `actual.selection` and `state=applied` before describing a
target as applied. Offline/stale reports, missing capability, `not_checked`, a
candidate or a standalone version result are insufficient. Keep the saved target
and last reported actual path/version separate.

| Observation | Next check |
| --- | --- |
| `not_found`, `invalid_path` | Check the complete absolute file path on the Worker machine and its actual configuration source; do not test it on the server |
| `permission_denied`, `not_executable` | Check the selected file and required interpreter's accessibility and executable format/permissions |
| `unsupported_launcher` | Select a supported native/Node entry instead of an arbitrary shell, batch or PowerShell wrapper |
| `unrecognized_output`, `incompatible_runtime` | Verify this installation's tool identity, version and required protocol; a filename alone is not proof |
| `probe_timeout`, `cleanup_unknown` | Preserve the original probe/process responsibility; inspect its error and stopping evidence before another attempt |
| Missing `toolPaths` | Check service/Worker support and report freshness; do not infer an automatic path |

A failed explicit target blocks new executions needing that tool; it does not
authorize fallback or stopping healthy old executions. Changing paths cannot
erase unconfirmed cleanup. Verify the actual active groups and retained process
responsibilities.

### Existing execution and recovery

New executions freeze their selected files and interpreter, including automatic
choices. Target/PATH edits affect later executions; they do not restart an old
Session, release its claim or replace its worktree. Recovery and retry
keep the original selection and identity. Replacing a file or symlink can produce
`tool_identity_changed`: restore the matching installation if recovery is needed;
the new configured path cannot substitute for it. Daynight does not archive every
old installed binary. Existing live-process input, stop and archive operations
retain the original process identity.

Frozen verification covers the recipe's recorded files. A Codex JavaScript loader
chooses its native program dynamically; a new recipe does not fingerprint that
downstream program by reconstructing its installation layout.

Old submitted records without a frozen identity report
`legacy_tool_identity_missing` and cannot spawn a replacement. A provably
never-submitted legacy ticket may acquire its first immutable selection without
replaying initial input. Missing native identity or unknown input/stop results
are not permission to create another Session, repeat input or delete local
ownership records. Before an authorized `worker retry` or `worker release`, stop
the corresponding runner and follow that command's help and original-claim
conditions; neither is a tool-path reset.

### Retained resource recovery

A retained Git marker does not identify the Worker or prove that its original
execution stopped. Current monitoring preserves its occupied slot and reports
the claim and Project-relative worktree. Do not delete its database, raise the
concurrency limit or use `worker retry` to hide the reservation.

For an original completed Web execution whose full journals remain available,
stop the corresponding `worker run`, then preview recovery under its original
Worker lock:

```bash
daynight worker resources recover <task-id> --project <project-id> --claim-id <claim-id>
daynight worker resources recover <task-id> --project <project-id> --claim-id <claim-id> --confirm
```

The second command rechecks the exact service, authenticated owner, Worker,
terminal claim, worktree binding, original native stop and ready archive receipt
before removing the worktree without force and retiring its manifest. It preserves
the branch and execution journals. Optional `--worktree-id` adds an exact identity
check; omission reads the original journal and still verifies the unique Git
binding. Modified, untracked or ignored files, index flags that hide changes and
commits with no observed remote
reference block removal; preserve those files and commits before making a new
decision. Unknown removal results require inspecting the original worktree and
manifest before another attempt.

Missing journals, a successor claim or another Worker never authorize adoption.
Restore the original Worker and Controller journals from backup; a completed Task,
missing process or Git marker cannot replace them. Unfinished Web executions use
normal Worker reconciliation after their original evidence is restored. Successful
observation clears repaired monitoring failures; recovery does not create a new execution.

## Repair stopped Markdown image projections

On the original Worker machine, use an explicitly authorized repair for the
retained terminal Web execution:

```bash
daynight worker repair-markdown <task-id> --project <project-id> --claim-id <claim-id> --session-id <session-id> --worktree-id <worktree-id>
```

The command checks the signed-in owner, service, terminal Task, completed original
claim, Session, Worker configuration, launch ticket and actual managed worktree.
A blocked Task, changed identity or unconfirmed original stop prevents repair.
It uses the stopped Controller storage permit and can run beside the Worker;
it does not take over scheduling, start an Agent or replay user input.

Only preserved complete, nontruncated inputs with trusted block identities can
be reanalyzed. Original text, entry order and identities, prior image references
and the original failed projection remain retained. Newly discovered images
must resolve to verified retained resources or ordinary local files inside the
original directory root. Repair does not download external URLs or follow links
outside that root. Missing files, changed roots, ambiguous blocks and analysis
failures remain explicit failures; restoring the reported original source or
context permits another attempt with the same arguments.

Successful repair continues the existing archive upload and validates its
receipt. A pending source-tail batch, history checkpoint, upload intent or receipt
selects reconciliation instead of rewriting its source. The Worker still owns
resource cleanup. Read the original
Session afterwards and distinguish a ready content archive from an archived
lifecycle. Unknown output or upload results require observing that same
execution before deciding again. Successful reanalysis does not prove the cause
of an earlier failure whose diagnostic details were not recorded.

## Pause and complete an assigned claim

A worker-managed Task may expose `blocked`; authorized changes use ordinary Task
property writes:

```bash
daynight task set-property <task-id> blocked true --project <project-id> --if-version <observed-version>
daynight task set-property <task-id> blocked false --project <project-id> --if-version <observed-version>
```

Claim-bound completion needs the original explicitly supplied claim ID;
ordinary completion has no claim:

```bash
daynight task set-status <task-id> done --project <project-id> --claim-id <claim-id> --if-version <observed-version>
```

A rejected claim-bound completion cannot fall back to ordinary completion to
bypass the claim. Lost or uncertain results require observing the original execution
before another decision. Never automatically replay or claim confirmation from
an unrelated observation.
