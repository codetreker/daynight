# Agent Note: HTTP Error Acceptance Metadata

Status: implemented

## Problem

A public HTTP error must hide SQL diagnostics while retaining its request ID for
correlation. The built-process acceptance oracle scanned the whole response body
for the literal SQL marker, including that opaque metadata. The
[original oracle](https://github.com/codetreker/daynight/blob/ff9daf9e0b747f7c7bfd1f2c2e0191a7f419ab70/packages/daynight-server/cmd/daynight-server/acceptance_process_test.go)
predates the [failed mainline run](https://github.com/codetreker/daynight/actions/runs/39453982382).

The server uses [crypto/rand.Text](https://pkg.go.dev/crypto/rand#Text) when it
needs a request ID. Its standard base32 alphabet permits the letters in SQL;
that substring alone does not turn an ID into a database diagnostic. A controlled
counterexample used such an ID with the real cursor handler and received its
fixed invalid-cursor refusal before database access. The oracle rejected that
response solely because of the ID. The hosted failure did not retain its literal
response body, so the controlled ID is not attributed to that run.

## Decision

Error acceptance retains the expected HTTP status and error code, JSON content
type and nonempty message checks. Its diagnostic view requires exactly one
nonempty, syntactically valid X-Request-ID header, unambiguous root/error objects
and a direct string error.requestId equal to that header. Missing, duplicate,
malformed or mismatched metadata fails explicitly.

Only that verified direct value is replaced with an empty JSON string for the
SQL-marker scan. Every other original byte remains intact, including object
keys, unknown members, nested requestId values and numeric spelling/precision.
This preserves the complete envelope instead of projecting the known error DTO
or decoding and re-encoding unrelated diagnostic content.

Known secret-marker and PostgreSQL-URL checks still inspect the entire response
body, including metadata. The exemption is only for the SQL-marker check at the
verified correlation member; requestId members elsewhere in the envelope remain
subject to diagnostic checks. Production request-ID generation and error
responses are unchanged.

Regression cases accept valid correlated metadata containing SQL and reject
invalid or ambiguous correlation metadata, SQL in diagnostic values and keys,
and known secret or database-URL disclosure. Existing status/code assertions
remain active in the built-binary workflows. One existing cursor refusal in that
suite supplies an explicit SQL-containing ID; the other cursor cases retain
generated IDs. This exercises the metadata distinction without removing the
original generated-ID coverage.

## Alternatives

**Change production IDs or force every test ID.** The production namespace permits
these tokens. Changing it or avoiding generated IDs would hide the oracle defect
and alter unrelated behavior or coverage.

**Inspect only the known error DTO.** Decoding drops unknown members, allowing
unexpected diagnostic fields to escape the privacy assertion.

**Remove the SQL check.** This would stop detecting SQL disclosure in messages,
details and other diagnostic fields. Excluding only verified correlation
metadata preserves that check.

## Consequences

The assertion distinguishes opaque correlation metadata from diagnostic content
while retaining status, code, header correlation and privacy requirements. It
adds no production helper, timeout, coverage exclusion or weakened acceptance
gate. The [built-process acceptance decision](../testing/2026-10-19-server-process-acceptance.md)
continues to own process, transaction and cleanup verification; the
[server README](../../../../packages/daynight-server/README.md#built-process-acceptance-and-ci-evidence)
owns reusable validation instructions. Execution results belong to the tested
revision's PR and CI under the
[source-bound evidence policy](../process/2026-10-20-source-bound-validation-evidence.md).
