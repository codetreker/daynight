# Agent Note: Controller Worker Input Admission

Status: implemented

## Problem

A Worker can observe an idle native session before another input or a task authorization change reaches the Controller. Sending from that earlier observation can inject text into a busy or no longer authorized execution. Native operation receipts also need to survive lost responses without treating locally originated messages as remote commands.

## Decision

Worker initial and subsequent text inputs enter the Controller's existing native queue. At dispatch, the Controller reads the current task using the ticket's service and user, checks the original active claim and local readiness, and checks readiness again after the read. The initial operation retains its identity and frozen text; later input uses `worker_input` in the existing journal. Relay reconciliation excludes this local operation kind while retaining remote messages with the same display origin. The private observe response advertises the complete input protocol. The [Worker design](../../../../docs/design/daynight-worker.md) owns the dispatch contract and limits.

## Alternatives

**Check only in the Worker before IPC.** A user message or task change can occur while input waits behind another native command, so the earlier observation cannot establish readiness at dispatch.

**Treat local messages as remote commands.** Relay reconciliation would submit operation identities the service never registered. Filtering by display origin would also discard legitimate remote messages.

## Consequences

A fresh task read adds a service dependency to each Worker input and cannot make task authorization and native dispatch atomic. A failed read does not submit input. Existing journal operations retain their uncertainty and late acknowledgement semantics; no separate ping state or migration is introduced. The [Worker patrol decision](2026-11-17-web-worker-patrol.md) builds periodic input and adoption of older running Controllers on this capability.
