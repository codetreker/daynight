# Agent Note: Server-Confirmed Account Initialization

Status: implemented

## Problem

A delayed identity response can overwrite a newer account marker published by
another tab. Storage and notification failures also have different recovery
steps, while a marker alone cannot establish an authenticated identity.

## Decision

The independent account session owner subscribes to the
[account signal](2026-11-11-account-change-signal.md) before requesting `/me`.
It accepts only a current, uncancelled server result, comparing observations
made during the request with the latest known record before installing identity
and publishing. An unchanged initial marker may be stale; a newly observed
conflicting marker requires a reload. Once confirmed, a different known marker
sets a sticky refresh requirement without replacing the current identity.

Initialization and publication have separate explicit retries. A failed write
can be retried after checking the current record; a persisted value with a
failed notification is only notified again, and a superseding value is not
replaced. Causes and stages remain visible alongside the confirmed identity.

## Alternatives

**Trust the marker or apply every event as identity.** Storage is a change hint,
not server authentication, and delayed event payloads can describe old state.

**Repeat `/me` or the login callback after any publication failure.** This
conflates server confirmation with local notification and can consume a one-time
callback again or overwrite a newer marker.

## Consequences

A stale initial marker can be corrected while a known concurrent change prevents
a late response from taking ownership. The storage read and write are not an
atomic compare-and-swap; the signal does not promise observation of every
intermediate change. The owner is available to consumers but is not yet wired
into the business root, scopes, logout, or request admission.
