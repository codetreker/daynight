# Agent Note: Bot Runtime HTTP Test Owners

Status: implemented

## Problem

The Bot preflight and deletion receipt HTTP matrices each build a complete
application, authenticate through UniAuth and prepare a PostgreSQL schema. The
resource setup is repeated for strict HTTP input and admission cases. Those
tests also observe genuine startup version checks and cleanup of an unbound
Bot, which require an assembled application and persisted readback.

## Decision

The strict matrices register the production Bot runtime routes and retain the
Session HTTP parameter, body and response handling and PAT middleware. ReportBot
and CompleteBotDeletion verify the exact principal, request context, Worker
and Bot identifiers and typed payload. A malformed body, media type, query,
identifier, method or anonymous request must be refused without a Bot operation.
Valid requests reach their operation once with a supplied result or refusal.
The response checks retain the pending-to-failed report projection, stale
version conflict, replayed version, wrong Worker refusals and redacted cleanup
receipt. [Bot expiry HTTP decision](2026-11-10-bot-expiry-http-test-owners.md)

The assembled registration test uses its existing Worker and schema with a
separate Bot for preflight failure. It checks startup state and lack of
Session binding, stale-report refusal, replay stability and wrong Worker
refusal, then reads the version and startup result again. The assembled
deletion test uses another Bot in its existing schema for wrong Worker refusal,
pending deletion intent and a completed receipt with no stop proof. Its fresh
detail read verifies both persisted cleanup obligations. Bound Session cleanup,
receipt reconciliation after a lost response, independent Task checks and the
real Controller wire test retain their original fixtures.

## Alternatives

**Keep the database and gateway setup in both strict matrices.** This repeats
infrastructure for parser and response assertions. The existing assembled
registration and deletion scenarios already provide the same infrastructure
for the physical assertions.

**Supply the failed report and completed receipt only at the HTTP boundary.**
That would leave the persisted startup and unbound cleanup transitions outside
the corresponding end-to-end Bot HTTP flows. A separate Bot in each retained
schema preserves those sequences and their fresh reads.

## Consequences

The strict matrices run without database or UniAuth fixtures. The assembled
tests still require PostgreSQL and UniAuth for their transaction and persistence
assertions. Each extra physical scenario prepares its own Bot identity while
sharing the existing schema, Worker and credential.
