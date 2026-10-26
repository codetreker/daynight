# Agent Note: Review Conversation Cycle

Status: implemented

## Problem

A reviewer can reject an unclear PR description without requiring code changes.
If only a new commit can wake another review, correcting that description leaves
an otherwise eligible PR permanently waiting. Passing CI and zero unresolved
feedback are persistent conditions, so treating those conditions alone as a
trigger would instead repeat reviews indefinitely. Publication can also succeed
before local completion, and a retry must not be blocked by its own feedback.

## Decision

A fresh review requires an open, non-Draft tracked PR, passing CI for the current
target, no unresolved native review threads from any author, a pending round, no
current-target Daynight approval, and no active or uncertain execution. Outdated
threads still block until resolved. Threads positively attributed to an unpublished
`PENDING` review are excluded from this author-facing gate; unknown parent
publication state remains blocking. A successful review either approves or
publishes `COMMENT` with actual resolvable native review threads. PR-level
blockers, including description quality, use a clearly labeled file-level thread
on the principal changed file. A summary alone cannot establish feedback.
Operational failures keep their existing bounded retry/failure semantics and do
not justify invented findings.

Head and target branch retain their target and CI identity roles. Each verified
comment publication arms one durable follow-up keyed by its remote review and
thread IDs. A complete snapshot showing that all native conversations are
resolved consumes it once, including when the author resolved feedback before
the agent finished. It advances the desired revision or coalesces with a newer
pending target. A new commit or description edit is unnecessary. Resolve requests
validation again; it does not prove that the correction is adequate. A verified
approval settles its target. Description edits neither revoke approval nor
create another round. Reusing that stored approval to settle a pending target
requires its exact remote review ID to remain `APPROVED` in a fresh snapshot,
with the captured actor, head and stable identity. A historical dismissed review
cannot suppress the pending round; the daemon never dismisses approvals itself.

The store uses schema version 2 and a `review_publications` record per internal
review ID. Its `prepared`, `pending`, `verified` and `legacy` phases separate execution from
remote confirmation. `identity_format` records `line` or explicit migration
provenance `legacy`. Verified records retain `approved` or `commented`, concrete
remote review/thread IDs, and whether the follow-up was consumed. For new rounds,
`prepared` captures the publishing actor before launch; retries cannot silently
switch that actor when the authenticated viewer changes. Marker
acceptance and process exclusion persist pending confirmation before querying
GitHub. Remote lookup failure retries read-only across restart without another
model attempt or fresh process. A complete lookup with no valid result is instead
a protocol failure that returns to the existing bounded model retry budget.
Stable Daynight review identity, captured commit
and the captured publishing actor must all match. Complete pagination and
valid responses are required; query failure cannot establish zero conversations.
The daemon verifies publication facts without interpreting code findings or
publishing reviews itself.

Same-round publication reconciliation is distinct from fresh-round admission.
Only actual captured-round `APPROVED` or `COMMENTED` with its owned threads, or
a matching valid `PENDING` draft under the same captured publisher, permits the
conversation-gate exception. An attempt count alone supplies no proof of earlier
publication. A failed attempt with no result waits for unrelated unresolved
conversations without consuming another attempt. Existing pending reviews and
their draft threads are recovered before creating another publication. A changed
reader can confirm the captured actor's submitted result; no result or a pending
draft waits for the original actor without launching a model or spending its
budget. The final stdout marker remains required execution evidence; it is
insufficient without the matching remote result.

Runtime migration preserves version 1 cutoffs, revisions, attempt budgets,
sessions, process evidence, logs, cleanup barriers and worktrees. Existing
completed records enter phase `legacy`; unfinished active records enter
`prepared`. Both retain `identity_format=legacy` and an unknown publisher, rather
than assigning today's reader to earlier effects. Before further writes, the old
exact token and captured head identify any actual historical publisher; the
captured actor and identity provenance remain fixed through pending verification.
This allows migrated prefixed approvals or threaded comments to recover after a
lost marker. Only these migrated records read that old format. New rounds use
strict own-line or HTML identities, and all new writes remain strict, including
writes made while recovering a migrated round.

Relevant completed legacy rows reconcile against remote evidence: matching
approval remains settled; a row without valid approval may consume one adoption
successor. Historical rows do not start models merely because the schema changed.
Read-only listing accepts supported schemas without migrating them.

This partially supersedes trigger and completion facts in the
[foreground-CLI decision](2026-10-16-foreground-review-cli.md),
[durable-state decision](2026-10-17-durable-review-state.md),
[foreground-coordination decision](2026-10-17-foreground-review-coordination.md),
[Copilot-execution decision](2026-10-17-copilot-session-execution.md) and
[PR-quality decision](../process/2026-10-21-review-pr-quality-gates.md).
Their permanent tracking boundary, immutable targets, per-PR sessions, process
exclusion, agent-owned publication and quality gates remain in force. The
[bundled-skill decision](2026-10-20-bundled-review-skill.md) retains packaging and
loading ownership. The
[status-listing decision](../feature/2026-10-18-review-status-listing.md) retains its
read-only ownership across both supported schemas. Required behavior belongs to
[review R5–R14](../../../../docs/spec/daynight-review.md#r5-轮询与审查资格), with
mechanism and API ownership in the
[review design](../../../../docs/design/daynight-review.md).

## Alternatives

**Wake only description-specific blockers on metadata edits.** This can solve
the immediate description correction path, but requires storing reviewed
metadata and classifying rejection reasons to decide whether an edit is
relevant. The chosen conversation handshake covers description, scope and code
feedback with the same explicit author signal and needs no blocker taxonomy.

**Require another commit after every rejection.** This preserves head-only
triggering but makes description-only fixes unable to progress without an
artificial code event. Head identity remains useful for CI and captured diffs;
it need not be the only signal for a new round.

**Use passing CI and zero unresolved threads without a durable round.** Those
conditions remain true after a successful review and would repeatedly launch
unchanged work. One consumed follow-up per verified publication and a terminal
current-target approval bound the cycle.

**Observe an open-to-resolved count transition.** The author can resolve feedback
before the next poll or before local completion. Stored publication/thread IDs
allow a first resolved observation to consume the follow-up without losing it.

**Apply the conversation gate to publication confirmation.** A successfully
published comment can be followed by a lost completion marker. Its own unresolved
thread would then block confirmation forever. The gate applies to fresh work;
same-round reconciliation requires actual captured-round publication or a valid
matching draft under its original publisher, and does not create a successor.

**Accept the completion marker as publication proof.** The marker reports what
the agent asserts, while remote failure or a summary-only comment can leave no
resolvable feedback. Reading GitHub confirms the required result. Its retries
must be separate from model attempts so a transient lookup failure cannot exhaust
the budget after successful publication.

## Consequences

Authors can correct and resolve feedback without adding commits. Unresolved
feedback from other reviewers and outdated threads intentionally delays fresh
Daynight work. The file-level anchor convention makes PR-wide feedback resolvable
while preserving its actual subject. GitHub API errors keep admission closed and
pending confirmation visible.

Additional fully paginated review/thread reads and retained publication records
are required. Polling observes snapshots, not every intermediate event; durable
follow-up consumption covers fast resolution without claiming an event stream.
The cycle does not dismiss approvals, add webhooks, or provide a general workflow
engine. A future event transport can supply the same complete admission and
publication facts without changing round ownership.

Controlled runtime, SQLite and installed-lifecycle checks establish the state and
publication handshake. Migration checks distinguish completed and active schema 1
records, preserve explicit identity provenance, recover prefixed submitted results
with their actual actor, and retain strict identities for new rounds. They do not
prove arbitrary model judgment, live GitHub
permissions or actual native review publication. Those require their own
source-bound service observations.
