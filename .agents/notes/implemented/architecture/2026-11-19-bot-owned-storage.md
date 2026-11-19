# Agent Note: Bot-Owned SQLite and Controller Locations

Status: implemented

## Problem

An assistant's launch intent and execution evidence must survive removal of
rebuildable Worker indexes and public Controller directories. Splitting those
records across shared locations makes directory discovery insufficient to find
the original session, and allows cleanup of public state to remove recovery
evidence. Moving files without coordinating their writers could create two
authoritative copies or erase the only deletion receipt.

## Decision

New Bots own a SQLite database, process lock and ownership gate under
`bots/<botId>/`. Database initialization commits its service/account/Bot identity
with the schema. Inventory and execution records share that database so recovery
updates remain atomic. The host discovers local databases independently of the
public index and retains each lock until its database users have closed.

Controller path derivation accepts an explicit storage root. Bot launches use
their directory for tickets, journals, media and temporary CLI aliases while
normal CLI authentication still uses its original configuration root. The
internal child-process location variable does not enter the Provider environment.
Ordinary Task and Test Controllers retain their default locations.

Windows SQLite opens use extended-length filenames so the additional Bot
directory does not exceed the native API's ordinary path limit. Stored path
identities and resource derivation retain the original normalized spelling;
ownership comparisons normalize the database handle's filename accordingly.

The [Worker runtime decision](2026-11-05-worker-bot-runtime.md) originally chose
Worker SQLite to reuse existing lifecycle ownership. That remains the authority
for unmigrated records; dedicated storage replaces it for new Bots. Duplicate
legacy and dedicated authority is rejected. Missing original data for a bound
Session cannot be replaced with a fresh local execution. Different Worker
bindings require verified takeover, which directory discovery alone cannot grant.

Deletion derives the same locations, removes captured payloads and retains the
minimal receipt in SQLite outside the removed execution directory. It preserves
the Bot's lock, other Bots, ordinary working directories and shared native homes.
The [runtime design](../../../../docs/design/worker-bot-runtime.md) owns the
location and lifecycle details.

## Alternatives

**Keep Bot records in Worker SQLite and copy them for recovery.** This leaves
two representations whose freshness and authority must be reconciled after a
crash. Direct ownership avoids introducing a second replication protocol.

**Change HOME or DN_CONFIG_DIR for a Bot Controller.** Those values also select
normal authentication, Provider configuration and tool discovery. An explicit
storage root isolates durable Controller data without silently changing those
independent identities.

**Delete the whole Bot directory with its journal.** The active SQLite handles,
lock and original deletion receipt must survive partial removal and a lost
server completion response. Captured payload deletion retains this minimal
responsibility instead of depending on already deleted evidence.

## Consequences

New Bot persistence no longer depends on shared Worker or Controller data.
Each opened Bot costs a dedicated database and lock; directory enumeration must
validate identities rather than trusting a directory name. Existing shared data
uses the [guarded migration](2026-11-19-bot-storage-migration.md). Provider native
records use their separately verified adapters, including the
[Codex recovery profile](2026-11-19-codex-bot-recovery-points.md). This storage change
does not advertise complete native recovery or independent Worker takeover.

Deleted Bots retain minimal local responsibility and database allocation.
Logical erasure of records is not a forensic disk-erasure guarantee.
