# Agent Note: Watchdog application

Status: implemented

## Problem

An in-progress project task can remain idle, disconnected or awaiting input long
after its user stops watching the Session. Repeated manual intervention loses
the evidence needed to distinguish a transient pause from a recurring problem.
Automatic assistance must preserve the original execution identity and avoid
repeating an input when its outcome cannot be established.

## Decision

Watchdog runs as an application of the existing assistant-task lease runtime.
Its deterministic evaluator owns anomaly durations, persistent episodes,
recurrence and direct-message attempts. The generic assistant-task core retains
ownership of claims, manuals, records and events. The server registers an
application-specific rules validator and provides an atomic per-user preset
that matches the website's selected-assistant contract.

The evaluator persists each attempt's operation ID and execution fence before
submission. Recovery queries that operation only. One item permits at most one
attempt, including after rule changes or recurrence. A short recurrence that
recovers before reporting retains its episode and action history. Previously
stored empty-object manuals remain valid comparison baselines so users can
repair them with strictly validated replacement rules. Complete authorized reads
are needed to resolve a disappearing task; permission loss is not completion.
The [design](../../../../docs/design/assistant-task.md#watchdog-应用) owns the
timings, rule fields, notification semantics and preset contract.

Live inspection entries can lack provider timestamps. Watchdog persists when it
first confirms an unchanged complete input/history snapshot, bound to the
execution and connection identity. Two minutes of sufficiently frequent matching
observations establish a conservative quiet interval; changed or incomplete
evidence resets it. Final submission verifies that same evidence again.
Oversized user entries can retain complete page coverage while losing their
inline origin. Such entries still constrain recent-input handling, but cannot
prove human progress and suppress escalation.
Persisted evidence uses bounded previews with original byte counts and hashes.
Action attempts reference an immutable manual version and rule position for the
complete approved message. The outbox carries references instead of duplicating
large bodies, so a valid send cannot consume the capacity needed to record its
result and escalation. Escalation uses a separate persisted follow-up baseline
recorded after submission returns. Recovery without that baseline starts it
conservatively after observing the original operation, preserving the original
intent time without counting preparation or transport delay as response time.
Progress uses stable entry IDs and revisions independently of the history epoch:
a Controller reconnect invalidates quiet evidence, but unchanged persisted
entries do not discharge the follow-up obligation.

## Alternatives

**Let the assistant decide and send.** A prompt cannot reliably enforce the
single-attempt limit, unknown-result recovery or escalation timing. The assistant
explains observed events and develops evidence-based manual proposals, while
deterministic code performs the narrowly permitted action.

**Evaluate on the server.** This would add a scheduler and coordination across
server instances. The existing Worker lease already selects the responsible
application and transfers persistent state when a Worker disappears.

**Retry a persisted but unconfirmed submission.** A crash between saving intent
and sending cannot distinguish an unsent message from a sent message with a lost
receipt. Query-only recovery can leave an action unperformed, but avoids duplicate
inputs to the user's execution.

**Infer resolution from list absence.** A project can disappear because access
changed. Reading the original task before resolution preserves that distinction
at the cost of retaining unresolved evidence when access is unavailable.

**Store complete text in every evidence copy.** An approved message can fit the
manual and send limits while its duplicated attempt and outbox exceed the item
write limit. Bounded previews and immutable source references retain the needed
evidence without making post-send recovery unwritable.

**Require provider timestamps for every input.** The current live inspection
producer supplies null timestamps, so this would permanently disable direct
handling for ordinary conversations. Observed quiet intervals preserve the
recent-input safeguard without inventing timestamps or expanding the shared
history protocol.

## Consequences

Monitoring continues without an LLM turn or spare project-task capacity. State
survives assistant takeover, including pending records, reports and original
operation identities. Initial rules are empty, so direct handling requires an
approved manual change. Rule validation and bounded regular-expression matching
keep the direct-action vocabulary narrow.

Polling adds per-project work overview reads and full observations for matching
tasks. Incomplete evidence suppresses actions and retains unresolved items.
Operation queries cannot establish an absent receipt as an unsent request.
These are deliberate availability costs of preserving single-attempt behavior;
broader actions or cross-project query optimization require their own decisions.
