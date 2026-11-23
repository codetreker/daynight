# Agent Note: Historical Credential Process Fixture

Status: implemented

## Problem

Credential migration process tests need the database format that preceded scope
activation. Removing later objects from a current snapshot leaves future schema
changes in the supposed historical database and can invalidate upgrade evidence.

## Decision

The startup-shutdown and webhook test builds provide a PostgreSQL fixture that
replays the registered migration prefix through version 107 into an empty
namespace. It uses the migration executor, including frozen Go transforms and
ledger checksums. The credential process test checks historical structure and
ledger before starting the candidate and retains its migration, occupied-listener
failure and recovery checks.

## Alternatives

**Reverse the current snapshot.** This requires anticipating every later schema
change and can silently leave unrelated additions in the historical fixture.

**Execute historical SQL alone.** Migrations 026 and 083 also contain frozen Go
transforms and require their registered checksum semantics.

## Consequences

The fixture remains anchored to the historical registry while later migrations
can extend the candidate. Replay costs additional database transactions and relies
on the immutable migration history; it refuses a nonempty target namespace.
