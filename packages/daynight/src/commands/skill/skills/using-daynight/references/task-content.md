# Task content standard

Applies to creation, breakdown, handoff, and execution.
Descriptions and their actual references should let an independent reader understand the task without the original chat, private worktrees, or temporary files.
Follow the target repository's documentation and language rules.

## Task and session boundary

Tasks store what must be implemented and delivered; sessions store how to execute or discuss it.
Apply the same boundary to descriptions, attachments, and referenced material.

| Store in the task | Store in the session or relevant platform |
| --- | --- |
| Objectives, requirements, scope, delivery constraints, required inputs, acceptance criteria | Execution steps, tool choices, agent assignments, operational authorization |
| Current requirements or architecture, accepted conclusions and essential rationale, substantive open questions | Discussion rounds, confirmation process, debugging history, CI and review progress |
| Deliverables, immutable revisions, acceptance conclusions, key observations and limitations | Worktree, HEAD, claim, blocker, waiting, and recovery context |

Classify by purpose, not by filenames or words such as "plan" or "method".
User-requested migration designs, test strategies, and operating manuals can be deliverables; the session steps that produce them do not belong in tasks.
Do not invent delivery requirements to justify uploading execution logs.
Operational authorization still constrains current behavior, but does not become task content merely because a later session needs it.

## Definitions and results

The description and readable references together provide the following information, without mandatory headings or empty templates:

| Information | Content |
| --- | --- |
| Objectives and requirements | Specific problem, expected outcome, required behavior, and requirement IDs when needed. |
| Scope and constraints | This task's responsibilities, delivery boundaries, and applicable shared constraints. |
| Inputs and sources | Source identifiers, locations, applicable sections, and purposes of genuinely required material. |
| Deliverables and contracts | Outputs, read locations, and semantics needed by producers and consumers; state when there is no exchange between tasks. |
| Acceptance criteria | Observable completion conditions, success and failure behavior, thresholds, and human confirmation points. |

The description must identify this task's specific work and where to find its sources.
When attachment delivery is not specified, complete inline content needs no primary attachment; references or a mix of inline content and references are also valid.
Do not duplicate complete documents.
The [complete delivery standard](autopilot-managed-task.md#complete-delivery-standard) governs managed tasks' attachment and separate review-file requirements; the general inline-content rule cannot waive them.
Generic questions, unexplained links, unreadable sources, or "see the previous discussion" are insufficient.

Save stage results promptly: current reviewable artifacts, accepted content and its effective status, actual deliverables, acceptance conclusions, and important limitations.
Each detailed explanation has one owner; rewrite it coherently when it changes rather than accumulating logs.
The requirements stage does not require completed requirements in advance, nor does the design stage require a completed design.
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
Unknown requirements, interface decisions, design choices, and acceptance thresholds are specific gaps, not details to invent.
If completing a task requires an architecture or execution plan, it is a required input and cannot be omitted on the grounds that "session plans do not belong in tasks"; actual session steps still follow the content boundary.
Handle input gaps in managed tasks through the [user interaction workflow](autopilot-managed-task.md#request-user-interaction).

Organize confirmed information only within the authorized scope; substantive scope or behavior changes require user confirmation.
This standard does not authorize bulk rewrites of historical tasks or automatic changes to permissions, statuses, or records.
