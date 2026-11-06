# Agent Note: Resume Native Context from a Test Session

Status: implemented

## Problem

Stopping a foreground test Controller archives its page, although the native
provider retains useful conversation context. Recreating an empty conversation
makes repeated Session View debugging needlessly expensive and loses context.

## Decision

Resume selects a locally registered, stopped Test Session and creates a new
Daynight execution around the same native session. The launch ticket and journal
bind its provider, native home, directory, owner and server. Native history feeds
the new timeline; old input and uncertain operations are never replayed.

A private cross-execution lease serializes writers by native identity. Native
launch requires a successful acquisition; an acquired lease is released only
before launch or after proven process-tree stop. Unknown or stale ownership
requires investigation rather than automatic takeover.
The [SQLite migration decision](../architecture/2026-10-30-cli-sqlite-migrations.md)
versions the lease database independently at 1. Any retained row blocks a needed
format upgrade; acquisition and release check the current format in their own
write transaction without turning expiry or missing PIDs into reclamation proof.
If initial format setup commits this invocation's lease but completion reporting
fails before acquisition returns, no new native launch can yet have begun. With
known commit and confirmed original close, preparation checks the current format
on a fresh existing-file connection and removes only its own matching key/nonce.
A replacement nonce or unknown commit/close retains the lease. Cleanup does not
turn the failed acquisition into success: the reporting error is rethrown, and a
cleanup failure is aggregated with it.
The [requirements](../../../../docs/spec/controller-test-sessions.md) and
[protocol design](../../../../docs/design/task-session-protocol.md) own the
user-visible behavior and binding rules.

## Alternatives

**Reactivate the archived Web Session.** This would preserve its URL, but needs
an explicit server lifecycle transition and generation fencing. A fresh Web
execution preserves the existing archive contract while continuing native context.
A future same-URL feature must add that transition instead of weakening grants.

**Accept arbitrary native session IDs.** This enables native-history discovery,
but loses Daynight's recorded directory, ownership and stopped-process evidence.
It remains separate from resuming an already registered local Test Session.

**Check only the old stopped flag.** Two launchers can both pass that check.
The lease and repeated process verification are necessary even for a local CLI.

## Consequences

The CLI gains a provider-level resume selector and an explicit ID form. New
executions have new URLs and journals, so old receipts remain immutable. Native
history, settings and approvals recover only to the extent the provider persists
and reports them. Existing task worker recovery retains its own lifecycle.
