# Agent Note: Public setup guide without API requests

Status: implemented

## Problem

Opening usage instructions must preserve the current workspace and remain
available without a valid account session. Identity verification and provider
discovery can trigger authentication even though the guide contains only static
instructions. Window foreground checks must not turn reading the guide into an
authenticated operation.

## Decision

The workspace header opens `/setup` with a native new-tab link and
`noopener noreferrer`. The application entry selects the exact `/setup` pathname
before mounting the authenticated application. Query parameters do not change
that selection. A public shell owns the localized title, breadcrumb, language
selector, skip link and focused main content. It reuses the five-step guide and
its existing copy behavior, without account controls or a session owner.

The public entry mounts no identity, provider, invitation, task-cache or business
resource lifecycle. Direct access, reload, language changes, copying and
focus/visibility restoration make zero API requests. Guide links back to projects
load a new document so the authenticated application starts only after explicit
navigation away from the guide. The Go HTML route and callback namespace
reservation retain their existing owners.

This partially supersedes the authenticated composition in the
[original guide decision](../feature/2026-10-25-web-setup-guide.md). Its static
content, bilingual commands, clipboard lifecycle and service-route rationale
remain applicable. The [Web design](../../../../docs/design/daynight-web.md#日常使用引导页)
owns the current composition, and the
[Web requirements](../../../../docs/spec/daynight-web.md#日常使用引导) own observable
outcomes.

## Alternatives

**Skip identity reads inside the authenticated application.** The application
also owns foreground revalidation, session invalidation, invitation handling and
task-cache lifetimes. Suppressing individual requests would make static-page
availability depend on every present and future session effect. Selecting the
public entry before mounting that component keeps all those effects outside the
guide's lifetime.

**Retain workspace navigation inside the guide.** Its client-side links assume
an authenticated route owner, and its account controls require identity data.
The public shell keeps reading controls and uses ordinary document navigation
for returning to projects, avoiding a second session-aware router.

## Consequences

Instructions remain readable for anonymous visitors and expired sessions. The
workspace stays open in its original tab. The public page shares appearance,
localization and guide content with the product but does not display an account
identity. Returning to a private page performs the usual authentication checks.

Regression coverage checks bootstrap selection and zero network calls across
public-page interactions; browser verification checks the actual new tab and
production assets. Any later addition to the public shell must preserve the
zero-API requirement.
