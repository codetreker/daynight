# Agent Note: Authenticated Web Workspace

Status: implemented

## Problem

Users need browser access to their private projects, project membership,
invitations and personal access tokens. A partial production switch would expose
a mixture of authenticated and unauthenticated resource paths before the service,
clients and acceptance callers are ready. The frontend also needs to discard a
previous user's data and preserve one-time secrets without making failed requests
look successful.

## Decision

`AuthenticatedApp` first shipped as an explicitly mounted shell so the frontend
could be exercised without publishing mixed authentication behavior. It now
serves as the production entry through the
[activation decision](../architecture/2026-10-22-authentication-activation.md).
It provides login, private project creation, account/token pages, member and invitation management,
and explicit invitation acceptance. It composes the existing project list,
project task tabs, graph and centered `TaskDetailDialog`. Workspace navigation
keeps the account entry in its sidebar footer; the [account navigation decision](2026-10-25-bottom-account-navigation.md)
owns its placement and responsive layout. Production `main.tsx`
now renders `AuthenticatedApp` under the same persistent `LocaleProvider`. Both
catalogs extend their complete `messages.auth` contract to login, project creation, account, members, invitations, tokens and
management dialogs. Selectors remain available on login, invitation, workspace
and modal surfaces. Semantic notifications and validation render through the
current catalog, while native formatters render dates and counts. Changing
language preserves inputs, one-time secrets, current identity and pending
requests. The
[authentication architecture](../../../../docs/design/daynight-auth.md) owns the
current mandatory composition. Component, real-service and real third-party
login evidence retain their separate scopes.

The shared request boundary uses same-origin browser credentials, cancellation
and request IDs. A current-generation 401 notifies the shell; identity transitions
invalidate outstanding requests and unmount user-owned content. A project 404
stays a resource error. The original foreground identity check concealed loaded
content until verification completed to avoid displaying a prior account during
a cross-tab switch. The [foreground verification decision](../bug-fix/2026-10-23-silent-foreground-identity-checks.md)
replaces that presentation policy: ordinary checks keep loaded content visible
and interactive until a changed identity, session loss or verification failure is
confirmed. New API reads and writes wait for identity confirmation, resuming for
the same account and cancelling on an account change. Failed checks retain the
blocking recovery overlay and request wait through recovery.
TaskDetailSessionProvider lives in that identity domain
and retains each project/task status/permission operation across dialog close/reopen;
identity changes discard its pending and unknown-outcome state. The existing
[status assignment decision](../architecture/2026-10-24-task-status-assignment.md) uses the same member
resource permission, not an admin-only status role. Auth-specific JSON parsing
and mutation encoding preserve member observation versions as `bigint` throughout
the positive int64 range.

Creation responses alone supply PAT values and invitation links. The UI keeps
those secrets in the current dialog, supports retrying a failed copy, and
requires confirmation before discarding a secret. Invitation capture removes the
URL fragment immediately and uses tab-local temporary storage across login.
Inspecting an invitation does not accept it; explicit confirmation sends accept,
and finishing the workflow clears the pending invitation.

Management dialogs reuse body scroll locking, background inertness, focus
containment, Escape handling and focus restoration. Existing executable HTML
continues at the application origin with the ordinary iframe, relative resources
and same-origin keyboard bridge. No preview-specific credential or infrastructure
is introduced.

### Login provider dependency

The frontend reads `GET /api/v1/auth/providers` with `{providers:[ids]}` and shows
loading, retryable failure or an explicit empty-provider state. The authoritative
list must reflect the configured UniAuth App's allowed and enabled providers.
There is no fixed provider list or local configuration fallback. The frontend API
now uses the mounted SDK-backed discovery route in the activation composition.
Empty provider sets and actual configuration/network failures remain distinct.
The initial frontend-only dependency is retained below as historical context.

The initial frontend delivery's UniAuth baseline was commit
`c82c55c7fcd366824d0bc5ac6bdd17528c0300fa`, Go SDK version
`v0.0.0-20261022051636-c82c55c7fcd3`. Its
[authorization URL builder](https://github.com/codetreker/uniauth/blob/c82c55c7fcd366824d0bc5ac6bdd17528c0300fa/sdk/go/uniauth.go#L82-L119)
validates local inputs and leaves registration and provider availability to the
gateway; the client also retrieves the one-time identity and exposes no provider
list. The [console provider response](https://github.com/codetreker/uniauth/blob/c82c55c7fcd366824d0bc5ac6bdd17528c0300fa/internal/console/handler.go#L233-L242)
reads global availability flags without an App ID. The
[authorization eligibility predicate](https://github.com/codetreker/uniauth/blob/c82c55c7fcd366824d0bc5ac6bdd17528c0300fa/internal/auth/handler.go#L345-L346)
also requires an enabled App, the provider in its allowlist and the registered
redirect URI. These sources preserve the reason discovery was unavailable at
that historical baseline; global flags cannot supply the required App-scoped
list. UniAuth [PR #19](https://github.com/codetreker/uniauth/pull/19), merged as
`0978963813fcefd9d553f6cb9bcc319084c764b3`, now supplies authenticated App-aware
[provider discovery](https://github.com/codetreker/uniauth/blob/0978963813fcefd9d553f6cb9bcc319084c764b3/docs/reference/api.md#L28-L73)
and the Go SDK
[Providers method](https://github.com/codetreker/uniauth/blob/0978963813fcefd9d553f6cb9bcc319084c764b3/sdk/go/providers.go#L14-L37).
It uses the exact registered redirect URI and returns the live App allowlist/
registry intersection. The frontend task deliberately kept the old pin;
activation now uses `v0.0.0-20261022095215-0978963813fc` and connects that real
provider contract without changing the frontend's discovery model.

### Validation ownership

The [Web README](../../../../packages/daynight-web/README.md#authenticated-workspace)
owns the actual-component fixture entry and validation commands. The fixture
mounts the production shell with controlled fetch responses and final styles. The
[static design prototype](../../../../docs/design/mockups/auth/index.html) retains
the broader scenario reference. Browser interaction against controlled responses
proves frontend behavior; real service composition and third-party login require
separate evidence. The
[bilingual requirements](../../../../docs/spec/daynight-web-i18n.md) apply to all
new authentication components, including their failure and pending-operation
states. Controlled bilingual frontend evidence does not replace the separately
tracked combined production acceptance.

## Alternatives

**Switch the production entry before coordinated activation.** At frontend
component delivery, the service still used its unauthenticated resource
composition. The opt-in shell exercised the actual frontend while resource
checks, required configuration and acceptance callers were prepared together.
That initial staging preserved the integration sequence selected by the
[architecture decision](../architecture/2026-10-22-auth-architecture.md).

**Hardcode known login providers or use global provider flags.** Neither proves
that the configured App permits the displayed provider. Explicit discovery
failures made the protocol gap visible at the historical SDK baseline. The
upstream discovery capability is now delivered, and activation must use it rather
than substituting global flags or a fixed provider list.

## Consequences

Independent frontend composition made the original staged delivery reviewable
and testable before the production switch. The mandatory composition now mounts
the same shell, while actual deployment and current-source acceptance results
require their own receipts. Member versions remain exact, user content has a
session lifetime, and copy failures do not destroy the only displayed secret.

Production provider discovery now uses the upgraded SDK and App-scoped UniAuth
contract through the mounted Daynight route. Controlled frontend fixtures do
not satisfy that requirement or demonstrate a successful real provider login. Existing
project browsing formats, graph behavior and trusted attachment execution remain
unchanged.
