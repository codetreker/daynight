# Agent Note: Worker Monitoring Response Completion

Status: implemented

## Problem

A browser response event confirms headers, not that the body has arrived. A
monitoring request can be cancelled after an HTTP 200 response, leaving no body
for the Product E2E journey to read. A later request may supply the observation
rendered by the page. The historical traces show cancellation, but do not
establish its cause or whether a later request would have completed.

## Decision

The journey observes matching browser requests from before navigation and reads
bodies only after request completion. It correlates a successful response with
both timestamps rendered by the page, then verifies its observation and capacity.
A bounded request inventory reports status, termination and body availability
when the journey fails. The wait covers the page's ordinary 30-second polling
interval and does not treat an aborted or empty response as a valid observation.
The Worker process deadline covers the journey's readiness, observation and
later reporting waits; the enclosing Playwright deadline still bounds the test.

## Alternatives

**Read the first response after its headers.** A cancelled request can report
HTTP 200 without an available body, and the first response need not be the one
used by the page.

**Use only a separate API request.** That would not establish that the production
Web rendered the observation it received through its own browser request.

## Consequences

A later completed response can satisfy the journey only when its timestamps match
the rendered observation. Failed requests remain visible if the journey fails;
they are not themselves proof of the historical cancellation's cause. The bounded
inventory reports truncation, and the longer wait can increase a failing run's
duration.
