# Agent Note: Credential Usage HTTP Metadata

Status: implemented

## Problem

Account owners need the recorded use time of their credentials through ordinary
metadata reads. Existing clients must remain able to read OAuth grants, while a
new consumer must distinguish a recorded null from a missing protocol field.
Deployment and rollback must account for already-open clients as well as the
server's database schema.

## Decision

PAT list, creation and expiry-update metadata include a required nullable
`lastUsedAt`. Device token delivery retains its original response; the owner
list exposes the corresponding PAT metadata. OAuth v1 grants retain their exact
nine-field representation, while the v2 list explicitly projects those fields
and the required nullable timestamp from the same lifecycle read and snapshot
rules. Revocation remains on v1. The [authentication design](../../../../docs/design/daynight-auth.md#主站-session-与-pat)
owns the endpoint contracts and [deployment constraints](../../../../docs/design/daynight-auth.md#协议发布与恢复).
The [persistence decision](2026-11-12-credential-usage-persistence.md) owns the
meaning and monotonic storage of recorded times.

## Alternatives

**Add the field to the OAuth v1 list.** The existing Web parser rejects unknown
grant fields, so a newer backend would break already-open pages. A separate
explicit projection preserves those pages while making the v2 field mandatory.

**Treat a missing field as null in the new consumer.** Missing protocol support
would be indistinguishable from a credential with no recorded value, masking an
unsafe deployment or rollback. The consumer must require the field instead.

## Consequences

Old pages continue using v1 on the new backend; the new representation requires
backend deployment before a consumer uses it. Once such a consumer is live, a
recovery artifact must retain the new protocol or the clients must actually be
retired before restoring an older server. Preserving database columns alone does
not ensure compatibility. The timestamp is asynchronously recorded and null
means no value was recorded, not proof that the credential was never used.
