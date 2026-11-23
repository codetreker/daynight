# Agent Note: Worker task tag admission

Status: implemented

## Problem

A Worker can receive a new selection policy while an earlier candidate or claim
request is in flight. Saving a filter without enforcing it at claim commit can
allow an unsupported or stale Worker to claim a task outside the saved policy.
Large valid existing targets also need to survive the addition of an empty field.

## Decision

The server stores a normalized Worker-wide name filter in the authoritative raw
target and checks it inside the Project claim transaction. The Worker row stays
locked until commit, and the task's current tags and an optional applied-filter
SHA-256 key are checked with the existing eligibility and task version. A nonempty
filter requires a supporting observation before it can be enabled or changed,
and requires the key on every new claim. The [configuration design](../../../../docs/design/daynight-worker-configuration.md)
and [claim design](../../../../docs/design/daynight-worker-claims.md) own the
persistence, compatibility, and transaction contracts.

## Alternatives

**Filter only after reading candidates.** This can miss later matching tasks and
cannot protect a claim against intervening configuration or tag changes.

**Check only the current server target.** A Worker still applying an older value
could claim a task outside its own effective policy. The semantic digest binds
the request to the applied view without sending a potentially large name list.

**Bind the complete configuration revision.** Unrelated settings changes would
unnecessarily reject claims; the digest changes only with filter semantics.

## Consequences

A saved nonempty policy immediately constrains direct claims, including from
older Workers that do not send a digest. Existing claims retain their lifecycle.
The canonical empty field has a fixed budget exemption to preserve old maximum
configurations; nonempty values remain subject to the existing content limit.
Candidate selection and Worker-side application are separate responsibilities;
claim enforcement prevents an unsafe intermediate state while they are absent.
