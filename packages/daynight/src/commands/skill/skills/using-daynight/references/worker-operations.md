# Worker operations

For writes, also read [write safety](write-safety.md).

Use `daynight worker --help` and its subcommand help for setup, execution and
management. Worker observations and task status are separate; an active claim
identifies the execution and does not by itself grant additional authority.

A worker-managed Task may expose the `paused` property. With the necessary
authority and the exact Task version observed for the decision, set or clear it:

```bash
daynight task set-property <task-id> paused true --project <project-id> --if-version <observed-version>
daynight task set-property <task-id> paused false --project <project-id> --if-version <observed-version>
```

For claim-bound completion, use the original explicitly supplied claim ID and
version observed for that decision:

```bash
daynight task set-status <task-id> done --project <project-id> --claim-id <claim-id> --if-version <observed-version>
```

Ordinary completion has no claim; a rejected claim-bound completion cannot be
converted to ordinary completion to bypass the claim. A lost or uncertain result
must be reconciled by observing the original execution before any further decision;
do not automatically replay it or claim confirmation from an unrelated observation.
The Task, Worker, claim, worktree and original runtime determine the actual
assignment; inspect them rather than inferring it from a status or directory.
