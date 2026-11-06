# Agent Note: MCP OAuth Grant Lifecycle

Status: implemented

## Problem

An issued public-client authorization needs bounded renewal and revocation without
allowing a stolen or replayed refresh credential to preserve access. Maintenance
must reclaim expired state without depending on a particular server instance.
Lost token responses cannot reveal whether a rotation committed.

## Decision

Refresh consumes the old hash and inserts the next refresh and access hashes in
one transaction, with the original grant expiry as the absolute limit. Existing
grant locks precede refresh locks and access changes. Matching replay commits
family revocation before returning refusal; mismatched client or resource leaves
the family unchanged. Public revocation accepts either credential kind without
disclosing whether it matched. Owner operations list only the requested account's
grants and revoke one family; the caller authenticates the account.

The complete token adapter takes the persistent global and source budget before
secret lookup and the verified-client budget after checking the stored bindings,
before mutation. It routes authorization code and refresh exchanges and returns
secrets only after a confirmed commit. The [authorization code decision](2026-11-06-mcp-oauth-authorization-code.md)
and [credential family decision](2026-11-06-mcp-oauth-credentials.md) describe
the corresponding transaction and business admission guarantees.

A startup scan and minute runner combine bounded client, authorization and
credential cleanup. Each kind has a share of the 2000-row round budget, so a
large backlog in one kind cannot starve the others; each transaction handles at
most 100 candidates. Persisted cursors share authorization expiry and terminal
deletion, and credential cleanup classes, across instances and restarts. Stop
cancels and joins before stores are released. Browser integration mounts the
public adapters and starts this runner.

## Alternatives

**Replay a stored successful response.** Recoverable bearer secrets would need
retention after delivery and would make a replay indistinguishable from recovery.
A client with an unknown response must instead obtain a new authorization.

**Return replay refusal before commit.** Rolling back the transaction would leave
the winning family's access usable after the replay was detected.

## Consequences

Concurrent refreshes can invalidate the winner's family when the second request
replays the consumed credential. Access operations serialize with revocation via
existing credential locks. Cleanup may take multiple rounds under load, and
failures leave remaining records for a later round. Public profile discovery and
browser integration remain separate from these unmounted adapters.
