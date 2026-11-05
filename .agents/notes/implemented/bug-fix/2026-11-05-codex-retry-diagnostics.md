# Agent Note: Codex Retry Diagnostics

Status: implemented

## Problem

Codex stream retries arrive through the same error notification method as fatal
errors. Losing the outer retry flag makes intermediate network interruptions
look terminal. Rendering serialized diagnostics as the message also interrupts
reading, including for archived entries whose retry flag was never retained.

## Decision

Interpret the structured notification at the provider boundary and retain three
codes in the existing error entry: `native_retry`, `native_turn_error`, and
`native_error`. Only a literal true retry flag with a matching current thread
and turn permits the neutral retry presentation. Unknown data remains visible
as an error. Failed turn completion retains a diagnostic even when no preceding
error notification was observed. Retry entries describe historical observations,
not a live network status or a promise of eventual success.

The fixed native protocol separates
[retry notifications](https://github.com/openai/codex/blob/48524f337a84b570f0c2453ca43ec9a1a29375c0/codex-rs/app-server/src/bespoke_event_handling.rs#L1082)
from [terminal errors](https://github.com/openai/codex/blob/48524f337a84b570f0c2453ca43ec9a1a29375c0/codex-rs/app-server/src/bespoke_event_handling.rs#L1680).
The former deliberately do not set the turn's final error. Native completion,
not subsequent text, continues to own the turn result.

Use a bounded JSON envelope inside the existing message string for a readable
summary and retained raw details. The browser renders a short summary and a
keyboard-accessible disclosure for details. Historic JSON can yield a readable
summary but cannot recover a missing retry flag. The
[Session design](../../../../docs/design/task-session-protocol.md#codex-重试与错误详情)
owns the data path and presentation rules.

## Alternatives

**Infer retry from message text or error type.** A disconnection can exhaust its
retry budget, and localized text does not establish the native retry decision.
This would hide genuine failures and invent history.

**Add severity and details fields to the wire entry.** Strict parsers across
Controller, Go and Web would require coordinated schema changes and old-client
handling. Existing free-form error codes already support presentation distinctions
such as cancellation. Keeping the existing shape avoids that migration cost.

**Revise retry rows when assistant text resumes.** Text is not proof of recovery.
Retaining the original notice avoids a second state machine whose transitions
cannot be established from reliable native events.

## Consequences

Retries no longer demand attention as terminal alerts, while unknown and final
failures remain visible. Raw retained diagnostics are available on demand and
old archives receive the same read-only improvement. Old clients can still read
the entry shape, although they retain their older error presentation.

This does not repair network connectivity or alter native retry policy. Details
remain bounded and explicitly indicate truncation. A future live recovery
indicator would need a reliable native signal and identity-aware lifecycle;
it must not be derived from ordinary output or transport availability.
