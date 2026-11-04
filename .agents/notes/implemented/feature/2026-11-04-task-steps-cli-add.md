# Agent Note: Confirmed CLI Step writes and factual recovery

Status: implemented

## Problem

A command that creates or changes a Task-owned record must preserve the identity
chosen before submission and distinguish a trusted receipt from a lost or malformed
response. An unconfirmed write can already be committed, while a later local
output failure can follow a fully confirmed write. Conflating those states can
cause duplicate records, false rollback claims or retries after cancellation.
The client also needs complete ordered output and exact parent-version admission.

## Decision

The [Steps contract](../../../../docs/spec/daynight-task-steps.md#cli-添加与结果确认)
provides Add and [Delete](../../../../docs/spec/daynight-task-steps.md#cli-删除与结果确认) alongside the existing
[read foundation](2026-11-04-task-steps-cli-reads.md). `step-add.ts` validates
arguments and selects an explicit canonical eight-hex ID or one UUIDv4 first
segment. `step-write.ts` creates a separate request UUID and freezes the actual
project/task/Step identity, payload and version. Explicit versions send one POST;
default versions read complete Steps once before that POST. A failed pre-read
prevents submission. Delete uses the same version preparation and result-handling
helper with a separate operation discriminator, original target ID and
version-only payload. Explicit versions send one JSON DELETE; default versions
read Steps first. The shared `performStepWrite` handler serves Add,
[content/status updates](2026-11-04-task-steps-cli-updates.md),
[Move](2026-11-04-task-steps-cli-move.md) and Delete through operation-tagged
attempts without a registry of future mutations.

`addTaskStep` uses the existing transport, principal, JSON decoder and resource
parser. It confirms only a 201 with canonical Location, correct scope, exact
version +1, matching effective target fields, equal new timestamps and correct
append/anchor placement. When a real pre-read exists, its old records must remain
unchanged in the returned collection. Explicit versions do not add a hidden read
or invent an old baseline. JSON output is only the complete confirmed resource;
readable output prefixes that resource with the confirmed short ID. Delete
confirms a complete 200 resource, principal, exact version +1 and target absence.
With a real pre-read, it also verifies that the target existed and all surviving
records retain their fields, timestamps and relative order. Explicit Delete
versions likewise do not manufacture a baseline.

The existing transport confirmation marker is `confirmedMutationId`, consumed
by Thread and the Step writes. It is set immediately after strict receipt checks
and survives catch/finally cleanup along with decoded refusal metadata and original causes.
The shared runtime accepts caller-provided safe failureText for output/cleanup;
Thread retains its existing wording. A confirmed Step write remains
confirmed after local rendering, output or cleanup failure and exits nonzero without becoming
unknown or requesting another business observation. Output failure may leave
partial stdout.

A fully decoded 4xx is a known refusal. A dispatched write without a trusted
receipt remains unknown. At most one full Steps GET with originalUUID.r1 can
observe current version and target found/absent through the same still-live
Operation, API, credentials and original scope. It does not confirm the historical write,
change its nonzero exit or produce success stdout. Cancellation or exhausted
operation budgets create no detached recovery. A failed observation uses neither
the old pre-read nor another attempt; diagnostics provide ordinary explicit-project
list/show guidance. No mutation replay or identity regeneration occurs.

Diagnostics preserve the original UUID separately from server/error/response
IDs. Echo equality has no confirmation role. Safe typed capacity details survive
error conversion, while payloads and arbitrary internal/configuration/Git/cleanup
messages remain internal causes. The existing PT4 discovery facts and read safety
boundary remain in use. Request and recovery bytes/time consume the same
unchanged operation budgets, with the inclusive Steps response cap.

## Alternatives

**Treat a failed write response as rollback and retry.** The server may already
have committed. Preserving the original ID and unknown outcome prevents another
write or replacement identity from obscuring that fact.

**Start a fresh recovery operation after cancellation or budget exhaustion.**
That overrides the lifetime selected by the caller and removes the observation
from the original accounting. One eligible same-operation read preserves the
budget and cancellation boundaries; no observation is an explicit result.

**Confirm from a matching request-ID echo or a plausible target alone.** IDs
are diagnostic correlation, and current presence does not establish historical
attribution. Complete receipts check version and the operation result: new fields/times and
placement for Add, target absence for Delete, fields for content/status updates,
position for Move, and surviving rows when a real baseline exists.

**Reuse only a generic failure message after confirmation.** This would erase a
known committed result when local output or cleanup fails. Reusing the existing
transport/runtime confirmation owner preserves the fact without a
second HTTP executor or persistent operation ledger.

## Consequences

Add retains exact parent versions, raw text, task-local placement and complete
service-confirmed output. Default-mode confirmation can compare prior rows;
explicit-mode confirmation is limited to facts available without another GET.
Known refusal, unknown, and confirmed local failure remain distinct and retain
original identity through their diagnostics. Current absence after an unknown
Delete cannot prove which request removed a record, and current same-ID presence
cannot establish that the original record survived.

Pure/client/command cases cover strict receipts, request counts, safe discovery,
capacity details and lifetime failures. Installed real-server cases cover normal
Add/Delete and the Move cases owned by its movement decision, including lost
responses after real commits. Opt-in capacity stress uses the actual clock and
producer bytes, separate from CLI JSON bytes and routine CI. Fixture
calibration continues only after known complete results and fails on unknown
receipts. Literal launchers, real Go/PostgreSQL interoperability and copied
manual bytes keep their existing separate evidence owners.
[Content/status updates](2026-11-04-task-steps-cli-updates.md) and
[Move](2026-11-04-task-steps-cli-move.md) reuse this result handler and add their
own field, position and version confirmation. No Agent workflow mode, history
store or recovery queue is introduced.
