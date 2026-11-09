# Task content standard

Applies to creation, breakdown, handoff, and execution.
Descriptions and their actual references should let an independent reader understand the task without the original chat, private worktrees, or temporary files.
Follow the target repository's documentation and language rules.

## Task, Thread and Session boundary

Task descriptions and attachments store effective requirements, solutions and formal results.
Thread stores durable participant discussion; Session stores execution content, tool activity and operating context.
Apply these responsibilities to descriptions, attachments and referenced material.
Use [Thread commands](task-management.md#discussion-threads) to read, post and reply without changing task metadata or triggering execution.
An accepted conclusion in discussion must be incorporated into its effective content owner; a message alone does not replace the required task material or grant operational permission.

| Store in the task | Store in the session or relevant platform |
| --- | --- |
| Objectives, requirements, scope, selected solutions, detailed designs, required implementation steps, delivery constraints, required inputs, acceptance criteria | Session work schedules, tool choices, agent assignments, operational authorization |
| Current requirements or architecture, accepted conclusions and essential rationale, substantive open questions | Discussion rounds and confirmation process in Thread; debugging history, CI/review progress and execution context in Session |
| Deliverables, immutable revisions, acceptance conclusions, key observations and limitations | Worktree, HEAD, claim, blocker, waiting, and recovery context |

Classify by purpose, not by filenames or words such as "plan" or "method".
Detailed designs and required implementation steps are durable task content. Session command schedules, tool choices, agent assignments and debugging history remain Session content.
User-requested migration designs, test strategies, and operating manuals can be deliverables; the session steps that produce them do not belong in tasks.
Do not invent delivery requirements to justify uploading execution logs.
Operational authorization still constrains current behavior, but does not become task content merely because a later session needs it.

## Task Steps and Session content

A Step is a durable, ordered record of work within one Task. Its description can
hold that work's objective, completion conditions, result and references to its
materials. The Task description and attachments remain the owners of the overall
requirements and formal deliverables; a Step may reference them. Steps persist
across Sessions and can be empty; do not infer them from Task descriptions,
Session todos or execution logs.

Session owns its work organization, command schedules, tool activity, logs and operational
authorization. Do not copy the Session timeline into Steps or treat a Step as
permission to execute, deliver, communicate externally or merge. Project rules
own how Steps are divided and maintained; see [task execution](task-execution.md#maintain-steps).

## Definitions and results

The description and readable references together provide the following information, without mandatory headings or empty templates:

| Information | Content |
| --- | --- |
| Objectives and requirements | Concrete problem, current and required behavior, affected consumers and impact, expected outcome, and requirement IDs when needed. |
| Scope and constraints | This task's responsibilities, delivery boundaries, and applicable shared constraints. |
| Selected solution (delivery tasks) | Chosen mechanism, essential rationale, applicable constraints, and resolved technical choices needed for implementation. |
| Detailed design (delivery tasks) | Affected components and responsibilities, relevant interfaces and data structures, control or data flow, error behavior, and integration or migration requirements needed to implement the solution. |
| Implementation steps (delivery tasks) | Ordered, concrete changes with their targets, expected results, and required dependency or integration sequencing. |
| Inputs and sources | Source identifiers, locations, applicable sections, and purposes of genuinely required material. |
| Deliverables and contracts | Outputs, read locations, and semantics needed by producers and consumers; state when there is no exchange between tasks. |
| Acceptance criteria | Observable success, failure and relevant boundary behavior, verification methods and expected results, applicable thresholds, and human confirmation points. |

The description must identify this task's specific work and where to find its sources.
Provide the detail the actual work needs without inventing interfaces or empty sections. The selected solution, detailed design and implementation steps must define the delivery task's own work, even when shared detail comes from referenced sources.
These content requirements do not mandate a separate plan file, line-by-line code instructions, or Task Steps resources.
When attachment delivery is not specified, complete inline content needs no primary attachment; references or a mix of inline content and references are also valid.
Do not duplicate complete documents.
The [Goal protocol](goal.md#complete-requirements-spec) requires a complete `spec.md` attachment for the requirements stage even when its description is complete. Every Goal delivery task additionally requires the [task-specific delivery brief](goal.md#delivery-task-brief); the general content categories do not waive its implementation approach.
The [complete delivery standard](autopilot-managed-task.md#complete-delivery-standard) governs managed tasks' attachment and separate review-file requirements; the general inline-content rule cannot waive them.
Generic questions, unexplained links, unreadable sources, or "see the previous discussion" are insufficient.

Save stage results promptly: current reviewable artifacts, accepted content and its effective status, actual deliverables, acceptance conclusions, and important limitations.
Each detailed explanation has one owner; rewrite it coherently when it changes rather than accumulating logs.
Requirements, research and design tasks produce their own conclusions and designs; their future results are not prerequisites for starting the producing stage. A delivery task with unfinished research or design cannot be treated as such a producing stage merely to bypass delivery handoff requirements.
Do not present future prerequisite outputs as existing inputs. See the [Goal protocol](goal.md) for stage requirements.

## Attachments and references

Task details contain neither an attachment listing nor attachment bytes; use `task attachment list/read` separately.
Uploading to the same path replaces the file.
See [write safety](write-safety.md#attachments-and-multi-step-operations) for content concurrency limits.

Relative links and images in a description resolve from this task's attachment root; references inside a Markdown attachment resolve from the file's directory.
Preserve case and actual resource paths, and do not escape the task root.
Upload and read back resources before adding links.
Preserve valid relative locations for prototype HTML, CSS, JavaScript, images, and other resources, and follow the [prototype requirements](create-task.md#prepare-content).

Keep shared inputs in their owning tasks and cite the owning task ID and source location: identify the description and applicable sections for inline content, the full path for actual attachments, and the exact path and required, verified immutable revision reference for repository sources.
Read source descriptions with `task show --json` and read attachments separately.
The whole description may be referenced when no section restriction is needed.
Do not invent attachments, cross-task relative links, URL schemes, or fixed service hosts, or copy or move content merely to satisfy formatting requirements.

Read further references genuinely needed by the current task, tracking resources already read to avoid cycles.
Reference cycles without substantive content cannot pass checks; resolve substantive conflicts between sources before declaring inputs sufficient.
See the [Goal protocol](goal.md#register-the-delivery-breakdown) for the additional architecture-index requirements for every Goal delivery task.

## Markdown and exchange contracts

Descriptions use Markdown; the Web renders CommonMark/GFM and displays raw HTML as text.
The CLI/API preserves the original string and has no format field.
Preserve newlines, code, syntax, and valid references when replacing the full content.

Describe only exchanges that actually exist, specifying fields, types, requiredness, formats or versions, examples, units, statuses, errors, and null semantics as needed.
APIs, CLI output, files, databases, attachments, and design conclusions can all form contracts.
Verify consistent producer and consumer responsibilities; do not invent interfaces to fill a template.
Citing sources does not create execution dependencies; see [task management](task-management.md#dependency-classification) for relationship rules.

## Content sufficiency

Before creation, handoff, or execution, check definitions, source readability and applicability, result ownership, and stage requirements.
A delivery task is ready for handoff only when its definition and implementation design are complete. Its author must resolve the research and design questions needed to define the work before handing it off. An independent implementer must be able to execute the selected solution from the task and its readable references without further investigation to establish the problem, choose a solution, or complete missing requirements or design.
A solution direction, a broad architecture link, or an instruction to investigate and decide during implementation is insufficient.

Unknown requirements, interface decisions, design choices, implementation steps, and acceptance thresholds are specific gaps, not details to invent. A required architecture or implementation approach, including the Goal delivery brief, is task content and cannot be omitted on the grounds that "session plans do not belong in tasks"; actual session work schedules still follow the content boundary.
Normal code reading, local coding choices, debugging and verification remain implementation work; they cannot supply missing requirements, select the solution, or resolve substantive design or contract decisions.
Handle input gaps in managed tasks through the [user interaction workflow](autopilot-managed-task.md#request-user-interaction).

Organize confirmed information only within the authorized scope; substantive scope or behavior changes require user confirmation.
This standard does not authorize bulk rewrites of historical tasks or automatic changes to permissions, statuses, or records.
