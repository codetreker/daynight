# Agent Note: Review PR Quality Gates

Status: implemented

## Problem

A PR can contain no identified Critical/Major code defect while still failing to
explain its purpose or bundling unrelated changes. A vague or expanding
description makes it difficult to establish which changes belong together and
to review their combined effect. Treating the absence of a severe runtime defect
as sufficient for approval leaves those problems unblocked.

## Decision

The bundled `daynight-review` skill requires two PR-quality gates independently
of code-defect severity. The description must state one concrete problem, its
expected outcome and the intended scope. The complete captured diff must serve
that original outcome and remain reviewable. Independent objectives belong in
separate focused PRs, with their dependency order made clear when needed.
Necessary implementation, structural changes, tests and documentation for the
same result remain in scope. Neither a broad theme nor a larger description
alone justifies unrelated work; line and file counts do not define a valid cut.

The dynamic prompt requires the reviewer to read the current PR title, body and
linked scope requirements, use those requirements to establish the original
boundary, and assess every captured change. Before publication or confirmation,
it rereads the current title and body and reevaluates the gates against the
relevant requirements. Approval requires both
gates to pass and no Critical/Major code issues to remain. Blockers are published
through `COMMENT` with actual resolvable review threads. Suitable out-of-scope or
code findings are inline; description and other PR-level blockers use clearly
labeled file-level threads on the principal changed file. `REQUEST_CHANGES`
remains unused. Existing exact-target approvals are preserved during confirmation;
new publication rereads the current gate inputs. The
[conversation-cycle decision](../architecture/2026-10-21-review-conversation-cycle.md)
partially supersedes the original summary-only COMMENT representation and
head-only follow-up behavior while preserving these quality criteria.

This partially supersedes the original absence-of-Critical/Major approval rule
in the [Copilot execution decision](../architecture/2026-10-17-copilot-session-execution.md)
and expands the methodology owned by the
[bundled-skill decision](../architecture/2026-10-20-bundled-review-skill.md).
Their agent-owned publisher, immutable skill loading, stable review identity and
text completion protocol remain in force. Required behavior belongs to
[review R10 and R12](../../../../docs/spec/daynight-review.md#r10-审查判断与结果发布);
the [skill design](../../../../docs/design/daynight-review-skill.md) owns the
instruction and runtime responsibility split.

## Alternatives

**Retain absence of Critical/Major code defects as the approval criterion.**
This keeps approval tied to introduced caller-visible defects, but allows a
vague description, independent objectives or unrelated changes to receive
approval without satisfying a focused delivery goal. PR quality needs its own
blocking criteria; those criteria do not need to be mislabeled as runtime defects.

## Consequences

Review can reject a PR for unclear purpose or scope creep even when its code has
no identified severe defect. The rule preserves complete delivery across modules
while requiring independent outcomes to be split for effective review. Authors
must explain the intended problem and outcome, and reviewers must justify the
necessary relationship of changes to that scope.

These gates are instructions evaluated by the review agent. Prompt and bundled
skill regressions can verify the shipped requirements; they do not prove model
judgment for every PR. Scope decisions use available evidence of the original
goal and cannot infer unavailable history. The original gate delivery retained
the existing schema and scheduling, which avoided coupling methodology changes
to a new runtime outcome contract. Conversation-driven follow-up now records
actual publication and thread identities without parsing quality judgments or
introducing an original-description snapshot. Correcting and resolving feedback
can wake another round without a commit; description edits after an approved
target do not revoke that approval.

Code-defect severity and bounded verification retain their existing scope.
Machine-enforced quality judgments remain distinct from the daemon's verification
that a real approval or resolvable feedback publication exists.
