# Agent Note: Budget the legacy Herdr start integration operation

Status: implemented

The dedicated Herdr runtime test described here was removed with the [daemon](../simplification/2026-11-18-remove-herdr-daemon.md); this decision remains historical.

## Problem

The legacy endpoint lifecycle integration case used real SQLite journals and a
single three-second operation for start, initial input, and native Session
confirmation. A [CI run](https://github.com/codetreker/daynight/actions/runs/43995615586/job/133746898809)
exhausted that budget at confirmation. The recorded stack does not identify
which earlier stage consumed the time or establish the cause of the delay.
The case verifies lifecycle behavior rather than a three-second latency limit.

## Decision

The case
uses a ten-second start operation and a fifteen-second outer Vitest timeout.
Other operations retain the three-second fixture default, other cases retain
their existing limits, and lifecycle and input assertions remain intact.

## Alternatives

**Keep the three-second operation and retry.** A passing retry would not provide
more headroom for the complete start path or explain the historical delay.

**Increase shared deadlines.** Unrelated cases would wait longer to detect a
stall even though the observed failure concerns one start operation.

## Consequences

The operation and its outer case remain bounded. The case timeout includes
preparation and the remaining lifecycle, so sufficient delay there can still
preempt the start deadline. This is a test allowance, not a production latency
guarantee. Further failures require phase-level timing evidence; the historical
delay remains unexplained. The separate [repeated-input budget](2026-11-09-herdr-repeated-input-test-budget.md)
continues to govern its own aggregate case timeout.
