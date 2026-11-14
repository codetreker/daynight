# Worker operations

Writes require [write safety](write-safety.md). Use `daynight worker --help` and
subcommand help for setup, execution and management. Worker observations and Task
status are separate; an active claim identifies execution, not extra authority.
Determine assignment from the Task, Worker, claim, worktree and original runtime,
not status or directory alone.

## Tool path configuration

Worker-level choices cover `codex`, `copilot` and `herdr`; they do not configure
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
    herdr: /opt/homebrew/bin/herdr
```

Each value is an absolute file path on the Worker machine, or `null` for automatic
discovery. Omitting a tool or the mapping also means automatic; an empty string
and `toolPaths: null` are invalid. Paths retain spaces and punctuation. They do
not expand `~` or environment variables, execute shell text or accept appended
arguments. Windows requires a drive-qualified or complete UNC path; use YAML
single quotes for backslash paths. Native arguments keep their existing settings.

The first tool-path-capable cloud exchange imports each unadopted local choice;
an explicit choice already saved in the cloud wins. Afterwards use **My Workers →
the intended Worker → Configuration → Tool paths**. Expand the section, edit a
path and use the panel's normal Save or Cancel action. **Restore automatic** is
explicit: clearing the input is not a reset. Cloud automatic discovery does not
reactivate an old local path. Editing local YAML after adoption does not replace
the cloud target. An older service without this capability retains local choices.

Tool paths are editable only when the service and Worker report support. A
previously supported Worker may be offline while a cloud target is saved; it has
not applied that target yet. Preserve unrelated drafts. On a conflict, read the
current configuration and reconsider the edit. For an unknown save result, use
the panel's result query before deciding on another write; do not replay Save.
There is no `daynight config` or `daynight worker config` command for this edit.

### Automatic sources and Node

| Tool and execution mode | Automatic source |
| --- | --- |
| Codex, Web or Herdr | Captured Worker command environment (`PATH`) |
| Copilot, Web Tasks and Worker assistants | Runtime bundled with this Daynight installation |
| Copilot, Herdr | Captured Worker command environment (`PATH`) |
| Herdr | Captured Worker command environment (`PATH`) |

An explicit path selects that installation and never silently falls back to
`PATH` or the bundled runtime. Version/capability checks and execution use the
same verified selection. Web Copilot still uses Daynight's SDK and requires a
compatible external runtime. An unused automatic tool can remain unchecked;
that does not establish failure of unrelated tools or Provider availability.

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
(`web` or `herdr`). The same facts appear in the configuration panel and software
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
| `pending` with `active_instance` or `cleanup_unconfirmed` | Inspect the old Herdr instance and its remaining responsibilities; do not kill it merely to apply a target |
| Missing `toolPaths` | Check service/Worker support and report freshness; do not infer an automatic path |

A failed explicit target blocks new executions needing that tool; it does not
authorize fallback or stopping healthy old executions. Changing paths cannot
erase unconfirmed cleanup. On macOS, Herdr's per-run instances can keep old and
new selections concurrently. Linux/Windows shared instances wait until the old
daemon, endpoints and process responsibilities are confirmed closed before
switching. Verify actual groups rather than assuming one topology on every OS.

### Existing execution and recovery

New executions freeze their selected files and interpreter, including automatic
choices. Target/PATH edits affect later executions; they do not restart an old
Session, release its claim or replace its worktree. Recovery, retry and attach
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

## Pause and complete an assigned claim

A worker-managed Task may expose `paused`; authorized changes use ordinary Task
property writes:

```bash
daynight task set-property <task-id> paused true --project <project-id> --if-version <observed-version>
daynight task set-property <task-id> paused false --project <project-id> --if-version <observed-version>
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
