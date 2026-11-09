# Agent Note: Separate status confirmation wiring from receipt verification

Status: implemented

## Problem

Each status transition in the confirmation matrix renders the detail surface and
repeats the complete asynchronous session and cache lifecycle. The matrix must
still catch an incorrect target or captured version, while status receipts and
failure handling require real session tests.

## Decision

The nine existing-to-target combinations exercise the real detail surface,
status menu and confirmation with a controlled detail-session result and no
reading panel. Each checks
the displayed route and the exact target and reviewed version sent to the
session. The status-session suite owns the corresponding receipt and state
transition matrix. A separate complete surface-to-session case retains the
double-click, pending and confirmed-receipt checks. Fresh-read invalidation,
draft retention, focus, cancellation and Worker claim restrictions retain their
full-surface tests.

## Alternatives

**Repeat every transition through the complete session.** This verifies each
combination end to end, but repeats session and cache work already covered by the
session matrix. The retained full integration case checks the shared connection.

**Replace the menu and confirmation with a test-only wiring function.** This
would remove UI work but would not check the actual surface's captured target
and version. The matrix keeps those production components.

## Consequences

The matrix depends on the session hook's return shape and checks its boundary
rather than every combination's end-to-end receipt. A change to hook forwarding
or transition-specific integration requires reassessing the retained integration
case and session coverage. Focus, pending, failure and no-replay guarantees
continue to belong to their existing tests. The [Web validation guide](../../../../packages/daynight-web/README.md#validation-and-build)
owns the complete coverage gate.
