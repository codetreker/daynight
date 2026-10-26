# Agent Note: UniAuth-backed Project Authorization Design

Status: implemented

## Problem

When this architecture was adopted, the delivered local service had no user or
membership model. Its global project list could not express which people may
access a project's tasks and attachments.
The application needs individual identity, revocable credentials and project
membership while preserving the existing trusted attachment execution model.

## Decision

The adopted [requirements](../../../../docs/spec/daynight-auth.md),
[architecture](../../../../docs/design/daynight-auth.md) and
[interactive UI](../../../../docs/design/mockups/auth/index.html) define the
implementation. The [identity foundation](2026-10-22-identity-credentials.md) and
[membership foundation](2026-10-22-project-membership.md) first delivered callable,
unmounted modules so their transaction and identity behavior could be reviewed
without partially changing production access. [CLI credentials](2026-10-22-cli-server-credentials.md)
and the [Web workspace](../feature/2026-10-22-web-auth-workspace.md) followed that
staged boundary. The [activation decision](2026-10-22-authentication-activation.md)
now mounts all of them: resource Principal checks, required runtime config and
`AuthenticatedApp` under the persistent locale Provider. It also fixes the SDK
to the delivered App-aware discovery capability from UniAuth
[PR #19](https://github.com/codetreker/uniauth/pull/19). This note retains original
choices; actual runtime/acceptance results require their own source-bound receipts.

Existing UniAuth and its Go SDK provide one-time identity handoff. Daynight owns
stable local users, browser sessions, personal access tokens, project memberships
and invitations. The creator becomes an admin atomically; admin/member share
existing resource read/write authority, and admins manage membership. Resource
access uses current membership inside the existing snapshot or write transaction.

### Adopted trusted same-origin preview boundary

Executable HTML remains trusted project code at the main application origin,
with the viewer's current main-origin authority. The ordinary iframe, relative
scripts/styles/images/fetch and existing same-origin keyboard bridge remain.
Attachment requests reuse the main browser session and normal project checks.
This preserves the [attachment architecture decision](../../archived/architecture/2026-10-21-task-attachment-storage-design.md)
and [Web attachment decision](../../archived/feature/2026-10-21-task-attachment-web.md).

Independent preview domains/origins, preview credentials/sessions, bootstrap
exchanges, cross-origin shells and their DNS/TLS/gateway infrastructure are
outside the adopted architecture. Authentication must not add them as inferred
prerequisites. Changing the trusted preview model requires a separate explicitly
authorized architecture decision. Project membership is request authorization;
it does not promise to sandbox trusted uploaded HTML.

### Integration and scope

Identity and membership were first tested without mounting them. The mandatory
activation now integrates resource checks, clients, required config, public
health checks and normal-protocol acceptance callers together. Its delivery
requires integrated security proofs; a final combined receipt supplements those
proofs and cannot replace them. Code or document completion alone does not assert
that a gate passed.

Development and CI reuse same-origin numeric-loopback HTTP and UniAuth's existing
explicit SDK AllowLoopbackHTTP support. Current activation separately configures
HTTP main-site test origins and the exact callback while production defaults to
the application's configured HTTPS origin and existing entry point. A concrete UniAuth limitation must be
reported with evidence to its maintainer; an assumed gap does not authorize a
workaround architecture or changes to UniAuth.

## Alternatives

**Shared instance key.** It cannot represent the confirmed per-user project
membership requirements.

**Generic downstream OIDC client or authentication proxy.** UniAuth provides a
product handoff rather than downstream OIDC tokens. A proxy would not replace
project authorization and adds a deployment component; the existing SDK fits.

**Independent preview origins and scoped credentials.** They would isolate
uploaded code from the viewer's other authority, but introduce a different
content-trust model, credential lifecycle and deployment requirements. The
adopted product treats HTML as trusted same-origin project code and explicitly
keeps that architecture. This alternative is not an authentication task.

**Incremental exposure of partly authenticated resource paths.** This would
leave mixed access or require skipping existing checks. Tested components
followed by one complete activation keep the existing local boundary until the
whole authenticated composition is ready, without an auth-disable flag.

## Consequences

The implementation adds local users, memberships, invitations and two ordinary
credential types, with final-style frontend artifacts. The
[device-login decision](2026-10-25-cli-device-login.md) extends CLI acquisition
with an explicit browser-approved device flow while reusing PAT authentication,
expiry and account revocation. Web token management and App-aware provider
discovery are mounted in the mandatory composition. The activation decision owns current configuration,
fixture privacy and gate requirements. It reuses the
existing application origin, file storage, project locks, runtime and deployment topology.
No preview-specific lifecycle or infrastructure is introduced.

Existing project assignments are deferred to manual membership maintenance.
Zero-member projects remain inaccessible through the normal query, with no
legacy branch. Revocation rejects new resource admissions; admitted file
transfers may finish and previously downloaded data cannot be recalled.
Filesystem/PostgreSQL atomicity remains the accepted K1 limitation.

The trusted HTML decision is a constraint on implementation and review, not an
untracked future promise to add isolation. Current composition is implemented;
actual upstream login and complete acceptance remain unfulfilled until their
own evidence and required PR integration are confirmed.
