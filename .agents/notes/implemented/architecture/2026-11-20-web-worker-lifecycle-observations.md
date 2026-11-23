# Agent Note: Web Worker lifecycle observations and original operations

Status: implemented

## Problem

A server accepting a disable request does not prove that the machine stopped.
An old stopped observation can also remain visible while a resume request opens
admission. Losing a response or refreshing the page must preserve the original
request without issuing another lifecycle action.

## Decision

The Web client consumes the independent lifecycle resource and validates its
principal and exact protocol fields. Intent, instance and report fences reject
older results. Freshness follows server time plus monotonic elapsed time, anchored before the
request so transit time cannot extend the evidence lifetime. The
Worker card and detail share the same operation journal within the authenticated
scope; the detail owns the full progress presentation.

Before dispatch, the original request and its domain-separated hash are stored
with origin, account and Worker identity in sessionStorage. A failed storage
write prevents dispatch. Unknown results retain that journal, query the original
operation and resolve absence with the original request. A known semantic
conflict rejects that submission; an unrelated GET receipt cannot erase it.
The journal is cleared only after a matching confirmed outcome and, for an
accepted intent, publication of a resource at least as new as its receipt.
Account sign-out also clears matching cold journals whose Worker views were not
mounted in the current document. Cleanup failures use the account's existing
private-state notice and explicit retry, while other accounts' records remain
untouched.

Current safe-stop conclusions require fresh matching complete stop and save
evidence with no diagnostic error except `upload_failed`, which does not negate
local stopping or durable saving. Resume eligibility uses the same proof in the
panel and submission path and additionally permits `resume_interrupted`; that
exception never establishes safe-restart eligibility. All other observation
errors reject both conclusions even when aggregate counts appear complete.
A closed admission with a current complete disabled observation and an allowed
error code can recover an interrupted enabled intent independently of disabled
presentation. That
state is blocked, not still resuming or safe to restart. Creating a resume request
immediately withdraws conclusions from the
previous stopped observation. Detail truncation remains independent of complete
aggregate inventory evidence; synchronization and individual recovery eligibility
remain independent of stopped and saved execution.

The [lifecycle design](../../../../docs/design/worker-lifecycle.md) owns the
consumer mechanism. The [server authority decision](2026-11-20-worker-lifecycle-authority.md)
owns persistence and execution admission.

## Alternatives

**Infer stopping from Worker connectivity or Task counts.** Heartbeats and Task
snapshots omit managed descendants, probes and other stopping responsibilities.
They cannot establish a current safe-stop conclusion.

**Keep unknown requests only in component state.** Navigation and refresh lose
the operation identity, while separate card and detail components can submit
duplicates. A scope-owned journal with same-origin persistence retains the exact
request and prevents another submission while it is unresolved.

**Replay an unknown request.** An absent GET is compatible with a delayed commit.
Resolving the original request closes that race without repeating the action.

## Consequences

The UI distinguishes acceptance, native stopping, saving, synchronization and
recovery. Storage failures deliberately prevent new lifecycle submissions until
the request can be retained or reconciled. The client owns extra parsing,
fencing and recovery state; it does not certify local process stopping or the
Worker's full advertised capability. Browser and controlled API validation own
Web behavior, while native platform acceptance remains separate.
