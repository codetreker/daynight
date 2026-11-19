# Agent Note: Stopped Markdown Transaction Fixtures

Status: implemented

## Problem

The stopped Markdown repair tests for interruption, transaction rollback,
authorization, retained resource corruption, and changed plans use the same
single-image source. Starting the Markdown parser worker for each of those
cases adds repeated startup cost to checks of repair state and durability.

## Decision

The transaction fixture supplies the complete image node for its fixed
source through the existing projector's parser option. It checks the source
on every parse and specifies the node range independently. The changed-plan
cases also assert that repair analyzes the original bytes again when checking
the persisted plan.

The file retains real parser runs for text-only repair, image recovery,
repeated destinations, and ambiguous retained lineages. The transaction
cases use the production projector and repair path, real SQLite state and
outbox writes, and real resource bytes and assertions.

## Alternatives

**Start a parser worker for every repair.** This repeats startup and
single-image parsing while the transaction cases vary persistence and
authorization conditions. The representative repair cases already exercise
worker analysis and downstream repair together.

## Consequences

Changing the fixed transaction source requires updating its explicit node
range and fields. Parser behavior remains covered by the real-worker cases.
The downstream tests still observe cancellation, durability, and integrity
through actual repair state and stored evidence.
