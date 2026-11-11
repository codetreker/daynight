---
name: using-daynight
description: Operate Daynight projects, tasks, dependencies, Steps, materials, Sessions, Webhooks and Workers through the CLI. Use when a request requires Daynight or explicitly invokes this skill.
---

# Using Daynight

Daynight organizes work and exposes its execution observations. Use `daynight`
or `dn`; consult the installed command's `--help` for exact arguments and options.
`daynight --skill` prints the complete product manual offline.

Read only the references needed for the current operation. Confirm connection
and Project identity when first using a service or repository. Every write also
requires [write safety](references/write-safety.md) and the resource-specific
conditions in its topic; reading instructions does not authorize an operation.

| Purpose | Read |
| --- | --- |
| Connect, select a Project, or manage Teams, Projects and invitations | [Setup and projects](references/setup-and-projects.md) |
| Create, query or change Tasks, status, properties and dependencies | [Tasks](references/tasks.md) |
| Read or maintain ordered Task Steps | [Steps](references/steps.md) |
| Read or write descriptions, attachments and discussion Threads | [Materials](references/materials.md) |
| Bind decisions to versions or interpret write outcomes | [Write safety](references/write-safety.md) |
| Locate Sessions, observe activity or read history | [Session reads](references/session-reads.md) |
| Send an authorized message or recover its original result | [Session messages](references/session-messages.md) |
| Configure Webhooks or inspect deliveries and operation receipts | [Webhooks](references/webhooks.md) |
| Manage Workers, pause execution or complete an assigned claim | [Worker operations](references/worker-operations.md) |

For example, a Task query needs Tasks; an attachment upload needs Materials and
Write safety; a Session send needs Session messages and Write safety, plus Session
reads when the target or execution identity has not yet been established.

These references explain product operations. Apply the target repository's
workflow and the current authorization when deciding what work to perform.
