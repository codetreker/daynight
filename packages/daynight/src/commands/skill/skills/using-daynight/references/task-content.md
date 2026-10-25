# Task content standard

Read this reference when creating, breaking down, handing off, or executing a
task. An isolated executor does not inherit the originating chat, memory,
private worktree, temporary files, or session-only authorization. The description
and its readable references must together explain the current task completely.
Use the target repository's document and language rules.

## Six content requirements

These are content requirements, not six mandatory headings. Provide each item
in the description, in clearly referenced documents, or through a mixture of
both. Complete inline content needs no primary attachment; do not duplicate
complete documents or keep empty template sections.

| Content | Required information |
|---|---|
| Objective and requirements | The concrete problem, intended outcome, and required behavior. Use requirement IDs when they help acceptance. |
| Scope and deliverables | This task's responsibility, outputs, constraints, and boundaries. Identify its applicable parts of shared documents. |
| Solution and design | The approach, decisions, and architecture constraints needed for this stage, or their actual source. A design-producing task states its inputs, questions, outputs, and confirmation gate. |
| Input and output contracts | Actual producers or consumers, delivery and reading locations, exchanged structure and semantics, availability, and verification. Explicitly say when there is no task-to-task exchange. |
| Acceptance criteria and verification | Observable completion conditions, methods, applicable success/failure/boundary cases, and the location of evidence. Requirement and acceptance IDs may establish correspondence. |
| Sources | Accurate source identities, applicable sections, and purpose for required content and supporting material. One source can cover several items. |

The description must identify the concrete current work and responsibility and
make its content sources discoverable. Judge completeness from the description
and the contents actually read, not heading presence or whether the description
repeats the documents. A bare generic problem plus unexplained links, "see the
previous discussion", unreadable resources, and missing decisions are insufficient.

## Content ownership and evidence

Each detailed explanation has one owner: the description, a referenced task
attachment, or its actual shared source. Keep shared requirements, architecture,
and protocols at their owning task. Record this task's user confirmations,
acceptance conclusions, and delivery evidence in an explicitly identified
location in its own description or attachments; do not leave them only in chat
or mix them into shared design. Rewrite the owning material coherently when its
facts change rather than accumulating an execution log.

For example, a description may identify an upload retry task, reference its own
`plan.md` for requirements R1–R3 and acceptance AC1–AC4, identify the architecture
task and `design/upload.md` sections for shared interfaces, and place this task's
acceptance evidence in `plan.md`. Those identities and paths must be real and
verified. A simple maintenance task can instead state the approach, contract,
acceptance, and evidence location inline.

## Resolve and read sources

Description-relative links and images start at the current task's attachment
root; references inside a Markdown attachment start at its containing directory.
Keep paths inside the task root and preserve case and resource identity. Confirm
uploaded contents before adding their links. Shared task attachments require the
source task ID and complete attachment path. Repository documents need accurate
paths and the required verified immutable source revision. State the sections,
requirements, or interfaces applicable to this task when a source covers more.
Do not invent a URL scheme, cross-task relative link, or fixed service host.

Read the required source contents, including further references needed for the
current stage. Track already-read resource identities to avoid circular reading.
A reference cycle that supplies no actual required content cannot pass. Limit
traversal to this task's requirements; it does not authorize redesigning a Goal
or executing related tasks. Resolve material conflicts between the description
and sources or between sources before declaring the content sufficient.

Every Goal delivery task's description must directly list the architecture task
ID and every required architecture document's full attachment path, including
indirect successors. For repository architecture, retain the owning architecture
task ID and a verified immutable reference. An entry only in another task or
inside an attachment is insufficient. [The Goal protocol](goal.md) owns this
additional source-index requirement and its registration checks.

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

Actual prerequisites remain in the complete `dependsOn` set and its
`externalDependsOn` subset. Contract source identities do not form a second
complete dependency list, and a source reference does not create an execution
dependency. Use [the handbook](handbook.md) for relationship semantics.

## Apply the current stage

| Stage | Sufficient starting content | Stage outputs |
|---|---|---|
| Requirements discussion | Known problem, outcome, scope, open questions, and user-confirmation method | Complete requirements, applicable prototype, and user confirmation |
| Solution or architecture discussion | Confirmed requirements, applicable prototype, design questions, and confirmation method | Design and candidate breakdown; actual registration after confirmation |
| Implementation or document delivery | Defined requirements and scope, delivered design and applicable prototype, contracts, and acceptance | The scoped deliverable and its delivery evidence |
| Independent final acceptance | Whole agreed requirements and confirmed changes, actual deliveries and evidence sources | Requirement-based conclusions, defects, and unverified items |

A stage's unfinished outputs are not prerequisites for starting that stage.
Preserve human confirmation as an actual completion condition where required.
Explicit prerequisite-produced implementation outputs may still be pending when
preparing a blocked task, provided the necessary design and agreed interfaces
already define the successor's work. Do not label future output as an existing
readable input. Execution still waits for real prerequisites and required inputs.

## Check sufficiency

Before reporting creation, breakdown, or handoff ready, check all six items,
source readability and applicability, task-specific evidence ownership, and the
stage's additional conditions. Unknown requirements, design choices, acceptance
thresholds, and interface decisions are concrete blockers, not details to invent.
Only organize confirmed information within existing authorization. A material
scope or behavior change requires user confirmation.

Task versions protect task metadata, not independently mutable attachments or
cross-task references. Verify mutable contents before enabling permission and
read the required contents again before execution. Reassess affected content
when it changes. A content check is not an atomic freeze or permanent
certification of future sources. [Handoff](handoff.md) owns permission-update
and read-only re-audit behavior.
