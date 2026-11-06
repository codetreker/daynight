# Agent Note: MCP OAuth Authorization Codes

Status: implemented

## Problem

A public client needs a browser user's explicit decision bound to the exact
client, callback, resource and PKCE challenge. A code must issue one complete
credential family even when exchanges race, and replay must invalidate that
family without deadlocking other credential operations. A lost response cannot
establish whether a decision or exchange committed.

## Decision

Authorization requests freeze the validated client and protocol bindings and
retain only a hash of the browser binding. Decisions require the current browser
session, the matching binding and the expected user. The decision transaction
locks and rechecks the session after any authorization-row wait. Approval stores
a code hash; denial creates no code. State is used only for the validated callback
and is cleared after the decision. A committed decision cannot reproduce its
code. Inspection retains the approved decision and separately reports code expiry.

Exchange validates the client, exact callback, resource and S256 verifier before
consumption. Consumption and the initial grant, access and refresh issuance share
one transaction; DCR issuance pins the client row until commit. A correctly bound
replay revokes the family in a committed transaction before returning refusal.
Existing grant locks precede code locks and access changes; an initial exchange
that discovers a concurrent winner retries its inspection in that order. Consumed
code hashes and bindings remain until the grant expires so replay can be detected.

Pending request allocation and pruning share a capacity lock. The public start
budget precedes client metadata resolution and storage allocation. The browser
and token adapters are usable in a controlled host; production discovery and
consent integration remain separate responsibilities.

## Alternatives

**Persist recoverable codes or token responses.** Replaying plaintext after a
lost response would retain bearer secrets beyond their original delivery and
weaken the one-time exchange guarantee. Current state can be inspected, but a
new authorization is required to recover from an unknown delivery.

**Return replay refusal inside a rolled-back transaction.** Returning the error
before committing would undo the family revocation and leave the winner's access
credential usable after a detected replay.

## Consequences

Wrong bindings do not consume a valid code, while a correctly bound duplicate
invalidates the original family. Concurrent clients must treat an unknown token
response as unknown rather than automatically retrying it. Cleanup retains
consumed-code evidence for the grant lifetime and reclaims other terminal
authorization state after its retention period. The [client decision](2026-11-06-mcp-oauth-clients.md)
and [credential family decision](2026-11-06-mcp-oauth-credentials.md) own the
corresponding client and credential lifecycle rules.
