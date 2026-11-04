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
attempts. Unknown initial delivery can only be resolved through a separately
recorded human decision, never by rewriting the original transport outcome.

Closing is a synchronous persisted transition that precedes cancellation and
native stopping. It does not wait for a browser to release its lease. Automatic
cleanup is conditional on the preceding automation state and input safety;
otherwise controlled stopping proceeds without an advisory prompt.

Strict AttachTerminal uses the original terminal ID and a verified protocol
profile. Read-only native TTY queries establish actual geometry; layout
rectangles and observer frame dimensions do not. Every Input frame rechecks
admission, including the Enter after a complete paste. Detach establishes only
transport completion, and does not release the durable manual state.

This extends the [lifecycle decision](2026-11-04-herdr-worker-lifecycle.md).
Its original process evidence and stop proof remain authoritative. The shared
Session protocol and future recording consumer retain their own responsibilities;
combined observe/control/archive capabilities remain disabled.

## Alternatives

**Keep agent.prompt and serialize individual calls.** This preserves the old
adapter, but cannot express terminal menus and keys or protect drafts between
calls. It also leaves multiple automatic entry points outside human ownership.

**Use generic terminal control target resolution.** The CLI can fall back from
an absent terminal ID to another named target. Strict terminal identity is
required, so native AttachTerminal has a small, explicitly validated adapter.

**Treat native idle or a screen as proof of an empty composer.** Copilot has no
cross-version empty-composer contract. Durable manual ownership and explicit
handback carry the responsibility that idle cannot establish.

**Infer PTY dimensions from a pane rectangle.** Borders, headers and scrollbar
gutters alter actual dimensions. Native read-only TTY queries preserve the
current geometry without inventing a layout-to-PTY guarantee.

## Consequences

The input journal adds durable storage and retains every operation until final
write revocation. Missing, corrupt or incompatible input evidence fails closed.
A transport result never establishes model acceptance. Native local clients can
still write concurrently, and attach can have effects before an input is rejected.

Incomplete recording and UI remain gated rather than being advertised through
input availability. Future consumers use the same original Session, terminal
binding and control entry points. Expanding the supported native protocol or
removing the handback requirement requires new provider and failure evidence.
