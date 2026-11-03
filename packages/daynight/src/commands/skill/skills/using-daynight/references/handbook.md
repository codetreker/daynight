# CLI handbook

Use the installed `daynight` CLI.
This file maps command entry points; consult that version's `--help` for arguments, defaults, and option combinations.

## Find help

```bash
daynight --version
daynight --help
daynight task --help
daynight task update --help
daynight task attachment put --help
```

Navigate from top-level help down to the required command.
Do not treat this skill's workflow names as CLI commands or infer commands from field names.

## Command map

| Purpose | Command entry points | Guidance |
| --- | --- | --- |
| Sign in or out | `login`, `logout` | [Setup](setup.md) |
| Shell completion | `completion setup` | [Setup](setup.md) |
| Create, list, or inspect projects | `project create`, `project list`, `project show` | [Project management](project-management.md) |
| Query tasks | `task list`, `task ready`, `task show` | [Task management](task-management.md#task-queries) |
| Read task dependency graphs | `task graph <task-id>` | [Verify dependency changes](task-management.md#verify-dependency-changes) |
| Create tasks | `task create` | [Create task](create-task.md) |
| Change metadata | `task update` | [Task management](task-management.md#metadata) |
| Read property values or definitions | `task properties` | [Properties](task-management.md#properties) |
| Set or remove task properties | `task set-property`, `task remove-property` | [Properties](task-management.md#properties) |
| Change status | `task set-status` | [Task management](task-management.md#status-and-timing) |
| Delete tasks | `task delete` | [Task management](task-management.md#task-deletion) |
| Upload, list, read, or remove attachments | `task attachment put/list/read/remove` | [Task content standard](task-content.md#attachments-and-references) |
| Set up and manage workers | `worker` | See `daynight worker --help`; for execution within an assignment, see [managed task execution](autopilot-managed-task.md). |

Follow [write safety](write-safety.md) for writes.
CLI help explains command syntax; reference files explain when to use commands, what they affect, and how to confirm outcomes.
