# Agent Notes

An Agent Note records a decision or proposal affecting this repository: why it
was chosen, which alternatives were considered, and what it costs. It preserves
rationale that source code and descriptions of current behavior cannot carry.

## Document ownership

The [repository README](../../README.md) defines documentation conventions.
When those documents exist, specifications own required behavior, design
documents explain the current structure and its essential rationale, and
research documents own durable evidence and citations. Agent Notes own decision
history, alternatives, consequences, and conditions for reconsideration. Runtime
acceptance observations belong to source-bound artifacts and their corresponding
PR or CI run; the [validation evidence decision](archived/process/2026-10-20-source-bound-validation-evidence.md)
explains their retention limits and the durable knowledge that remains tracked.
Link to the owning document instead of duplicating its explanation.

These are conventions for documents created when work needs them, not a request
to create a documentation tree in advance.

## Paths and names

Every note uses this path:

```text
{lifecycle}/{class}/yyyy-mm-dd-title.md
```

The lifecycle is one of:

- `proposed/`: substantive work deferred for the future. Work currently being
  delivered goes directly into `implemented/`.
- `implemented/`: an adopted decision, with statements about the current system
  kept accurate in the same change that changes those facts.
- `rejected/`: a declined proposal whose rationale still prevents a tempting,
  meaningful mistake.
- `archived/`: an implemented decision whose rationale is unlikely to guide
  future work. Archived notes are immutable historical records.

The class is one of:

| Class | Decision concerns |
|---|---|
| `feature` | A new capability exposed to a consumer |
| `bug-fix` | A defect or a gap identified by a failure |
| `simplification` | Removing code, behavior, or exposed functionality without adding a capability |
| `architecture` | The structure and responsibilities of delivered source code |
| `process` | Tools, policies, and workflows around the source code |
| `testing` | Test infrastructure or verification strategy |

Choose the class that explains the decision's purpose; a refactoring can be an
architecture or simplification decision. Create a lifecycle/class directory with
its first note. Do not add empty directories or a centralized index; the tree is
the inventory.

The filename date is the topic's first proposal date. Preserve it when revising
or moving a note. Use relative Markdown links between notes, and repair links
from active documents when a note moves. Links inside immutable archives remain
historical and are exempt from current-path repair.

## When to write

Every nontrivial change includes a new or updated Agent Note in the same change
or PR. A change is nontrivial when it changes behavior, architecture, a shared
contract, process or tooling, verification strategy, a stored or exchanged
format, or another decision a maintainer might reasonably reconsider. Purely
mechanical or local edits that change none of these can omit a note.

Update the note that already owns the decision. A replacement decision needs a
new note. Cross-link active predecessor and replacement notes; when the
predecessor is archived, link to it from the new note without adding a backlink
to the archive. Never rewrite an earlier decision into its opposite: its
original rationale remains part of the history.

The note obligation applies within authorized work. Read-only research and
discussion stay read-only unless writing a note is authorized; these conventions
do not grant permission to edit files, run tests, commit, push, or publish.

## Current facts and decision history

An active implemented note contains two kinds of statements:

- Current facts describe the system as it exists: file locations, names,
  defaults, behavior, and responsibilities. Update them with the corresponding
  implementation change.
- Historical facts describe the decision's circumstances: what was known,
  compared, accepted, rejected, delivered, or given up at that time. Preserve
  them even when a later decision differs; link to the later decision.

Ask whether a sentence describes the system or the moment of decision. Keep
active documents coherent by rewriting affected sections as a whole, without
appending correction logs. Historical statements and genuine alternatives stay
intact; a changed decision receives its own note.

## Format

Notes and headings are English. The first three lines are:

```markdown
# Agent Note: <Title>

Status: <status>
```

The status line agrees with the lifecycle:

- `Status: proposed`
- `Status: implemented`
- `Status: rejected — <one-line reason>`

An archived note retains `Status: implemented`; its directory records archival.
Dates belong in filenames, not status lines.

Every note begins with `## Problem`. Describe a problem that stands independently
of the chosen solution, so a reader can agree with the problem while preferring
another approach. Add technical subsections only when they help explain the
decision.

### Proposed notes

```markdown
## Problem
## Proposal
## Alternatives
## Acceptance Criteria
## Risks
```

The proposal describes the intended change. Acceptance criteria define observable
completion. Risks cover both possible failures and deliberate trade-offs.

### Implemented notes

```markdown
## Problem
## Decision
## Alternatives
## Consequences
```

The decision states what exists in present tense. Consequences record benefits,
costs, and remaining gaps. Remove proposal-only plans, acceptance checklists, and
open implementation questions when recording the delivered decision.

### Alternatives

`## Alternatives` is mandatory. Record every alternative genuinely considered
and why it lost, with a bold-led paragraph for each. State concrete costs or
failures; labels such as "simpler" and "cleaner" do not explain a choice.

If none was considered, say so. Do not invent alternatives to fill the section.
If an alternative remains open, state what evidence or condition would decide it.

## Lifecycle changes

Move a note and adjust its status and structure in the same change:

- `proposed/` to `implemented/`: rewrite Proposal as a present-tense Decision;
  fold actual outcomes from Acceptance Criteria and Risks into Consequences;
  retain the real alternatives and record what was delivered.
- `proposed/` to `rejected/`: add the rejection reason to Status and retain the
  proposal body as the record of what was declined.
- `implemented/` to `archived/`: retain the implemented status and content. Archive
  only when the decision is complete and its rationale is unlikely to guide
  future work.

Never archive a proposed note; reject an obsolete proposal with its reason.
Keep an implemented note active while its alternatives, ownership rules,
guarantees, security or persistence implications, or reconsideration conditions
remain useful.

Archived notes are never edited, reorganized, updated, moved, or deleted. Active
documents may link to them deliberately as history, but must not use them as
authority for current behavior.

## Pruning

A rejected note is worth retaining while its rationale prevents a plausible
mistake. Delete it when that rationale no longer serves this purpose.

Delete an implemented note only after a fully superseding note absorbs all its
unique rationale, alternatives, consequences, and named gaps, and active inbound
links are repaired. Partial supersession keeps both notes, cross-linked. Git
history alone is not a substitute for accessible decision rationale.
