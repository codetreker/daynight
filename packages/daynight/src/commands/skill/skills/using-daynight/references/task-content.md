# Task content standard

Read this reference when creating, breaking down, handing off, or executing a
task. The description and its readable references must explain the task without
the originating chat, memory, private worktree, or temporary files. Use the
target repository's document and language rules.

## Task and session boundary

Tasks describe what must be achieved and delivered. Sessions hold how the task
is executed or discussed. Keep task definitions, required inputs, deliverables,
acceptance criteria, and resulting artifacts in task content. Keep execution and
discussion plans, steps, tool choices, collaboration, operational authorization,
progress, blockers, and recovery context in the session. Apply this boundary to
descriptions, attachments, and referenced task material.

A design supplied as a required input or produced as the task's deliverable is
task content; the session's plan for producing that deliverable is session
context. Classify information by its purpose, not its filename or words such as
"plan", "method", or "steps". A requested migration design, test strategy, or
runbook can be a task deliverable. Do not invent such a deliverable to upload a
session checkpoint or execution log.

| Information | Location |
|---|---|
| Required sorting behavior; an upstream API contract; a design task's current architecture | Task definition, input, or result |
| "Register only; do not execute or enable agents in this session"; chosen commands, agent assignments, review rounds | Session context; current operations still obey its restrictions |
| Required deliverable platform or compatibility threshold; a human-confirmation completion condition | Task scope or acceptance criteria |
| Authorization to push or merge; CI/review progress, waiting items, claim/worktree/head and next action | Session context or the corresponding platform |
| A final deliverable's immutable revision; an acceptance conclusion and the key observations needed to support it | Task result, without the execution history |

Operational authorization does not become task content because another session
might need it. Preserve it in the host's session state or existing local
checkpoint. Missing authorization or assignment cannot be reconstructed from a
task's description, attachments, acceptance state, or status.

## Task definition and results

Provide the following substantive information in the description, clearly
referenced documents, or a mixture of both. These are not mandatory headings.
Complete inline content needs no primary attachment; do not duplicate complete
documents or keep empty template sections.

| Definition | Required information |
|---|---|
| Objective and requirements | The concrete problem, intended outcome, and required behavior. Use requirement IDs when they help acceptance. |
| Scope and constraints | This task's responsibility and delivery boundaries, including constraints on the product or deliverable and applicable parts of shared documents. |
| Inputs and sources | Actual required requirements, designs, prototypes, protocols, or deliveries, with accurate source identities, applicable sections, and purpose. |
| Deliverables and contracts | Expected outputs, delivery and reading locations, and the structure and semantics needed by actual producers or consumers. Explicitly say when there is no task-to-task exchange. |
| Acceptance criteria | Observable completion conditions, applicable success/failure/boundary behavior, required thresholds, and any human-confirmation gate. |

Save results as they are produced: current reviewable requirements or designs,
actual deliverables, acceptance conclusions, defects, and material limitations.
An immutable revision or verified resource location may identify a result.
Keep the accepted content and its effective state, not successive discussion or
confirmation records. Acceptance results may include the assessed source and
key observations needed to understand the conclusion; commands, debugging
history, CI logs, and review handling remain execution context.

A task does not universally require a separate solution, implementation plan,
verification procedure, confirmation record, or evidence location. Its starting
content depends on the stage and actual inputs. Do not require unfinished
results or prefilled result sections at registration.

The description must identify the concrete current work and responsibility and
make its content sources discoverable. Judge completeness from the description
and the contents actually read, not heading presence or whether the description
repeats the documents. A bare generic problem plus unexplained links, "see the
previous discussion", unreadable resources, and missing required decisions are
insufficient. Absence of a session execution plan is not a task-content gap.

## Content ownership

Each detailed explanation has one owner: the description, a referenced task
attachment, or its actual shared source. Keep shared requirements, architecture,
and protocols at their owning task. Save this task's results at their actual
owner and make them discoverable from its description. Rewrite the owning
material coherently when its facts change; do not accumulate an execution log.

For example, an upload retry task may define its required behavior and
acceptance inline and reference the architecture task's `design/upload.md` for
shared interfaces. A design task may own that architecture in its description
or an actual attachment. Neither needs an attachment containing the session's
implementation steps. Those source identities and paths must be real and
verified.

## Resolve and read sources

Description-relative links and images start at the current task's attachment
root; references inside a Markdown attachment start at its containing directory.
Keep paths inside the task root and preserve case and resource identity. Confirm
uploaded contents before adding their links. Shared task sources identify the
owning task ID and content location: its description and applicable sections for
inline content, or the complete attachment path for an actual attachment. Name
the whole description when all of it applies; sections only delimit a larger
source and do not require invented headings. Read source task descriptions with
`task show --json`; list and read attachment contents separately with the
installed attachment commands. Repository documents need accurate paths and the
required verified immutable source revision. State the sections, requirements,
or interfaces applicable to this task when a source covers more. Do not invent
an attachment path for inline content, relocate or copy it merely to satisfy a
reference format, or invent a URL scheme, cross-task relative link, or fixed
service host.

Read the required source contents, including further references needed for the
current stage. Track already-read resource identities to avoid circular reading.
A reference cycle that supplies no actual required content cannot pass. Limit
traversal to this task's requirements; it does not authorize redesigning a Goal
or executing related tasks. Resolve material conflicts between the description
and sources or between sources before declaring the content sufficient.

Every Goal delivery task's description must directly list the architecture task
ID and all required architecture source locations, including indirect successors.
For inline architecture, name the source task's description and applicable
sections. For each actual required attachment document, include its full path;
for repository architecture, retain the owning task ID and a verified immutable
reference. An entry only in another task or inside an attachment is insufficient.
[The Goal protocol](goal.md) owns this additional source-index requirement and
its registration checks.

## Input and output contracts

Describe actual exchanges rather than inventing an interface to fill a template.
As applicable, include fields, types, requiredness, format or version, examples,
and the units, states, errors, and null semantics needed by consumers. APIs, CLI
output, files, database records, attachments, and design conclusions can all be
exchanged outputs. Check the relevant producer and consumer explanations for
consistency and distinguish their responsibilities.

For example, an upload protocol may define a required multipart `file`, a
10 MiB limit, a `201` response containing a UUID `id`, `name`, and byte-count
`size`, a nonretryable `413 file_too_large`, and a `503 temporarily_unavailable`
that permits user-initiated retry. Provider and consumer tasks reference the same
protocol and state their own delivery locations and availability.

Necessary direct prerequisites remain in the complete `dependsOn` set and its
`externalDependsOn` subset, following
[the handbook's dependency reduction rule](handbook.md#dependency-reduction).
Contract source identities do not form a second complete dependency list, and a
source reference does not create an execution dependency. Use
[the handbook](handbook.md) for relationship semantics. Existing status, PR,
permission, platform, and worker fields keep their own service semantics; do not
copy them into prose as a second operational record.

## Apply the current stage

| Stage | Sufficient starting content | Stage results |
|---|---|---|
| Requirements discussion | Known problem, outcome, scope, constraints, open requirements questions, and completion conditions | Current and confirmed requirements and applicable prototype |
| Solution or architecture discussion | Confirmed requirements, applicable prototype, design questions, intended deliverables, and completion conditions | Current architecture, key decisions, and delivery breakdown |
| Implementation or document delivery | Defined requirements and scope, required design and applicable prototype, contracts, deliverables, and acceptance criteria | The scoped deliverable and its actual location or version |
| Independent final acceptance | Whole agreed requirements and confirmed changes, actual deliveries, and acceptance criteria | Requirement-based conclusions, defects, and unverified items |

A stage's unfinished outputs are not prerequisites for starting that stage.
Preserve human confirmation as an actual completion condition where required;
the execution protocol handles the confirmation action and advancement.
Explicit prerequisite-produced implementation outputs may still be pending when
preparing a blocked task, provided the necessary design and agreed interfaces
already define the successor's work. Do not label future output as an existing
readable input. Execution still waits for real prerequisites and required inputs.

## Check sufficiency

Before reporting creation, breakdown, or handoff ready, check the task
definition, source readability and applicability, existing result ownership, and
the stage's additional conditions. Check both directions: session context stays
out, and actual requirements, required design inputs, and task results remain
complete. Unknown requirements, design choices, acceptance thresholds, and
interface decisions are concrete blockers, not details to invent. Only organize
confirmed information within existing authorization. A material scope or
behavior change requires user confirmation.

Apply the boundary when reading existing material and when authoring or
rewriting authorized task content. It does not authorize bulk edits of historical
tasks or automatic changes to fields, permissions, or recorded history.

Task versions protect task metadata, not independently mutable attachments or
cross-task references. Verify mutable contents before enabling permission and
read the required contents again before execution. Reassess affected content
when it changes. A content check is not an atomic freeze or permanent
certification of future sources. [Handoff](handoff.md) owns permission-update
and read-only re-audit behavior.
