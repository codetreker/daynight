# Agent Note: Document Account Synchronization

Status: implemented

## Problem

Same-origin documents share a browser session but may retain different account
views. A delayed request can return under a newer account, while repeated
foreground verification interrupts healthy work and cannot preserve a draft
when another tab changes the account. A local marker is not authentication,
and browser storage, broadcasts and server session changes are not atomic.

## Decision

A single document account owner confirms identity through `/me`, including on
public pages, and adopts the [account signal](2026-11-11-account-change-signal.md)
as a hint. It rereads current storage on notifications and foreground return,
without trusting event payloads or repeating `/me`. A known different marker,
trusted different principal or changed user fence synchronously pauses admission
and cancels remote work. The original account, scope, rendered content, drafts,
focus and decoded images remain until a real reload. Active headers, including
native modal and fullscreen headers, expose the reload action. The prior
[foreground verification decision](../../archived/bug-fix/2026-10-23-silent-foreground-identity-checks.md)
recorded the earlier network gate and recovery overlay.

Successful login callbacks pass through the completion page, which confirms the
account and completes local publication before returning to the validated target.
Logout and current-session 401 check their source and current marker before
cleanup and publication. Storage and channel errors retain their causes and
failed stage; a persisted marker with failed notification is retried only as a
notification after checking the marker again. The [authentication design](../../../../docs/design/daynight-auth.md)
owns the current lifecycle and user-visible behavior.

## Alternatives

**Recheck `/me` at every foreground return.** The previous gate protects request
admission, but causes a network request and suspension on healthy tab switches,
and its recovery overlay interrupts work after a failure.

**Automatically install the new account or clear the old view.** This discards
local edits and focus while a change may arrive during an in-flight operation.
Retaining the original view with remote admission stopped makes the transition
explicit without granting it the new account's authority.

**Publish only from private workspace startup.** Public and non-Web return
targets could miss the change. The completion page uses the existing `/me` and
local signal for every allowed target, at the cost of a confirmation request in
both the completion and subsequent Web documents.

**Add a server-wide expected-user write protocol or durable ordering.** This
would change the shared protocol and add persistent coordination; the selected
hint and existing response fences do not claim atomicity across browser storage,
Cookie changes and remote requests.

## Consequences

Healthy navigation and foreground return preserve state without another identity
request. A frozen document checks the current marker on return; it may miss a
complete A-to-B-to-A change. Notifications prove local publication rather than
receipt by every peer, and storage or channel failure can limit synchronization.
Writes dispatched before a change is observed retain their existing non-atomic
boundary; cancellation does not prove rollback or authorize replay. A true
session expiry or resource revocation still follows its own cleanup contract.
