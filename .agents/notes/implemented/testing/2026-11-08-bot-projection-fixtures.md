# Agent Note: Bot projection fixtures cross encoded limits with less raw data

Status: implemented

## Problem

The former bounded Bot DAO tests distinguished omitted fields, projected fields
exceeding a SQL byte guard, and JSON aliases whose later value replaced an
earlier value. Their initial fixtures used 18-million-byte ASCII strings to
cross the 16 MiB plus 4096-byte projection guard. The omission test retained its
large unused override while adding another large role field, combining
independent proofs with unnecessary live input volume.

The SQL projection extracted fields through `jsonb_each`, which materializes
object entries before filtering keys. Repeated field projections could amplify
allocation for large stored values. The
[PostgreSQL implementation](https://github.com/postgres/postgres/blob/1da6ddbdc32c5bf640429828bc0353ffcb40628e/src/backend/utils/adt/jsonfuncs.c#L1974-L2047)
explains that materialization; it did not establish an allocation multiplier
for the query.

## Decision

The [canonical-read simplification](../simplification/2026-11-09-worker-bot-canonical-reads.md)
removes the production SQL interpreter, byte guard and their stored-row refusal
and alias test requirements. Bot DAO tests now exercise ordinary canonical
reads, complete output, authorization, count pagination and natural decoding
errors. Accepted role writes retain the 65,536-byte instruction limit.

When the guard was active, fixtures used U+0001, represented by PostgreSQL as
six JSON bytes. A 2,796,886-byte value encoded as 16,781,318 bytes including its
quotes, crossing the 16,781,312-byte guard. A real SQL length query checked and
reported both lengths before installation. The omission case stored an oversized
unused override and verified that it did not affect the page; that override was
removed before testing an oversized returned role. The alias case compared the
full Go decode with SQL after a large `Instructions` value was replaced by later
`instructions`. Unicode folding, malformed-type and null-reset assertions were
retained at that decision. Production SQL, guards and write admission were
unchanged by the fixture reduction.

## Alternatives

**Keep the 18-million-byte ASCII values.** They crossed the guard with
approximately 6.4 times the raw bytes required for the same refusal and
field-omission distinctions.

**Lower the production guard for testing.** This would have changed the returned
row boundary and required a separate configuration mechanism. Escaped input
reached the actual boundary without changing production behavior.

**Remove the oversized or alias cases while retaining the guard.** This would
have lost the distinction between omitted, returned and replaced values. The
smaller fixtures preserved those SQL proofs while the mechanism was active.
Their later removal follows the changed production responsibility, rather than
a further fixture-size trade-off.

## Consequences

The fixture reduction cut each large value to 2,796,886 raw bytes and avoided
retaining unrelated large fields in the returned-role phase. It preserved the
real length query, decoder comparison and refusal assertions at that time.
Those historical proofs do not define today's canonical read behavior.

Raw byte reduction did not establish peak database memory or CI savings. Such
claims require the same explicit memory and CPU limits, complete package and
surrounding validation gates. The later read simplification owns the removal
of the guarded query itself.
