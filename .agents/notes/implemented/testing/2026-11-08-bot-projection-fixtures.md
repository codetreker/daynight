# Agent Note: Bot projection fixtures cross encoded limits with less raw data

Status: implemented

## Problem

The bounded Bot DAO tests need to distinguish omitted fields, projected fields
that exceed the SQL byte guard, and JSON aliases whose later value replaces an
earlier value. The fixtures used 18-million-byte ASCII strings to cross the
16 MiB plus 4096-byte projection guard. The omission test retained its large
unused override while adding another large role field, combining independent
proofs with unnecessary live input volume.

The SQL projection extracts fields through `jsonb_each`, which materializes
object entries before filtering keys. Repeated field projections can amplify
allocation for large stored values. The
[PostgreSQL implementation](https://github.com/postgres/postgres/blob/1da6ddbdc32c5bf640429828bc0353ffcb40628e/src/backend/utils/adt/jsonfuncs.c#L1974-L2047)
explains that materialization; it does not establish an allocation multiplier
for this query.

## Decision

The fixtures use U+0001, which PostgreSQL represents as six JSON bytes. A
2,796,886-byte value encodes as 16,781,318 bytes including its surrounding quotes,
crossing the unchanged 16,781,312-byte SQL guard. A real SQL length query checks
that expansion and reports both lengths before each fixture is installed.

The omitted-field case still stores an oversized unused override and verifies
that it does not affect the returned page. Before testing the oversized returned
role, the fixture removes that override and keeps the original remaining fields.
The alias case still compares the full Go decode with the SQL projection after
a large `Instructions` value is replaced by the later `instructions` value.
The subsequent Unicode folding, malformed-type and null-reset cases retain
their existing assertions.

Production SQL, byte guards and write admission remain unchanged. Accepted role
writes retain their 65,536-byte instruction limit; these fixtures exercise the
DAO's defensive stored-row projection boundary.

## Alternatives

**Keep the 18-million-byte ASCII values.** They exceed the encoded guard, but
use approximately 6.4 times the raw fixture bytes needed for the same refusal
and field-omission distinctions.

**Lower the production guard for testing.** This changes the returned-row
boundary and requires a separate configuration mechanism. Escaped input reaches
the existing boundary without changing production behavior.

**Remove the oversized or alias cases.** This loses the distinction between an
omitted large value, a returned large value, and a replaced alias. The smaller
fixtures preserve those real SQL proofs.

## Consequences

Each large fixture value uses 2,796,886 raw bytes while still exceeding the SQL
encoded-byte guard. The omission and returned-role phases no longer retain
unrelated large fields in the current candidate row. The real database query,
complete-decoder comparison and refusal assertions remain in the ordinary DAO
suite.

Raw byte reduction alone does not establish peak database memory or CI savings.
Those require execution under the same explicit memory and CPU limits, including
the complete package and surrounding validation gates.
