# Agent Note: Historical Credential Process Fixture

Status: implemented

## Problem

Credential migration process tests need the database format that preceded scope
activation. Removing later objects from a current snapshot leaves future schema
changes in the supposed historical database and can invalidate upgrade evidence.

## Decision

The startup-shutdown and webhook test builds provide a PostgreSQL fixture that
loads the 099 baseline into an empty namespace and replays the registered
migrations through 107. It uses the migration executor and validates the
original prefix checksums. The credential process test checks historical
structure and ledger before starting the candidate and retains its migration,
occupied-listener failure and recovery checks. The
[099 baseline decision](../architecture/2026-11-24-postgres-migration-baseline.md)
owns the preserved effects and checksums of the earlier Go transforms.

## Alternatives

**Reverse the current snapshot.** This requires anticipating every later schema
change and can silently leave unrelated additions in the historical fixture.

**Execute historical SQL alone.** Migrations 026 and 083 also contain frozen Go
transforms and require their registered checksum semantics.

## Consequences

The fixture stays anchored to the 107 checkpoint while later migrations extend
the candidate. It refuses a nonempty target namespace. Replay retains the
original version decisions for the steps after the baseline.
