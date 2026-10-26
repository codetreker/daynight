# Agent Note: Shared Agent Workflow

Status: implemented

## Problem

An initialized repository needs a consistent way to preserve decisions, evaluate
scope, maintain documentation, and share instructions across agent tools. A
workflow tied to another project's runtime or document layout would give agents
incorrect prerequisites and verification commands.

## Decision

The repository adapts the four decision and prose skills from the
[source workflow at its inspected revision](https://github.com/codetreker/remote-fs/tree/ef64c5a73992e388065673a81cf96739c1179f9f/.agents).
The local skills are `agent-notes`, `scope-cut`, `prose-standard`, and
`trim-cot-leakage`. Skill names and references use the local, project-independent
names. Workflow documents, skills, and Agent Notes remain English. New or
revised specifications and design documents follow the
[Chinese document language policy](2026-10-16-chinese-spec-and-design.md).

[AGENTS.md](../../../../AGENTS.md) owns task scope, shared worktree ownership,
collaboration, verification, and delivery. The
[repository README](../../../../README.md) owns repository status and
documentation conventions. The [notes README](../../README.md) owns note paths,
format, lifecycle, and retention.

Notes use lifecycle and decision-class directories, preserve the topic's first
proposal date, and record real alternatives. Current work goes directly into
`implemented/`; `proposed/` holds deferred work. Active current facts move with
the implementation, historical decision premises retain their original meaning,
and archives remain immutable.

Scope choices preserve confirmed requirements and state concrete deferral costs.
Only alternatives actually considered are recorded. Prose keeps the complete
contract and enough local rationale to understand the mechanism; full decision
history belongs in notes. Active research stays synchronized with relevant work.
The [validation evidence decision](2026-10-20-source-bound-validation-evidence.md)
clarifies this ownership for acceptance: run observations stay with source-bound
artifacts and their PR or CI run, while durable methods, limitations and decisions
stay in their existing document owners.

`.agents/skills/` is the canonical skill directory. Relative links expose root
instructions through `CLAUDE.md` and skills and worktrees through `.claude/`.
Task worktrees use `.worktrees/`, temporary artifacts use `.tmp/`, and local plans
use `docs/plans/`; all three paths are ignored by Git.

Documentation directories are created as actual work requires them. The workflow
uses checks appropriate to the files present. Application build, test, coverage,
and CI commands are documented when their tooling is introduced.

## Alternatives

**Copy the source workflow unchanged.** This preserves its names and layout,
but requires project-specific specifications and runtime commands that this
repository does not have. Its Chinese note headings also conflict with the
repository's English document convention. The source's scope guidance both
requires real alternatives and prescribes a smaller and larger alternative;
recording only actual comparisons resolves that conflict.

**Use the sibling repository's broader adaptation.** That workflow includes
commit, PR, merge, and test-optimization skills in addition to the four source
skills. Those add project-specific command assumptions and additional workflow
ownership. Adapting the confirmed four-skill source keeps this repository's
workflow aligned with the requested scope.

## Consequences

Agent tools share one maintained set of instructions and skills. Decision
history remains accessible without copying another project's historical notes
or creating placeholder product documentation. Maintainers must synchronize
active documents and current facts, check links when notes move, and preserve
archived history.

The workflow introduces no runtime or verification toolchain. Future application
work must establish its real commands and update the repository instructions.
Local edits to the imported skills are maintained here; source updates require
reviewing their relevance and reconciling local conventions.
