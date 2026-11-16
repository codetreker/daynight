# Agent Note: Independent GitHub App Registration

Status: implemented

## Problem

A single deployment needs distinct GitHub Apps shared by authorized Teams without deriving App administration from Team or Project roles. Registering the same external App twice could split credentials and grant an unintended administrator access. Credentials must be proved without exposing them or holding database locks across GitHub requests.

## Decision

The independent App foundation proves the submitted RSA key with GitHub's authenticated App endpoint, then creates the App and its first administrator in one transaction. A partial unique index admits one live resource per external App ID, and the local UUID remains occupied as a tombstone. Public reads filter by current administrators and exclude secrets. The [registration design](../../../../docs/design/github-app-registration.md) describes the storage, budgets and unmounted adapter.

## Alternatives

**Register separately for each Team.** This would split a single GitHub App's Webhook and credential configuration and permit conflicting administrators for the same external identity.

**Hold a transaction during remote proof.** Network delays would retain database resources and locks while GitHub is unavailable; proof before the short transaction avoids that cost while the unique index resolves concurrent registrations.

## Consequences

The schema is ready for later administrator and Team authorization operations while the existing connection runtime remains unchanged. The adapter is not mounted. A confirmed remote identity does not prove Webhook delivery, and an unknown commit cannot be inferred from equal public metadata or automatically replayed.
