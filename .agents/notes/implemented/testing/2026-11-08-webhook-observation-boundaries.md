# Agent Note: Webhook Observation Boundaries

Status: implemented

## Problem

Webhook page tests used a fixed sequence of microtasks and a zero-delay timer as
proof that requests, current projections and UI effects had completed. Request
preparation awaits native Web Crypto SHA-256 work, which can finish after those
tasks. A restrictive disable or delete could therefore still be preparing when
the test inspected its recorded write. An earlier request count or confirmation
notice also cannot identify completion of a later operation.

## Decision

The Webhook page fixture observes dispatch, response admission and presentation
separately. Pure mock counters use the existing state waiter; list, detail, error,
secret, dialog and focus predicates use React Testing Library's DOM waiter.
Controlled responses are released within async React `act`, which settles their
React updates and effects before stale-response and retention assertions.
Synchronous form guards retain immediate no-write and no-recovery-marker checks.
Returning to a restricted Team retains the immediate private-data absence checks;
the cached owner-role label does not prove that fresh endpoint detail has arrived.
Tests acquire the actual restricted detail controls and immediately verify they
are disabled. Clearing a retained list error has its own DOM readiness predicate.
The fixed microtask helper is absent.

The restrictive cleanup case holds each native digest behind a separate promise.
It observes preparation through the digest call and blocked controls before
releasing that promise; the original native SHA-256 computation still runs.
Disabling requires exactly one PATCH with the captured version and `enabled:false`,
a disabled switch reflecting the applied state, and an enabled Delete action.
Deleting requires exactly the second write, its updated version and a distinct
operation ID. The matching receipt, deleted-state presentation and dialog removal
establish completion before private-data absence is asserted. Full fixture data,
unknown-result recovery, authorization, secrets, selection and focus remain part
of the page tests. Deadlines and product timing retain their existing values.

The [management observation decision](2026-11-07-settings-management-test-observations.md)
owns the reused waiter distinction; the [Webhook management decision](../architecture/2026-11-08-webhook-web-management.md)
owns the production page. The [Web validation guide](../../../../packages/daynight-web/README.md#development)
owns commands and the strict coverage gate.

## Alternatives

**Repair only the restrictive cleanup assertion.** The same fixed-flush assumption
also covered creation, rotation, CAS review, secrets and background responses.
Keeping it there would preserve the same failure mechanism under other schedules.
The repair stays within this fixture's observation responsibility.

**Increase the microtask count or timer delay.** Native cryptographic completion
is independent of either count or elapsed timer interval. A larger delay adds
idle work without proving the intended operation reached dispatch or admission.

**Replace native hashing with an immediate fake digest.** That removes the real
asynchronous boundary and receipt fingerprint validation that the fixture uses.
Controlling release while retaining native hashing exposes the boundary directly.

**Wait for any recorded write or generic confirmation.** A prior CAS attempt or
disable operation can satisfy such a predicate before the next write starts.
Exact counts, current operation identity and the resulting UI distinguish them.

## Consequences

Preparation delays no longer determine whether tests inspect a missing write.
The fixture catches rejected restrictive cleanup and omitted same-version private
projection withdrawal while preserving real fingerprint validation. Controlled
response release also keeps negative assertions tied to the response they reject.
The tests model frontend API behavior; they do not establish server transaction
or delivery behavior, which belongs to the corresponding Go tests.
