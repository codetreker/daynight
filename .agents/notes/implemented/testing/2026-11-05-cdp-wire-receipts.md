# Agent Note: CDP wire receipts

Status: implemented

## Problem

The profile-cache browser journey must distinguish full current-account responses
from real HTTP 304 validations and measure their transferred bytes. Chromium's
normal response event exposes a validated cached response as 200, so that event
alone cannot establish the server's status. An observer that discards response
extra information before it recognizes the request can retain a null status
after the application has successfully loaded the response.

## Decision

The profile-cache journey collects request lifecycle and extra-information events
by request ID. Either channel can create a pending receipt before the request's
pathname is known. Classifying the request preserves already observed wire
status, outgoing validator and encoded transfer bytes; only requested pathnames
are published. Actual outgoing headers take precedence over provisional request
headers regardless of their arrival order.

[Playwright's Chromium network tracker](https://github.com/microsoft/playwright/blob/cfe490d941f992655948eee8fd4fd94e1c4234bf/packages/playwright-core/src/server/chromium/crNetworkManager.ts#L779-L817)
records that lifecycle and extra-information events use independent channels
whose relative order varies. The collector retains response extra information
until the corresponding request is recognized. It uses that event's original
status, preserving the distinction between a wire 304 and the browser's normalized
200. Missing status or transfer observations remain pending; a session-expiry
401 still needs only headers because the application aborts the active fetch.

The journey's profile/cache attachment is saved on both success and failure.
Attachment failure still runs the existing listener, CDP session, clock and
fixture cleanup. The
[profile reuse decision](../bug-fix/2026-11-04-task-view-request-reuse.md) continues
to own caching, authentication and freshness behavior.

## Alternatives

**Use the ordinary browser response status.** It would label validated cached
responses as 200 and lose the required proof that unchanged profiles transfer no
response body. The original wire status remains necessary.

**Redesign the journey's request indexing and product cache.** The observed
failure does not establish a defect in either mechanism. Request-ID accumulation
removes the proven event-order dependency while retaining the existing
200/304/401, validator and transfer-size assertions.

## Consequences

Early and late response extra information produce the same receipt. Focused
harness regressions exercise both channel orders, actual outgoing validators,
original wire statuses, encoded-byte observations including zero, unmatched
requests and header-only session expiry. Existing response and transfer budgets
remain in force.

The collector retains incomplete observations for the bounded lifetime of this
journey and exposes no status fallback. It records pathnames and transfer facts,
without retaining credential headers or response bodies. Captured receipts make
missing observations inspectable; a historical null status without protocol
ordering evidence does not establish which channel arrived first.
