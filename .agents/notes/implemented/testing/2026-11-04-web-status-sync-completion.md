# Agent Note: Completed Reads in Status Acceptance

Status: implemented

## Problem

A status journey can refresh a project while its initial task-summary read is
still active. Manual refresh legitimately cancels that earlier read and issues
a replacement. Capturing the first HTTP 200 response headers does not establish
that its request will finish: an aborted response can be superseded after its
headers arrive, even while the replacement renders current task data.

Playwright 1.64.1's client response completion promise is resolved by
[requestfinished](https://github.com/microsoft/playwright/blob/cfe490d941f992655948eee8fd4fd94e1c4234bf/packages/playwright-core/src/client/browserContext.ts#L229-L239).
Its [requestfailed handler](https://github.com/microsoft/playwright/blob/cfe490d941f992655948eee8fd4fd94e1c4234bf/packages/playwright-core/src/client/browserContext.ts#L221-L227)
does not resolve that promise. A native Chromium diagnostic reproduced an
HTTP 200 response followed by `net::ERR_ABORTED`, a successful replacement and
rendered task state, while the original response's `finished()` remained pending
until the browser closed. This establishes the completion hazard; the original
CI timeout had tracing disabled and does not identify its exact browser request.

## Decision

The status journey's open helper arms a `requestfinished` waiter before
navigation or manual refresh. Its predicate requires a GET to the exact
project's task-sync pathname and a successful HTTP 200 response. Aborted reads
do not satisfy this completed-request event; a successful replacement can.

After completion, the helper retains its authoritative project snapshot read,
view selection and detail-availability assertions. All four status journey
callbacks, status/version/material checks, configured timeouts, worker settings
and retry policy remain unchanged. Production request cancellation and API/UI
behavior are unchanged.

The [Web acceptance guide](../../../../packages/daynight-web/README.md#production-browser-acceptance)
owns the journeys and their evidence boundaries. The
[cross-layer acceptance decision](2026-10-22-task-lifecycle-cross-layer-acceptance.md)
retains the same-task CLI/browser behavior and fault assertions.

## Alternatives

**Wait for the captured response's `finished()`.** A header match can latch an
aborted initial response, whose client completion promise does not settle when
the replacement succeeds. The native diagnostic reproduced this behavior.

**Increase the test timeout or retry an unchanged failure.** Waiting longer
does not turn request failure into request completion. It retains the same
incorrect synchronization condition and obscures useful failure evidence.

**Remove synchronization and rely only on visible cached content.** The status
journeys also exercise reload and remote CLI mutations. A completed service
read and the existing rendered-state assertions preserve both observations
without treating a cached preview as fresh server data.

## Consequences

Status acceptance waits for a successful completed read rather than response
headers. The ordinary Playwright event wait remains bounded by its existing
configuration. HTTP errors and absent successful completions remain failures;
there is no response fallback, generation protocol or changed test budget.

A minimal browser diagnostic validates that the completed-event waiter ignores
an aborted 200 response, selects the successful replacement and observes rendered
state. Genuine selected-target production acceptance remains necessary for
the complete status journeys; this diagnostic does not establish their full
business behavior or classify the historical timeout as infrastructure.
