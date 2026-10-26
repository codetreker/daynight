# Agent Note: Web Project Browsing Foundation

Status: implemented

## Problem

The approved task dashboard needs a browser entry point, project navigation and
correct pagination before graph presentation can be integrated. Without scoped
request ownership, a late response can restore discarded pages after refresh or
navigation. A reported coverage percentage can also omit files that tests never
import, defeating the required whole-source threshold.

## Decision

The private React/Vite package implements project browsing over the existing Go
API. Page state owns its cursor and request generation, preserves cards when a
continuation fails, and discards old results on refresh or unmount. Native browser
history provides routing. The project task view remains a separate task; the
existing server's deployed HTTP behavior is unchanged.

The typed client validates required fields, timestamps, UUID identities and
resource scope before returning data. It preserves cancellation, exposes safe
error categories and request IDs, and does not render raw server bodies. Domain
graph validation remains separate from transport decoding.

The browsing foundation added a required web check without changing existing Go
or native CLI workloads. The later [module-scoped CI decision](../process/2026-10-21-module-scoped-pr-ci.md)
selects affected PR jobs and preserves full main-push validation.
The exact statement gate enumerates every product TypeScript/TSX source and
requires complete runtime coverage records. It compares raw counters with
BigInt, rejecting equality at 90%, empty reports and missing runtime files.
Pure-type files are classified from actual emitted JavaScript using pinned
TypeScript 7 native compilation and its scanner. This emission is bounded,
project-local and cleaned independently; real module typechecking remains
mandatory. No source-name exclusion can remove runtime code from the manifest.

The V8 provider serializes an unbounded end column as JSON null. The checker
accepts that documented sentinel only at the statement's end column while
retaining statement and counter validation. The owning source is
[pinned converter logic](https://github.com/AriPerkkio/ast-v8-to-istanbul/blob/cff54c159a85d73176fc4aefc4141970704fce47/src/location.ts#L99-L100).

Tests register standalone jest-dom matchers through Vitest's Matchers extension.
The pinned framework adapter declares an incompatible Assertion generic, so the
standard standalone entry avoids loading that declaration without disabling
library typechecks or adding Jest globals. Dependencies remain pinned and the
existing Node 24 support range is preserved.

The [architecture](../../../../docs/design/daynight-web.md) owns integration.
The browsing foundation was delivered as a read-only consumer.
Production embedding and dev-ci deployment are implemented through the
[deployment decision](2026-10-20-embedded-dashboard-deployment.md). The later
[Web attachment decision](../feature/2026-10-21-task-attachment-web.md) adds
independent file mutations without changing project paging or graph snapshots.

## Alternatives

**Rely only on Vitest's displayed percentage.** An inclusive threshold accepts
exactly 90%, and an incomplete report can hide unimported runtime files. Independent
source enumeration and exact arithmetic enforce the approved requirement.

**Exempt declaration filenames or use a second compiler version.** Filenames do
not prove runtime absence, and a second compiler introduces divergent syntax
semantics. Native emission from the same pinned compiler supplies the evidence.

**Retain an earlier page after refresh or hide errors behind empty results.**
That misrepresents freshness or failure. Explicit loading/error state and request
generation checks preserve the visible meaning of refresh and pagination.

## Consequences

Project browsing has a tested API boundary and request lifecycle without a query
framework or global mutable store. The required coverage artifact includes
runtime classification, relative file identities and exact counts, so release
validation can detect omissions independently of the displayed percentage.

The source manifest check adds a bounded native compiler invocation. Dependency
upgrades must preserve its emitted-code and provider-format tests. The later
[dashboard implementation](../feature/2026-10-20-project-task-dashboard.md) and
[embedded deployment](2026-10-20-embedded-dashboard-deployment.md) own delivered
project details, graph rendering and single-service deployment. Attachment UI
extends that application through its own scoped state and decision record.
