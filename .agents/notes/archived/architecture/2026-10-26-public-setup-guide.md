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
`noopener noreferrer`. The reactive application entry selects the exact `/setup`
pathname before mounting the authenticated application; query parameters do not
change that selection. A public shell owns the localized title, breadcrumb,
language selector, skip link and focused main content. It reuses the five-step
guide and its copy behavior, without account controls or a session owner.

The guide mounts no identity, provider, invitation inspection, task-cache or
business-resource lifecycle. Direct access, reload, language changes, copying and
focus/visibility restoration make zero API requests. The application boundary may
clear pending invitation state when the user deliberately leaves that flow; it
keeps cleanup failures visible without starting an API request. Guide links back
to projects load `/projects`, where ordinary authentication begins after explicit
navigation away from the guide. The Go HTML route and callback namespace
reservation retain their owners.

The original public guide selected its path once at document startup. The
[public product entry decision](2026-10-26-public-product-entry.md) replaces that
bootstrap mechanism with reactive public/private selection while preserving the
zero-request guarantee. This guide decision partially supersedes the
authenticated composition in the
[original guide decision](../feature/2026-10-25-web-setup-guide.md). Its static
content, bilingual commands, clipboard lifecycle and service-route rationale
remain applicable. The [Web design](../../../../docs/design/daynight-web.md#日常使用引导页)
owns the guide composition, and the
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
The public shell keeps reading controls and ordinary document links for returning
to projects. The later reactive application entry handles public/private
composition without adding a second private-session controller.

## Consequences

Instructions remain readable for anonymous visitors and expired sessions. The
workspace stays open in its original tab. The public page shares appearance,
localization and guide content with the product but does not display an account
identity. Returning to a private page performs the usual authentication checks.

Regression coverage checks route selection and zero network calls across
public-page interactions; browser verification checks the actual new tab and
production assets. Any later addition to the guide must preserve its zero-API
requirement.
