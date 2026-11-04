# Agent Note: Confirm CLI Step content and status updates

Status: implemented

## Problem

Updating a Task-owned Step must preserve every omitted field and distinguish a
same-value receipt from a real change. A parent version alone cannot prove that
the target fields match, and an unknown response can follow a committed change.
The CLI must retain complete output and original identity without adding reads
to the explicit-version path or duplicating the Add write lifecycle.

## Decision

The [CLI update contract](../../../../docs/spec/daynight-task-steps.md#cli-更新与状态确认)
provides `task step update` for title/description and `task step set-status` for
all four Step states. The command definition tree owns help and completion;
`step-update.ts` validates raw text, task-local IDs and exact int64 versions
before loading configuration or making requests. Omitted values remain absent
from the PATCH body; an empty description is an explicit value.

Both commands share the [Add write owner](2026-11-04-task-steps-cli-add.md).
`step-write.ts` freezes operation, original project/task/Step identity, payload,
version and a separate request UUID. Explicit versions send one PATCH or PUT;
default versions read complete Steps before one write. Failed pre-reads prevent
submission. The typed API uses the existing JSON/principal/budget transport and
strict resource parser, with 200 confirmation specialized for content or status.

A successful receipt must contain the requested target and fields with the exact
submitted version or +1. A real pre-read additionally proves unchanged membership,
order, non-target fields, omitted target values and creation time. Equal values
require the original version and update time; changed values require +1 and a
changed target update time. An explicit version has no invented old baseline.

Operation-specific errors retain Add's refusal/unknown/confirmed distinction.
A same-operation UUID.r1 GET can observe current facts once while its operation
remains live; it neither attributes historical success nor retries a write.
Confirmed rendering/output/cleanup failures retain confirmation and exit nonzero.
Safe diagnostics preserve original IDs and capacity details without payloads.

## Alternatives

**Fetch a baseline even with an explicit version.** This would violate the
one-write request budget and cannot recreate the caller's earlier observation.
The receipt is checked against the submitted fields and available facts instead.

**Accept any original/+1 parent version.** A wrong target value, altered omitted
field or changed unrelated row could then be presented as confirmed success.
Target checks always apply; actual pre-reads permit the stronger comparisons.

**Implement separate mutation/recovery executors.** The three Step writes have
the same lifetime, identity and outcome rules. Sharing that existing owner keeps
Add behavior and avoids divergent cancellation or confirmation handling.

## Consequences

The two operations remain independent of Task status and project workflow rules.
Both output the complete confirmed collection; JSON keeps exact bigint numbers.
Explicit-version verification is necessarily limited to facts available without
a hidden read. API and command tests cover bad receipts and lifetime failures;
packed launchers and real Go/PostgreSQL cases cover complementary installation
and persistence behavior. Move/delete and Agent workflow instructions keep their
separate delivery scope.
