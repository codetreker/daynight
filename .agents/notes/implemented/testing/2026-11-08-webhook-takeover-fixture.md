# Agent Note: Deterministic Webhook Takeover Fixture

Status: implemented

## Problem

The two-instance takeover stress fixture backdates its task sources by 58 seconds. The production retry policy places the second opportunity between 54 and 66 seconds, so initial admission can already consume that opportunity. Correct recovery then waits for the third opportunity beyond the test's 12-second receive deadline. A failed assertion therefore cannot distinguish broken takeover from an unsuitable random fixture.

## Decision

The [takeover fixture](../../../../packages/daynight-server/internal/server/webhook_takeover_stress_test.go) gives its existing capturer a private deterministic random stream with seed 313. The production capture code still creates and persists all ten jittered opportunities; both second opportunities fall near 63 seconds after their source. The concurrent-claim barrier checks that each remains future and within the existing receive deadline. After the initial TLS requests, persisted cursor and attempt counts must both equal one before lease expiry and recovery.

The seed follows the capturer's current entropy consumption: event and delivery IDs precede the complete schedule for each source. The original seed 25 suited the encrypted-destination path, whose rewrap consumed additional random bytes. Removing rewrap changed the next schedule's draws, so retaining that seed could start with an elapsed second opportunity. Seed 313 keeps both second opportunities near 63 seconds with the current capture path.

The actual PostgreSQL claims, independent runners, lease recovery, new generation and token, and late-result fencing assertions remain in the runtime stress test. The [service test ownership decision](2026-11-08-webhook-service-dao-mocks.md) separates rule matrices from persistence. This composed runner witness belongs to the server runtime owner and uses the existing `stress` and `webhooktest` build tags; it does not restore PostgreSQL to ordinary service tests. Runtime randomness and the retry policy are unchanged.

## Alternatives

**Extend the receive deadline.** Waiting for the third opportunity would conceal the wrong initial cursor and make the test slower without proving the intended second-attempt takeover.

**Rewrite persisted schedules.** Moving captured timestamps would create a fixture that bypasses the production schedule generator and its immutable capture data.

**Use uncontrolled randomness with a younger source.** The test would retain a distribution-dependent deadline and could silently exercise another cursor if setup crossed an opportunity. The explicit barrier and persisted cursor assertion establish the required starting state.

## Consequences

Both takeover subcases exercise the intended first-to-second opportunity transition with bounded real network and database work. The seed is local to this fixture. Changes to random-byte consumption or setup exceeding the available opportunity margin fail the starting-state checks rather than being mistaken for recovery defects. Stress remains separate from routine CI; the fixture does not prove production fleet acceptance.
