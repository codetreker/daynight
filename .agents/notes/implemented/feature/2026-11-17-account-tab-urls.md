# Agent Note: Account Tab URLs

Status: implemented

## Problem

Account tab selections could be traversed in browser history, but the same URL
identified every tab. Copying, reopening or refreshing it could not identify the
desired credentials or prompt view, including after authentication.

## Decision

The account URL owns tab selection: profile uses `/account`, credentials use
`/account?tab=tokens` and the user prompt uses `/account?tab=prompt`. An explicit
`tab=profile` remains valid without redirection. Invalid or repeated tab values
show an error with links to recover; unrelated query parameters do not select a
tab. Links retain native browser behavior and ordinary navigation uses the
existing admission owner. Selecting the current tab does not add an entry.

Account components remain bound to user identity rather than navigation entries;
tab changes preserve the prompt editor, credential operations and one-time
results. The URL and history contain no drafts or credential secrets. Leaving
the account continues through draft protection. The [Web requirements](../../../../docs/spec/daynight-web.md#账户设置导航)
and [design](../../../../docs/design/daynight-web.md) own the full behavior and
mechanism.

This replaces only the account selection in the earlier [reading history decision](2026-11-11-account-reading-history.md).
Worker and project selections retain their history-based ownership and validation.

## Alternatives

**Keep account selection in history state.** The earlier decision avoided changing
sharing and cold-entry semantics when only local traversal was required. It cannot
make a copied or refreshed address identify a specific tab.

## Consequences

Links and authentication returns can identify a tab without serializing business
state. Invalid query values require an explicit recovery state, and account
navigation must keep its identity-bound owners mounted across URL changes. A
reload still ends the in-memory owner lifetime; it does not persist one-time
secrets or drafts.
