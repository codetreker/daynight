# Agent Note: Webhook Observation Boundaries

Status: implemented

## Problem

Webhook page tests used a fixed sequence of microtasks and a zero-delay timer as
proof that requests, current projections and UI effects had completed. Request
preparation awaits native Web Crypto SHA-256 work, which can finish after those
tasks. A restrictive disable or delete could therefore still be preparing when
the test inspected its recorded write. An earlier request count or confirmation
notice also cannot identify completion of a later operation. Team directory
refresh, management denial and receipt denial each publish authorization or
operation state asynchronously; request dispatch does not prove those decisions
have reached their consumers. A freshly rendered endpoint heading also does not
prove that its passive effects have settled. Starting a secret read at that
point lets the endpoint effect advance the secret generation after dispatch,
so the valid reply is correctly discarded as obsolete.

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
The personal-page mount holds its initial endpoint detail response until the
request is observed, then releases it within async `act` before returning the
fixture. Each read receives its own response clone, preserving StrictMode's
request lifetimes. Empty personal lists and initial list failures retain their
own readiness conditions. Team selection waits for the named option in the
current selector; the shared Team-selection helper also holds and settles the
initial detail response. The heading identifies the endpoint; the settled
response establishes completion of the effects that invalidate older secrets
before subsequent interactions. Management and receipt-denial cases hold each
response until the request is admitted, then release it within async `act` before
checking private-data withdrawal, retained
drafts or the original operation result. Late-denial cases publish a newer Team
membership through an async `act` directory refresh, or finish selecting another
owner, before releasing the old response in a separate async `act`. The fixture
uses immediately resolved directory responses, so that refresh settles directory
admission and authorization publication. A dispatch count alone would leave the
old authorization key current. Rotation confirmation also requires dialog
removal and an enabled Check operation action before the next interaction. The
fixed microtask helper is absent.

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

**Wait only for the initial endpoint heading.** DOM insertion can precede the
passive effect that invalidates earlier secret reads. Holding detail admission
and releasing it within async `act` establishes that effect boundary before the
next interaction.

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
Personal-page tests and the malformed Team owner-list response cases reveal
their initial secret only after endpoint initialization settles. Responsive
layout, Back navigation and secret-retention assertions therefore exercise their
intended transitions after a valid initial secret read.
Authorization and receipt tests preserve their current-owner data, draft, secret,
original-operation and no-replay assertions after the relevant response settles.
The tests model frontend API behavior; they do not establish server transaction
or delivery behavior, which belongs to the corresponding Go tests.
