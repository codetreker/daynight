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

The login completion page consumes this owner independently, waits for an
authenticated identity and completed publication, then replaces its validated
local return target. The successful server callback directs every allowed target
through that page, encoding the complete original target and escaped callback
request path. The page validates the path and resolves accepted relative references from
that callback to preserve their original destination, including query and fragment.
A superseding account requires a real reload.

Initialization and publication have separate explicit retries. A failed write
can be retried after checking the current record; a persisted value with a
failed notification is only notified again, and a superseding value is not
replaced. Causes and stages remain visible alongside the confirmed identity.

## Alternatives

**Trust the marker or apply every event as identity.** Storage is a change hint,
not server authentication, and delayed event payloads can describe old state.

**Publish only when the private workspace starts.** Public pages and other local
return targets would never announce the newly authenticated account. A completion
page can confirm the account through the existing `/me` API before any target.

**Generate a callback page in Go or pass a user ID in the redirect.** A separate
HTML and script implementation would duplicate the Web UI and its error handling;
an arbitrary URL identity cannot confirm the account. The completion page uses
the existing `/me` API, at the cost of a document initialization request.

**Use only the original target in the completion URL.** An encoded leading slash
can be an accepted relative reference. Resolving it from the completion page would
change its destination when the callback has another directory. Rejecting those
targets would narrow the existing accepted set; carrying the validated callback
path retains the original landing location.

**Repeat `/me` or the login callback after any publication failure.** This
conflates server confirmation with local notification and can consume a one-time
callback again or overwrite a newer marker.

## Consequences

A stale initial marker can be corrected while a known concurrent change prevents
a late response from taking ownership. The storage read and write are not an
atomic compare-and-swap; the signal does not promise observation of every
intermediate change. The completion page can publish before returning to public
or other local targets. The owner is not yet wired into the business root, scopes,
logout, or request admission.
