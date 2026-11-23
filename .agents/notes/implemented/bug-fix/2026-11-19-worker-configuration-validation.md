# Agent Note: Align Worker configuration draft validation

Status: implemented

## Problem

The Worker configuration form accepted numeric drafts beyond the service's
write limits and repeated those broader limits in field feedback. A rejected
save then hid the service's validation explanation behind a generic failure,
leaving users without the information needed to correct their retained draft.

## Decision

The configuration model owns one numeric range table for draft parsing and
field feedback, following the existing [configuration contract](../../../../docs/spec/daynight-worker-configuration.md).
The API keeps its historical read ranges so stored values remain visible and
correctable. Independent native and Project comparisons do not depend on those
historical numbers passing current draft validation.

The save error presentation includes the service message for a confirmed
server-class HTTP 400 `invalid_input`, rendered as text alongside the existing
failure, retained-draft explanation and request ID. Message wording does not
control field state or authorize a retry. Other error classifications keep their
existing behavior.

## Alternatives

**Tighten the API decoder along with draft validation.** This would reject
historical targets before users could inspect or repair them.

**Rely only on server rejection.** This preserves the mismatch between field
feedback and the write contract and adds avoidable failed requests.

## Consequences

Invalid drafts remain editable and cannot be submitted until corrected. Range
changes must update the module's table together with the service contract.
Service validation text may use the service's language; displaying it preserves
the actual explanation without relying on English message parsing. Browser
checks with controlled responses establish presentation and request behavior,
not production persistence or Worker application.
