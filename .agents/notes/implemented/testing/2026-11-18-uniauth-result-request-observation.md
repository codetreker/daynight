# Agent Note: UniAuth Result Request Observation

Status: implemented

## Problem

The browser-binding authentication test must distinguish callbacks that retrieve
the one-time UniAuth result from unbound, repeated and denied callbacks that must
not retrieve it. Its subprocess log buffer is safe for concurrent access, but
Go copies the gateway's stdout and stderr asynchronously. A callback can finish
before its request log reaches that buffer, causing an incorrect count assertion.

## Decision

A test-only RoundTripper counts SDK requests atomically before delegating to the
original HTTP transport. Only `POST /auth/result` on the real fixture's exact
origin contributes to the count. The observer retains no headers, credentials or
request bodies. Callback completion follows the synchronous SDK operation, so
the count is available when the test asserts zero or one retrieval.

The actual browser flow, SDK decoding and gateway consumption remain exercised.
A subsequent direct SDK retrieval must still return HTTP 410 with
`result_unavailable`, proving the result was consumed. The denial cases take a
fresh count after that explicit retrieval. Captured logs retain their separate
credential-redaction assertions.

## Alternatives

**Wait for the subprocess log count.** Polling can accommodate delayed positive
observations, but a negative assertion would require a timing window and would
still depend on unrelated pipe-copy scheduling.

**Replace the gateway response.** A synthetic SDK result would remove the real
one-time consumption and decoding behavior that this test owns.

## Consequences

Request-count assertions no longer depend on subprocess log delivery. The counter
observes SDK attempts; the successful callback and subsequent real HTTP 410
independently establish consumption. The original transport remains responsible
for network behavior and idle-connection cleanup.
