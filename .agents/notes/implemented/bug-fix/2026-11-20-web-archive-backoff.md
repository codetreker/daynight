# Agent Note: Bound Web archive capacity retries

Status: implemented

## Problem

Archive capacity is shared with uploads and other readers. A transient capacity
refusal could make an otherwise readable Session appear to have failed, while
unbounded retries would keep obsolete page and account requests alive.

## Decision

The Web reader retries only the archive content and timeline GETs after an exact
`429 resource_busy`. Each request has its own exponential backoff; the loading
operation shares a retry count and absolute deadline across its files, including
in-flight requests and body reads. The original authentication and page lifetime govern both waits and requests. A preflight busy
response may lack a principal, but a present principal is always verified and the
error body never becomes Session data. The [Session protocol design](../../../../docs/design/task-session-protocol.md)
records the limits and response handling.

## Alternatives

**Restart the entire archive load.** This would repeatedly download and validate
an already accepted manifest when only its timeline is busy, increasing contention.

**Retry every failed request.** Network, authorization and protocol errors do not
establish a capacity refusal and must retain their existing handling.

## Consequences

Transient contention can clear without a manual refresh, while sustained refusal
still reaches the existing failure state. Retries do not guarantee availability or
fairness. The principal exception is limited to the exact busy error on these GETs;
success and all other responses retain their existing validation.
