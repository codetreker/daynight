# Agent Note: PR-Specific Review Perspectives

Status: implemented

## Problem

A complete diff can cross several contracts whose failures require different
questions and evidence. A single reviewer's repeated passes can retain the same
assumptions, while a generic specialist checklist can spend effort on concerns
absent from the PR. Independent candidate findings also need one accountable
reviewer to settle contradictions and distinguish verified blockers from
speculation before publication.

## Decision

The bundled `daynight-review` skill requires the main agent to inspect the
complete captured diff, choose at least two complementary perspectives from the
actual changes, contracts and risks, and invoke independent subagents, preferably
in parallel. The attempt prompt explicitly requests the loaded skill's native
delegation and synthesis, preserving the submitted-result reconciliation
exception without duplicating the method. This applies to documentation-only
PRs as well. Each assignment
explicitly carries the immutable head/base/merge-base context, established scope,
applicable repository instructions, assigned questions, evidence standards and
worktree, temporary-file, process and cleanup rules. Specialized children cannot
be assumed to inherit repository instructions.

Subagents review source and Git state read-only, report evidence, locations,
coverage limits and fix/defer/reject recommendations to the main agent, and own
neither GitHub publication nor completion markers. The main agent waits for all
required perspectives, verifies candidates, resolves disagreements and combines
duplicate root causes. Attempt output retains its perspective rationale,
completed coverage, limitations, dispositions and confirmed blockers; GitHub
findings retain the existing concise publication format.

Delegation stays inside one daemon-managed attempt, its existing timeout and
retry budget, worktree and main PR session. Unavailable tools, failed children or
unfinished required coverage fail the operation unless a retry or reassignment
completes within that budget. They cannot become approval or fabricated quality
findings. Reconciliation of valid matching submitted results confirms existing
effects without repeating review. The daemon does not parse subagent transcripts
or findings to infer compliance.

This extends the methodology in the
[bundled-skill decision](../architecture/2026-10-20-bundled-review-skill.md) and
[PR-quality decision](2026-10-21-review-pr-quality-gates.md) while retaining their
loading, evidence and publication boundaries. It preserves the session and
attempt ownership in the
[Copilot execution decision](../architecture/2026-10-17-copilot-session-execution.md).
The [requirements](../../../../docs/spec/daynight-review.md#r10-审查判断与结果发布)
own required behavior; the
[skill design](../../../../docs/design/daynight-review-skill.md#多角度审查与汇总)
owns delegation and synthesis mechanics.

## Alternatives

**Use the same fixed specialists for every PR.** A mandatory domain list is easy
to schedule, but can assign reviewers concerns absent from the diff and miss the
particular contracts the change crosses. Selecting complementary questions after
reading the complete target keeps the independent effort relevant.

**Have the main reviewer perform several passes alone.** This avoids delegation
cost and tool availability dependencies, but the passes share one context and
its assumptions. It does not provide the independently formed candidates this
method requires.

## Consequences

Reviews spend additional model work and coordination time on independent
perspectives. The main agent remains responsible for complete coverage and
evidence; the number of subagents does not establish correctness. Missing
delegation capability becomes a visible operational failure within the existing
attempt budget, without adding scheduler state or another publication path.

The shipped skill and packaging checks establish the delivered instructions.
Actual delegation, target transmission and synthesis require native execution
evidence; neither text assertions nor successful GitHub publication proves review
judgment for arbitrary PRs. Attempt logs retain the synthesis under the existing
evidence lifecycle, without turning investigation transcripts into PR comments.

A controlled Copilot CLI 1.0.102 probe loaded the production skill snapshot against
an offline local fixture. With activation alone, it directly inspected the code
and dispatched no subagents. A follow-up adding only the native-subagent reminder
dispatched two actual tasks. This observation supports the explicit prompt
reminder; task dispatch alone does not establish completed synthesis or correct
judgment, and the probe does not exercise GitHub publication.
