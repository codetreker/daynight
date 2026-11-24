# Agent Note: Control wait between Worker lifecycle observations

Status: implemented

## Problem

The lifecycle integration file spends most of its run waiting for one-second
polls before it can observe real SQLite and lifecycle changes. Several
scenarios need multiple independent observations while authority requests
remain unresolved and cannot safely skip those observations.

## Decision

The lifecycle manager delegates its local observation, serialized cloud poll
and admission wait to a purpose-aware wait function. The production default
uses the same abortable 1,000 ms and 100 ms timers. Steady-state test fixtures
use short asynchronous delays. Tests that assert intermediate receipts or
ordering explicitly step the relevant local and cloud loops. Real SQLite,
API outcomes, original operation identities and close joins stay in place.
A default-cadence test observes the original timer requests and cancellation.

## Alternatives

**Wait for every production interval.** This gives each fixture a scheduler
delay even when the protected behavior is the order of the observations.

**Use one fake clock for the file.** Advancing both observers together and
changing other timers can obscure whether local observation can proceed
during an unresolved cloud request.

## Consequences

The test views remain tied to actual lifecycle reads, receipts and stores.
Runtime default timing and the independence of the two loops remain explicit
test contracts. Whole-job savings depend on how the runner schedules files.
