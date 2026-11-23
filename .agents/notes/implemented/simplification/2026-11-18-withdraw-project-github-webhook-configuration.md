# Agent Note: Withdraw Project GitHub Webhook Configuration

Status: implemented

## Problem

The proposed switch from App deliveries to per-project repository hooks would
stop immediate PR refreshes for existing connections until administrators
configured each project. Periodic polling lists open PRs and follows up on
known active PRs. A new PR that closes between polls can remain undiscovered.

## Decision

GitHub App deliveries continue to signal PR refresh and repository access
rechecks. The project subscription API, receiver, Web settings, and schema
changes are withdrawn together. The original decisions remain in the
[subscription](../../archived/architecture/2026-11-18-project-github-webhook-subscription.md),
[receipt](../../archived/architecture/2026-11-18-project-github-webhook-receipts.md),
[access diagnostics](../../archived/architecture/2026-11-18-github-access-diagnostics.md),
and [project settings](../../archived/feature/2026-11-18-project-github-webhook-settings.md)
records.

The production source at commit
[`4c34ee49`](https://github.com/codetreker/daynight/commit/4c34ee49fc28f30e2b23770a0de6fa29402e56a3)
registered migrations through 083. Migrations 084 and 085 from the withdrawn
work are removed from the migration list and schema snapshot. The independent
[token usage](../architecture/2026-11-18-single-table-token-usage.md) migration
retains version 086. The migration runner applies 086 directly to a database
with the production ledger through 083.

## Alternatives

**Keep the database changes and add a forward cleanup migration.** This would
support in-place upgrades for databases that had already applied 084 or 085.
The deployed source was still at 083, so carrying the withdrawn migrations
would unnecessarily apply the diagnostics reset and create and remove unused
subscription columns during a production upgrade.

## Consequences

Existing App-based connections keep their event trigger and polling behavior.
An environment that applied 084 or 085 cannot use this server with its advanced
ledger. Restore a verified matching 083 backup for such an environment or
prepare a dedicated forward migration if its later writes must be preserved.
