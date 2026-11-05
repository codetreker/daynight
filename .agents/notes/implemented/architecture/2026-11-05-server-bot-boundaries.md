# Agent Note: Server Bot Boundaries

Status: implemented

## Problem

Bot definitions, defaults and lifecycle data share transaction and lock rules
with Worker observations and Session binding. Concrete storage callbacks and
root service ownership obscure those rules and make it difficult for the Session
integration to consume the same Bot operations without depending on its own
runtime implementation.

## Decision

`core/bot` owns definition, default resolution and Bot state rules;
`service/bot` selects the snapshot and write scope and handles completion.
`server/bot` adapts definition HTTP resources. The Bot write DAO binds creation,
binding, startup, preferences and deletion state operations to the caller's
transaction, preserving Bot-before-Session locking. Worker freshness and path
rules remain in `core/worker`.

The [definition](2026-11-04-bot-definition-storage.md),
[defaults](2026-11-04-bot-default-resolution.md) and
[Session admission](2026-11-04-bot-session-admission.md) decisions own the
behavior and its rationale.

## Alternatives

**Keep Bot rules in the root service and relay.** This would retain concrete
transaction dependencies and leave Session integration as the only owner of
Bot binding rules.

**Move the complete deletion workflow with the definition.** Session barriers,
live cache and archive cleanup span modules and must move together with the
Session engine. Retaining the existing integration avoids a second partial
implementation while exposing its Bot data operations in the shared transaction.

## Consequences

Identical creation retries return frozen definitions before Worker availability
is evaluated. Preferences and binding updates remain atomic with their caller's
transaction; completion and cleanup errors retain their existing priority. The
full bound deletion workflow remains with the existing Session integration until
that workflow moves as a unit. SQL stays in the existing store implementation
until its physical migration.
