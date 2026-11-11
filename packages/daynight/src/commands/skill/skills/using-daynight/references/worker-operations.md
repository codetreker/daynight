# Worker operations

Writes require [write safety](write-safety.md). Use `daynight worker --help` and
subcommand help for setup, execution and management. Worker observations and Task
status are separate; an active claim identifies execution, not extra authority.
Determine assignment from the Task, Worker, claim, worktree and original runtime,
not status or directory alone.

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
