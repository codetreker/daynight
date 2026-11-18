# Agent Note: Image Receipt Contention Budget

Status: implemented

## Problem

The image-release receipt case holds a real SQLite write lock so the staging
file is removed before the durable receipt can be written. Its
[hosted macOS sample](https://github.com/codetreker/daynight/actions/runs/44243743660/job/134600298999)
took 9.139 seconds. The failure and recovery order matters; waiting out the
default SQLite busy timeout is incidental to that order.

## Decision

The [receipt test](../../../../packages/daynight/test/commands/controller/image-prepare-reclaim.test.ts)
provides a private real journal connection through the lifecycle store's
existing database option. After initialization it checks `busy_timeout=5000`
and sets only that connection to 100 ms. The competing connection still holds
`BEGIN IMMEDIATE` in WAL mode. The test verifies a real `SQLITE_BUSY` cause,
the absent staging file, and the unchanged original receiving identity before
unlocking and retrying through the real store. The lifecycle store closes its
writer; the fixture closes the competing writer separately.

## Alternatives

**Throw a synthetic storage error or install an aborting trigger.** Neither
exercises the native lock or the retryable busy classification.

**Change the production timeout.** The default protects actual workloads;
its wall duration is not what the image release retry case needs to prove.

## Consequences

Only the fixture's SQLite contention delay is shortened. The staging deletion,
receipt transaction, failure classification, and idempotent retry remain real.
