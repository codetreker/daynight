# Agent Note: Controller Storage Contention Cancellation

Status: implemented

## Problem

The ownership-gate test proves real SQLite contention against a live
Controller owner. It then cancels the spawned Controller through IPC. The
Controller can start a second synchronous SQLite wait before the parent
delivers cancellation. A native trace observed one SQLITE_BUSY acquisition at
about 5.4 seconds when stop was prompt, and two at about 5.4 seconds each when
the parent sent stop 200 ms after the busy observation.

## Decision

The [Controller storage fixture](../../../../packages/daynight/test/fixtures/controller-storage-wait.mjs)
lets actual SQLite contend at the default timeout. In the ownership-gate
scenario it captures the 100 ms retry immediately following the real busy
diagnostic and acknowledges the held timer over IPC. The parent waits for both
the diagnostic and the acknowledgement, then sends the original stop message.
The child must clear the held timer through runtime cancellation and return
naturally. The test retains the real first wait, live owner, unchanged lock,
unpublished generation, and empty journal. The separately tested permit-only
path uses its native timer.

## Alternatives

**Shorten or mock the SQLite busy wait.** This would remove the test's
existing native default-budget observation and could bypass error classification.

**Send stop immediately on the diagnostic.** The observer and the child run
in separate processes. Native scheduling can let the retry begin before IPC
arrives, adding another full wait without exercising a different contract.

## Consequences

The test still pays for the first real busy expiry. The IPC handshake removes
the scheduling race that could make it pay for an incidental second one. No
production timeout, retry, or cancellation behavior changes.
