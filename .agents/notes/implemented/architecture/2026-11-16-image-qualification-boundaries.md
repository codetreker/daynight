# Agent Note: Image qualification separates originals from native processing

Status: implemented

## Problem

An immutable uploaded image, a native input receipt and a model's visual answer
prove different facts. A backend can resize an image or compact its history
without changing the original that Daynight stores. Requiring a geometry envelope
across every invisible backend context branch makes application admission depend
on a guarantee the application cannot establish. Conversely, accepting a
model name or a successful SDK call as qualification can silently omit an input.

Qualification also needs an execution mechanism. A version-only profile cannot
distinguish backend, model, platform or evidence changes; an unconditional service
refusal cannot consume a qualified Provider report. Replacing service capability
state with Controller state can reset the independently allocated service revision.

## Decision

The [input specification](../../../../docs/spec/session-image-input.md) separates
three obligations. Daynight preserves uploaded originals through storage, reads
and archives, and passes the complete ordered originals to the native image
interface. Native processing after that boundary may resize, convert or compact
its context. Native acceptance and visual consumption have separate evidence;
an observed omission of a current input remains a delivery failure, not successful
text-only submission. Existing accepted facts and originals survive that failure,
and unknown results never cause automatic resubmission.

The [Provider design](../../../../docs/design/session-image-providers.md) qualifies
an exact executable/native, SDK, backend, model, platform and operation identity
with explicit evidence and original-input limits. A catalog can narrow those
limits but cannot grant qualification. Missing or ambiguous identity, unavailable
evidence and changed qualification fail closed. Qualification identity participates
in Provider capability revision even when the published numeric limits are equal.
The production qualification registry is empty; this mechanism grants no existing
experimental combination production support.

The service intersects a real Provider report with its decoder, storage and
history components and the application limits. It owns its effective revision,
uses controls from the same state observation, and does not accept a Controller's
claimed service revision. A new image operation separately requires the current
complete, sealable history under the authorization transaction. History freshness
is an operation admission condition rather than a capability revision change for
every source event. Existing operation replay retains its original result.

One qualified combination may be enabled only after its relevant product paths,
permissions, original retention and recovery behavior have been verified. That
does not complete the other required combinations, platforms or whole-feature
acceptance. The [acceptance specification](../../../../docs/spec/session-image-acceptance.md)
keeps fixed visual test methods and historical failures separate from transport
correctness; neither selecting successful answers nor treating a historical
recognition error as permanent disqualification is a valid acceptance method.

This partially supersedes the qualification boundary in the
[original Provider decision](2026-11-05-session-image-providers.md). Its conservative
envelope requirement addressed real native resizing and omission risks when
catalog metadata supplied no adequate geometry contract. Those risks still
require explicit evidence and refusal behavior. Qualification now uses evidenced
original-input limits without proving every unobservable context branch. The
original decision already preserved native-transformed images as separate sources;
the clarified boundary does not change that obligation.

## Alternatives

**Require unchanged bytes through every backend history branch.** This would
couple application-original integrity to native transformations outside its
control and prevent a bounded, evidenced combination from becoming available.
Original retention and native-interface delivery remain strict instead.

**Treat successful finite samples or model names as universal qualification.**
Samples can refute a claim but do not establish untested limits or an unknown
backend identity. Evidence must state the exact supported conditions, and unknown
combinations remain closed.

**Enable a Provider report without service or history checks.** This would allow
new native input without proving the local components or a complete recoverable
history. Component intersection and transaction-bound history admission remain
separate mandatory checks.

**Wait for every platform before distinguishing a qualified combination.** This
would couple independent availability decisions without strengthening the evidence
for either combination. Per-combination qualification is separate from the
unchanged complete acceptance requirements.

## Consequences

Qualification maintenance requires versioned evidence, exact observed identities
and runtime invalidation. Backend identity cannot be guessed from a display name,
and no configuration override can manufacture support. A later registry entry
requires its real product and native evidence; the empty registry makes that
remaining work visible without weakening the admission mechanism.

Original uploads and native-produced transformed images remain separate immutable
sources when both are published. Existing correlation, source ownership, pin
lifetime, archive integrity and unknown-operation recovery do not change. Native
processing allowances do not authorize Daynight transcoding or omission.

The source-bound acceptance reports retain earlier failures and bounded successes.
Completing this qualification mechanism alone is not completion of the required
native, platform, mobile or product integration acceptance.
