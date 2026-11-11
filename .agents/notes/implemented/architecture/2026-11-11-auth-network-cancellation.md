# Agent Note: Independent authentication network cancellation

Status: implemented

## Problem

The identity gate prevents new ordinary API requests while verification is
pending, but cannot stop requests or response bodies already in flight. A caller
needs to retire those network operations without changing the identity generation
or releasing the gate, and must not publish a late result as a success.

## Decision

The shared API client owns a rotating in-memory network lifetime for ordinary
requests. It captures the current lifetime after the identity gate and combines
it with the caller's signal for fetch and response decoding. Explicit cancellation
installs the next controller before aborting the old one, so synchronous abort
callbacks can dispatch against the new lifetime. Cancellation preserves the
signal's reason through response handling. `/me` and logout keep their independent
caller-owned lifetimes. The [authentication design](../../../../docs/design/daynight-auth.md)
describes the request and foreground behavior.

## Alternatives

**Cancel only fetch.** A response can already have arrived while its body is
still being read, so this alone does not guard decoding or result publication.

**Tie cancellation to the existing foreground pause.** Ordinary visibility
checks are temporary and retain in-flight operations; coupling the mechanisms
would change that behavior and conflate waiting with network cancellation.

## Consequences

The owner can stop old network work independently while new admitted requests
remain usable. A cancellation does not prove that a dispatched server write was
rolled back. Publication and persistent-cache admission still require their own
identity and lifecycle checks. The existing [foreground verification decision](../../archived/bug-fix/2026-10-23-silent-foreground-identity-checks.md)
records the original temporary gate and presentation rationale.
