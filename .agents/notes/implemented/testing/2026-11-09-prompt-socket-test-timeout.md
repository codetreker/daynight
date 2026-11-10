# Agent Note: Prompt Socket Test Timeout

Status: implemented

## Problem

The Prompt stalled-body regression waits for the full 15-second production read
timeout. It proves HTTP timeout classification, connection termination and no
business call after an incomplete request. The interval length adds repeated
cost without changing those observations.

## Decision

The Prompt handler constructor sets its body-read duration to
`transport.JSONBodyReadTimeout`. Its JSON decoder passes the instance duration to
the shared `ReadBody` implementation through `DecodeObjectLimitWithTimeout`.
Existing shared decoder entries retain the production default.

The socket fixture checks the constructed default is still 15 seconds before
selecting 200 milliseconds for the stalled-body case. Cancellation and oversized
body cases keep the production duration. All three execute the real routes,
parser, body reader and TCP connection with a directly controlled Prompt service.
The timeout case retains read-start and handler-completion barriers, `408
request_timeout`, request ID, connection closure, EOF and zero business calls.

The [HTTP input decision](../architecture/2026-11-07-http-input-boundaries.md)
owns terminal body responses. The
[instance timing decision](2026-11-07-integration-test-timing.md) records the same
separation between production defaults and incidental test waits for other
mechanisms.

## Alternatives

**Keep the production-sized interval.** It repeats the same transport proof with
a longer fixed wait.

**Shorten only the socket or request-context deadline.** A socket deadline that
precedes the body's stored deadline can change cancellation classification. The
selected duration must reach the production body reader, which applies both.

## Consequences

The stalled-body test retains actual elapsed time and native socket failure while
reducing its incidental wait. Instance configuration avoids a mutable global
timer and adds no public runtime setting. A five-second client deadline bounds a
broken server path; it does not supply the server's timeout response.
