# Agent Note: Task Usage Detail

Status: implemented

## Problem

The ordinary Task usage panel could overflow its detail surface and displayed
duplicated unsupported messages while still attempting a records request. A
temporary records failure could also displace data the viewer could still read.

## Decision

The detail surface owns a padded scrolling usage panel. Capability negotiation
gates records independently of summary reads; a confirmed unsupported service
has one neutral explanation in the selected tab. Readable records remain visible
through temporary failures and cursor reset, while access loss clears them. The
[usage specification](../../../../docs/spec/task-token-usage.md#task-用量界面)
owns the user-visible behavior.

## Alternatives

**Use summary success as the records gate.** A transient summary error would
unnecessarily prevent independent records from loading or recovering.

**Show every unsupported response independently.** Repeated messages and a
retryable records error imply separate failures for one service capability.

## Consequences

The panel preserves context and keeps its controls usable at narrow widths.
Capability and record states must remain separate, and permission failures must
still remove private data rather than preserve it for continuity.
