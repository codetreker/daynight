# Agent Note: PostgreSQL Cancellation Test Timing

Status: implemented

## Problem

A cancellation test must reach the database operation it intends to exercise.
Starting a short deadline before acquiring a connection can expire during
transaction setup under load, so a failed assertion may say nothing about
operation cancellation or connection cleanup.

## Decision

The read-only snapshot cancellation tests wait until the PostgreSQL operation
is running before canceling its context. A bounded outer context still limits
the test. The tests retain their checks for the cancellation cause, connection
closure, transaction outcome, and pool reuse.

## Alternatives

**Increase the deadline before starting the transaction.** A longer deadline
reduces the chance of early expiry but still depends on connection setup and
scheduler timing, and does not establish that the operation was reached.

## Consequences

The tests exercise the intended cancellation and cleanup path independently of
connection setup latency. They require a separate database connection to observe
the running operation and remain subject to the bounded test deadline.
