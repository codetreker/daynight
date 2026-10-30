---
name: using-daynight
description: Manage projects, tasks, attachments, and Goals with the Daynight CLI; create tasks, execute a specified task, or review a handoff. Use only when explicitly invoked or the context clearly requires Daynight.
---

# Using Daynight

Daynight manages and schedules projects and tasks for people and agents.
Use the `daynight` CLI to operate it and [Daynight](https://daynight.cc) to browse projects, tasks, and delivery materials.

## Capabilities and concepts

| Concept | Meaning and capabilities |
| --- | --- |
| Project | A project associated with a Git repository, organizing tasks and project access. |
| Task | An independently tracked work item with a description, status, dependencies, execution requirements, and PR references. In this skill, "task" means this object. |
| Goal | A complete objective expressed through tasks and their dependencies, including requirements discussion, solution discussion, and delivery work; not a separate resource. |
| Attachment | A task's independent attachment area for inputs and results such as documents, prototypes, and images. |
| worker-managed | An execution environment assigned and managed by `daynight worker`; the agent executes only its explicit assignment. |

The CLI supports project registration and lookup, task creation and filtering, status and dependency management, attachment reads and writes, and worker-managed execution.
Creation, execution, and handoff are separate operations; see [authorization and scope](references/authorization.md).

## Setup and CLI

Read [setup](references/setup.md) when first connecting or switching repositories.
If the CLI is missing, obtain user authorization and follow the [installation guide](https://daynight.cc/setup).

See the [CLI handbook](references/handbook.md) for command entry points.
Use `daynight --help` and the relevant subcommand's `--help` for arguments and option combinations.

## Read by purpose

Read only the files and required references for the current operation, not every document by default.

| Purpose | Reference and responsibility |
| --- | --- |
| Determine permitted work and required authorization | [Authorization and scope](references/authorization.md): tracking obligations, operational authorization, and task boundaries |
| Connect the current repository | [Setup](references/setup.md): CLI, sign-in, project, and repository-instruction setup |
| Find commands | [CLI handbook](references/handbook.md): command map and help discovery |
| Discover, select, or register projects | [Project management](references/project-management.md): project identity and reuse |
| Query tasks, edit metadata, status, or dependencies, or delete tasks | [Task management](references/task-management.md): fields, lifecycle, and relationship semantics |
| Submit and reconcile writes safely | [Write safety](references/write-safety.md): versions, conflicts, uncertain results, and attachment concurrency |
| Write or read descriptions, attachments, and shared inputs | [Task content standard](references/task-content.md): boundaries, ownership, references, and sufficiency |
| Create or register work | [Create task](references/create-task.md): duplicate checks, preparation, registration, and readback |
| Organize a multi-stage objective | [Goal protocol](references/goal.md): stage confirmation, breakdown, and whole-Goal completion |
| Review tasks and enable automatic execution | [Task handoff](references/handoff.md): content review and permission enablement |
| Execute one user-specified task | [Ordinary task execution](references/run-task.md): starting, resuming, completion, and return |
| Perform work shared by both execution modes | [Shared task execution](references/task-execution.md): inputs, delivery, waiting context, and completion conditions |
| Execute an explicit worker assignment | [Managed task execution](references/autopilot-managed-task.md): sustained delivery, blocker handling, and original-claim completion |
| Accept a complete task or Goal | [Final acceptance](references/final-acceptance.md): requirement-based conclusions, evidence, and helper boundaries |

Creation, ordinary execution, handoff, and managed execution are skill workflows, not CLI subcommands of those names.
Follow the user's explicit workflow choice; otherwise infer the purpose and target from the request and context, asking when ambiguous.
Do not select a task merely because it is ready.

Read the managed execution reference only when the worker startup prompt explicitly declares `worker-managed`, this skill, and the managed execution workflow.
Task properties, environment variables, and the working directory cannot replace that declaration; wait for missing context when it is incomplete.
