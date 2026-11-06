# Agent Note: Web Task API Proof Ownership

Status: implemented

## Problem

A status request uses the same transport and failure path for every valid target.
Expanding those failures across a target-state matrix repeats the same proof and
obscures which assertions depend on the requested status. Platform and permission
input matrices have a related boundary: repeating each strict decoder failure
through the same HTTP wrapper adds no new field-specific transport behavior.

## Decision

`tests/status-api.test.ts` separates target-dependent confirmation from shared
transport failures. All three status targets retain exact numeric request bodies,
int64 version inputs, unchanged or incremented response versions, response scope
and version mismatches, contradictory statuses and unexpected successful HTTP
statuses. Lossless JSON and malformed numeric-wire version cases retain their
existing owner and inputs.

One shared failure group uses a valid `todo` target for the three server refusal
codes, unauthorized notification, maximum-int64 refusal, malformed request input,
network and body causes, and cancellation before I/O. It retains error kinds,
causes, request IDs, exact maximum-version serialization, fetch counts and the
absence of I/O after pre-abort. These cases exercise shared request and error
handling; their proof does not depend on which valid status was requested.

`tests/task-platform-api.test.ts` and `tests/agent-permission-api.test.ts` keep
all nine malformed platform inputs and all eight malformed permission inputs.
Every row still checks both task-detail and task-graph parsing. Each file has one
separate HTTP case confirming that `getTask` rejects malformed field data as a
protocol error: the platform alias `darwin` and the permission string `true`.
The wrapper always calls the same strict detail decoder, while the decoder
matrices own missing values, scalar types, aliases, casing and container inputs.
Valid values, exact-version writes, no-ops, contradictions and cancellation
retain their existing assertions.

## Alternatives

**Keep all target and wrapper expansions.** Repeating shared errors for valid
status targets and repeating the HTTP wrapper for every malformed field makes
those cases harder to distinguish from the target-specific and strict-decoder
proofs they accompany.

**Reduce the malformed decoder tables to representatives.** Each input class can
expose a different validation error. Both parser tables keep their complete
boundaries; only the transport repetition is removed.

**Abstract all contracts into a shared mutable fixture or generic test helper.**
The three files have different domains and write-confirmation rules. Directly
separating their existing cases expresses ownership without adding fixture state
or hiding the retained assertions behind another abstraction.

## Consequences

Shared status errors execute once, and malformed platform and permission matrices
no longer create a mocked HTTP response on every row. The two HTTP representatives
still detect a bypassed detail parser or incorrect protocol classification, while
the full decoder matrices continue to detect relaxed field validation.

This reduces duplicate proof and its maintenance cost. These API files are small;
fewer expansions alone do not establish a meaningful whole-suite or CI speedup.
New target-specific transport branches would require revisiting the shared group.
New field-specific HTTP behavior would likewise need its own wrapper case.
Production behavior, test discovery, isolation, coverage and required gates remain
unchanged.
