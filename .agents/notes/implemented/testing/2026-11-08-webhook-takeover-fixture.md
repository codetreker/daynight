# Agent Note: Deterministic Webhook Takeover Fixture

Status: implemented

## Problem

The two-instance takeover stress fixture backdates its task sources by 58 seconds. The production retry policy places the second opportunity between 54 and 66 seconds, so initial admission can already consume that opportunity. Correct recovery then waits for the third opportunity beyond the test's 12-second receive deadline. A failed assertion therefore cannot distinguish broken takeover from an unsuitable random fixture.

## Decision

The [takeover fixture](../../../../packages/daynight-server/internal/service/webhook/delivery_two_instance_takeover_stress_test.go) gives its existing capturer a private deterministic random stream. The production capture code still creates and persists all ten jittered opportunities; both second opportunities fall near 63 seconds after their source. The concurrent-claim barrier checks that each remains future and within the existing receive deadline. After the initial TLS requests, persisted cursor and attempt counts must both equal one before lease expiry and recovery.

The actual PostgreSQL claims, independent runners, lease recovery, new generation and token, and late-result fencing assertions remain in the test. Runtime randomness and the retry policy are unchanged.

## Alternatives

**Extend the receive deadline.** Waiting for the third opportunity would conceal the wrong initial cursor and make the test slower without proving the intended second-attempt takeover.

**Rewrite persisted schedules.** Moving captured timestamps would create a fixture that bypasses the production schedule generator and its immutable capture data.

**Use uncontrolled randomness with a younger source.** The test would retain a distribution-dependent deadline and could silently exercise another cursor if setup crossed an opportunity. The explicit barrier and persisted cursor assertion establish the required starting state.

## Consequences

Both takeover subcases exercise the intended first-to-second opportunity transition with bounded real network and database work. The seed is local to this fixture. Changes to random-byte consumption or setup exceeding the available opportunity margin fail the starting-state checks rather than being mistaken for recovery defects. Stress remains separate from routine CI; the fixture does not prove production fleet acceptance.
