# Agent Note: Durable Herdr Input Arbitration

Status: implemented

## Problem

A per-call mutex cannot protect an unfinished terminal draft between separate
paste and key operations. Automatic continuation and cleanup can append text to
that draft. After a crash, a missing input receipt also cannot establish that
retrying the original assignment is safe. Native attach introduces geometry and
pending-resume effects before the first input byte.

## Decision

All macOS Worker input sources share a durable Session input arbiter, while the
existing lifecycle journal owns process identity and stopping. The
[input design](../../../../docs/design/herdr-input-arbitration.md) owns state,
lease, transport and handback contracts. Operation receipts are immutable;
initial assignment identity survives separately from definitely-unsent retry
attempts. The relay accepts a fenced Worker's dispatching-to-pending projection
after a durable zero-write rejection; it does not independently infer native
write outcomes. Unknown, unconfirmed and completed progress cannot become pending,
and the projection cannot restore suspended automation. Unknown initial delivery can only be resolved through a separately
recorded human decision, never by rewriting the original transport outcome.

Input inspection distinguishes purpose. Automatic and cleanup use the shared
known-menu/disabled-input exclusions and report composer evidence as unavailable;
custom or unknown normal layouts need no positive whitelist. Manual inspection
allows a lease holder to operate menus. Explicit handback and clean orderly
recovery use a separate resume-only empty-field predicate with ANSI attributes
preserved. Codex requires the renderer-DIM placeholder and current field
geometry, not just its words; literal or multiline drafts and ambiguous styles
do not become empty. RGB/indexed color arguments are not DIM evidence. Claude
requires a genuinely blank bordered field and rejects ambiguous Try text.
Optional model, cwd and status-bar content are not requirements. Unknown fields
and drafts cannot become empty. Copilot retains unavailable evidence and its
explicit handback responsibility. The
[structured input decision](../simplification/2026-11-04-worker-structured-input-readiness.md)
owns this distinction and the native launch-directory precondition.

Known automatic blockers before any native write retain their typed waiting
result after the arbiter persists a rejected receipt and, for initial input,
pending state.
The lifecycle projection clears admission and preserves that pending input;
serialization must not convert it into an execution failure. After a possible
native write, the same error remains unknown and cannot authorize replay.

The input journal's identity-checked final receipt owns transport completion even
if the lifecycle projection missed its later commit. Recovery validates the
original Session, claim, run, segment, binding, epoch order and assignment digest;
it does not rewrite a genuinely unknown receipt or its historical projection.

Clean shutdown requires a service-acknowledged, single-use automation recovery
permission before the old channel closes. The service freezes old control and
binds permission to its stop operation and native conversation. Only the exact
next generation with that stop proof and current authorization may consume it.
A newly observed native identity must reach the original run ledger before
preparation. Recovery compares authoritative control fields; capability-filtered
available actions remain a presentation projection. A completed interactive turn
is still an input-capable native process, subject to the same identity and
purpose-specific input checks. Persisted preparation and consumption requests are observed after uncertain
responses, never replayed. The original consumed receipt grants no rights on a
later connection. This is distinct from human handback and the UI capability gate.

Closing is a synchronous persisted transition that precedes cancellation and
native stopping. It does not wait for a browser to release its lease. Automatic
cleanup is conditional on the preceding automation state and input safety;
otherwise controlled stopping proceeds without an advisory prompt.

Strict AttachTerminal uses the original terminal ID and a verified protocol
profile. Read-only native TTY queries establish actual geometry. The
[direct geometry decision](../bug-fix/2026-11-05-herdr-native-input-geometry.md)
replaces the original external-command implementation while preserving every
input admission check; layout
rectangles and observer frame dimensions do not. Every Input frame rechecks
admission, including the Enter after a complete paste. Detach establishes only
transport completion, and does not release the durable manual state.

This extends the [lifecycle decision](2026-11-04-herdr-worker-lifecycle.md).
Its original process evidence and stop proof remain authoritative. The shared
Session protocol and the [recording consumer](2026-11-04-herdr-recording-finalization.md) retain their own responsibilities. The original input-only delivery kept combined capabilities disabled; the recorder now supplies the required persistence and archive integration.

## Alternatives

**Keep agent.prompt and serialize individual calls.** This preserves the old
adapter, but cannot express terminal menus and keys or protect drafts between
calls. It also leaves multiple automatic entry points outside human ownership.

**Use generic terminal control target resolution.** The CLI can fall back from
an absent terminal ID to another named target. Strict terminal identity is
required, so native AttachTerminal has a small, explicitly validated adapter.

**Use the automatic blocker check as empty-composer proof.** A custom or unknown
normal layout may accept automatic input without identifying an empty field.
That unavailable evidence cannot release a manual draft. Codex and Claude need
a positive resume-only empty-field predicate; Copilot has no cross-version
empty-composer contract, so its durable manual ownership and explicit handback
retain that responsibility.

**Infer PTY dimensions from a pane rectangle.** Borders, headers and scrollbar
gutters alter actual dimensions. Native read-only TTY queries preserve the
current geometry without inventing a layout-to-PTY guarantee.

**Infer automation permission from the next generation or native stop proof.**
Those records establish run identity and stopping, but do not distinguish a clean
shutdown from a lost connection, manual draft or unknown input. An explicit
online preparation lets the service persist this distinction before disconnect.

**Suppress dispatching heartbeats to avoid retry transitions.** This hides real
in-flight work from the service and leaves the producer and consumer state
machines inconsistent. A confirmed zero-write outcome is a valid result of a
dispatch attempt; uncertainty remains a separate, non-retryable outcome.

## Consequences

The input journal adds durable storage and retains every operation until final
write revocation. Missing, corrupt or incompatible input evidence fails closed.
A transport result never establishes model acceptance. Native local clients can
still write concurrently, and attach can have effects before an input is rejected.

Recording and UI require their own combination evidence rather than being advertised through
input availability. Future consumers use the same original Session, terminal
binding and control entry points. Expanding the supported native protocol or
removing the handback requirement requires new provider and failure evidence.
