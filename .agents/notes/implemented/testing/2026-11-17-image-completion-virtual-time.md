# Agent Note: Image Completion Rule Test Time

Status: implemented

## Problem

The image completion rule matrices wait for real media polling intervals even
though their controlled DAO already completes each request. The tests need to
exercise observation, renewed admission, publication and lease cleanup, not
measure native timer scheduling.

## Decision

Each matrix child creates its own fixture inside a `testing/synctest` bubble.
Production timers advance in virtual time while the existing DAO, local file
storage, decoder, admission checks and assertions remain in use. Fixture times,
contexts and cleanup share the bubble; real file operations still run normally.
The outer subtest loops stay outside the bubble.

## Alternatives

**Wait for real polling intervals.** This exercises native timer scheduling but
adds wall time to rule assertions whose outcomes do not depend on that scheduling.

**Add a production timing seam.** A test-only timing requirement does not
justify changing the Engine interface or production polling defaults.

**Return a prepared completion directly.** Bypassing the production observe and
poll path would weaken the proof of completion and renewed admission.

## Consequences

The tests retain production polling and the real file boundary without measuring
native timer behavior. Real network and process timing remains covered by its
own tests. Local case savings alone do not establish an overall CI improvement.
