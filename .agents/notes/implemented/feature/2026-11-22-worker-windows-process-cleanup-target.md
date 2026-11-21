# Agent Note: Worker Windows Process Cleanup Target

Status: implemented

## Problem

The service now carries `enableWindowsProcessCleanup` beside `enableSudoCleanup`
as an independent configuration target. A Worker that does not recognize it
keeps it as opaque authority: the member is preserved, no application result is
reported for it, and the target stays unapplied. That is correct behavior for an
unknown field, but it means no Worker can ever report the member as applied, and
the service cannot distinguish "not yet understood" from "understood and
disabled".

Recognizing the member is therefore a prerequisite for consuming it, and it has
to happen before any behavior depends on it: a Worker that acted on the value
without first reporting its application would execute a target the service never
saw confirmed.

## Decision

The member joins the presence-gated group, beside `enableSudoCleanup` and
`taskTagFilter`, rather than the capability-negotiated group that owns
`toolPaths`, `archiveSessions` and `agentControlMode`. The service sends it
directly in the target, with no field-specific capability header, so the client
parses it when present and omits it when absent. A capability flag would
describe a negotiation that does not exist.

Nothing consumes the value in this change. Behavior lands separately so the
plumbing and the act of terminating processes are reviewed apart from one
another.

### Cache schema 12

The storage checkpoint moves from 11 to 12. Both share one envelope, so one
decoder reads them and only the version distinguishes them: a schema 11 cache
was written by a binary that could not apply the member, so reading it as a 12
would adopt an application that never happened.

Schema 11 therefore parses its target with the member unrecognized, and refuses
a ledger that already records a result for it. Where the target does carry the
member, the upgrade adds a pending obligation against the current application
revision, which is the same treatment `taskTagFilter` received when it became
known.

Envelopes older than 11 go further: they keep the member as opaque authority
rather than reconciling it. Their desired document is read through the frozen
historical source module, which deliberately is not extended as new fields land,
so the member never enters their parsed target and no obligation is invented for
it. A result for the member in any envelope before 12 is rejected outright.

The migration obligations that belong to genuinely older envelopes are now
guarded against schema 12 explicitly. The current decoder reports version 12 for
both versions it accepts, so without that guard an 11 would newly acquire the
mode and tag-filter obligations that were written for caches that never
understood those members.

### Observation accounting

The observation item cap rises from 1029 to 1030 and the member joins the set
excluded from the 1025 ordinary-item limit, so it holds its own slot instead of
displacing a project item. Report selection and the cache's current-item
requirements count it the same way.

## Alternatives

**Reuse `enableSudoCleanup` with a platform branch.** One target would need no
new plumbing at all. It would also conflate two different authorizations: sudo
cleanup grants elevated deletion of files the Worker owns, while process cleanup
grants termination of processes it does not own. An operator who enabled the
first has not consented to the second, and the sudo path is skipped entirely on
Windows today, so the branch would have to invent a meaning for a value that has
never applied there.

**Negotiate the member through a capability header.** This matches
`archiveSessions` and would let a server withhold the field from clients that
cannot use it. The service does not negotiate it, so the client would be
describing a protocol that does not exist, and the header would have to be
threaded through every exchange for a boolean that is already safe to omit.

**Keep schema 11 and recognize the member within it.** No migration would be
needed. A checkpoint written before this change would then be read as though its
Worker had applied the member, which is the specific error the version exists to
prevent: the ledger would show a target with no corresponding application and
either fail validation or, worse, be treated as applied.

**Extend the frozen historical source module instead of leaving older envelopes
opaque.** That would let pre-11 caches reconcile the member too. It also
rewrites the decoder for structures that are already deployed, which is what
freezing them was meant to stop; those envelopes are migrated on the next
received document anyway, where the member arrives with its ledger entry.

**Land recognition and behavior together.** The sudo equivalent did this in one
change of roughly a thousand lines. Separating them keeps the schema migration
reviewable on its own terms, and the termination behavior cannot be reviewed
properly while buried under configuration plumbing.

## Consequences

A Worker reports the member's application instead of preserving it as opaque
authority, which is what lets the service observe a confirmed value. Checkpoints
written by this binary are schema 12 and are rejected by earlier binaries, which
discard and rebuild them from the service rather than misreading a member they
do not know. The added obligation costs one observation item per Worker that has
the member in its target. No cleanup behavior changes.
