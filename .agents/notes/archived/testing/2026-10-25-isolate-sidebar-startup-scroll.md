# Agent Note: Isolate Sidebar Startup Errors from Prior Scroll

Status: implemented

## Problem

The `narrow-layout` browser scenario reaches sidebar preference startup checks
after navigation and scrolling through the project page. At 320×500, reloading
the page can restore the earlier document scroll position. In main run
[`40198288115`](https://github.com/codetreker/daynight/actions/runs/40198288115),
the read-failure notice and retry button remained in the DOM, but the retry
button had a viewport ratio of zero. The
[failed-source scenario](https://github.com/codetreker/daynight/blob/f996d2003f5df5665b172dcaf43d476a1e2c6bf7/packages/daynight-web/tests/e2e/workflow.spec.ts#L1728-L1760)
was intended to verify that startup errors are actionable on a narrow screen.

## Decision

Before reloading for the startup-failure scenario,
`workflow.spec.ts` sets the viewport to 320×500, scrolls the document to the
top, and waits until `window.scrollY` is zero. The reload therefore begins from
a deterministic startup position. The scenario retains viewport assertions for
both read and write failures, retries the save successfully, verifies that the
notice clears, and checks for horizontal overflow.

The [sidebar preference decision](../feature/2026-10-25-sidebar-preference.md)
owns the product behavior and error feedback. This testing decision isolates
the startup visibility check from page position left by earlier scenario steps;
it does not make the notice follow the viewport during later scrolling.

## Alternatives

**Keep the notice attached to the viewport while scrolling.** This adds a
persistent product notification behavior and consumes reading space throughout
long pages. The startup error requirement does not establish that behavior; it
can be reconsidered if a separate product decision requires ongoing visibility
after the user scrolls.

**Remove the viewport assertions.** Checking only that the notice and button
exist in the DOM would allow a narrow-screen startup error to remain inaccessible
to the user, weakening the existing visibility requirement.

## Consequences

The startup assertions no longer depend on scroll position produced by preceding
navigation and graph interactions. Read and write failure visibility and the
successful retry remain covered at a narrow viewport. The test does not claim
that the notice stays visible after scrolling, and no production layout or
scroll-restoration behavior changes.
