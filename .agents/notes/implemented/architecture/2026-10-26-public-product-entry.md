# Agent Note: Public product introduction and explicit workspace entry

Status: implemented

## Problem

First-time visitors need to understand the product and inspect its value before
signing in or installing local tools. Returning users need a stable route to
their work. Combining those purposes at the root address makes the product
introduction depend on identity and obscures the difference between learning,
authentication and private work. Changing that entry must preserve task links,
invitations, CLI authorization and the existing private-session lifecycle.

## Decision

The same origin serves a public introduction at `/`, independent login at
`/login`, the project index at `/projects`, and the existing public guide at
`/setup`. The homepage remains readable with an authenticated session. Its
primary action opens a local interactive example; onboarding continues to the
guide. Workspace links have explicit private destinations.

A reactive application entry under the persistent locale provider selects the
public homepage, public guide or existing authenticated application. The
homepage's abortable identity hint changes navigation only; it does not admit
private content or create a task-cache scope. Unknown identity leaves the public
page and a usable entry available. The guide preserves its zero-API guarantee.
Private pages continue to own authoritative identity reads, request generations,
foreground revalidation and user-scoped cache lifetime.

Login preserves a validated `returnPath`, defaults to `/projects` only when no
target is supplied, and uses replacement navigation around authentication to
avoid history loops. Known callback failures retain the transaction's target,
including local session creation failure. Invitation lifetime follows its
effective business target through login. Leaving that flow for a public page
clears pending invitation state at the application boundary, with visible
cleanup failure. Device authorization and account switching retain their own
continuations; ordinary logout can return to the public homepage.

Typed bilingual content and a scoped landing stylesheet reproduce the product
visual language without changing workspace styles. The example uses stable
local identities and derived dependencies, safe JSX documents and explicit
completed-example evidence. It neither accesses real tasks nor simulates account
authority. Default HTML and locale-aware metadata use the existing Vite-to-Go
publication pipeline.

This replaces the initial-only bootstrap selection in the
[public guide decision](2026-10-26-public-setup-guide.md), while preserving that
decision's public reading and zero-request rationale. It narrows the production
entry statements in the
[authentication activation](2026-10-22-authentication-activation.md) and
[Web workspace](../feature/2026-10-22-web-auth-workspace.md) records: their
authenticated lifecycle now owns protected and login routes, rather than the
public introduction. The [requirements](../../../../docs/spec/daynight-landing.md)
and [design](../../../../docs/design/daynight-landing.md) own the complete current
behavior and mechanism.

## Alternatives

**Move the application to an `app.` subdomain.** Separate origins are useful
when independent site operation or browser isolation is required. That move also
requires deliberate continuity for host-only sessions, registered callbacks,
origin-local preferences and existing CLI/device/invitation URLs. Path-based
separation gives these page roles clear destinations without changing those
contracts.

**Change the root page according to authentication.** This keeps one familiar
workspace address, but makes the introduction unavailable at that address for
signed-in users and ties public reading to identity resolution. A stable public
root and explicit workspace entry support both audiences predictably.

**Keep only startup pathname selection.** Selecting the original public guide
before mounting authentication avoided its side effects. A public homepage adds
navigation across multiple public and private branches; one-time selection would
make direct entry and client-side history disagree. Reactive ownership preserves
the original guide isolation across those transitions.

**Deliver route scaffolding before the product journey.** The route and page
changes serve one visitor outcome. A route-only cut would temporarily change the
root's meaning or expose incomplete demonstration actions. The focused delivery
includes the required routing, content, authentication continuity and validation
together; unrelated product capabilities remain separate work.

## Consequences

Public reading remains available during identity failure, while private data
continues to require the existing authoritative checks. The root address is
shareable by both new and current users. Existing workspace-index links must use
`/projects`, and authentication tests must cover effective targets and transitions
across the public boundary.

An optional homepage identity read adds a bounded public navigation request but
grants no authority. The setup guide continues to make none. Static default
metadata and client localization do not provide localized server-rendered HTML
or promise crawler ranking.

CMS, analytics, billing, server rendering and autonomous Worker execution remain
independent capabilities. Their later introduction is additive only while the
public page, example data and private-session ownership remain separate. A future
origin split requires a new session, link and deployment continuity decision.
Validation receipts remain bound to the tested source and environment; the
existence of the page does not establish measured visitor conversion.
