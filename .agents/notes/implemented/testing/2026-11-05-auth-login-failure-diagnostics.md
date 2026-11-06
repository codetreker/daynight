# Agent Note: Authentication login failure diagnostics

Status: implemented

## Problem

The visible login acceptance journey controls an external OAuth provider through
a page CDP session while exercising the real application and gateway redirects.
Its cleanup can fail after a navigation, assertion or test timeout. A rejecting
`Fetch.disable` in a `finally` block replaces the earlier exception and prevents
the following session detach. A total test duration and a later target-closed
error cannot identify the original failing operation.

Action and network traces contain authentication credentials. Diagnosing this
journey therefore needs operation-level evidence that preserves failure order
without capturing requests, responses or OAuth parameters.

## Decision

`auth-login-session` names its awaited operations with Playwright steps and saves
an `auth-login-operations` JSON attachment on success and failure. Each entry
contains only its operation label, status, duration and optional error name.
Labels describe fixed test actions and layout cases; they contain no service URL,
OAuth query, credential or response body. The attachment complements the existing
source-qualified Playwright report and does not change scenario selection or
acceptance thresholds. The [journey timing decision](../../archived/testing/2026-11-04-web-journey-timing.md) records the rationale for the existing use of named steps for other journeys.

The journey retains its body error while attempting every owned cleanup action.
Each cleanup action has an independent five-second limit, including removal and
draining of identity routes, provider interception disable and CDP detach. A
failed or timed-out disable still permits detach. A sole failure is rethrown
unchanged; combined failures retain the original objects in an `AggregateError`,
with the first failure as its cause. Diagnostic attachment failure participates
in the same error propagation.

The controlled-provider deadline begins at the login action. Provider and logout
response promises are observed immediately, so an earlier operation failure does
not leave their rejection unhandled. The provider timer and listener are removed
during cleanup. Raw CDP interception remains necessary: the provider request
follows real application and gateway redirects, which Playwright's user routing
does not intercept as independent requests. The
[authentication activation decision](../../archived/architecture/2026-10-22-authentication-activation.md)
records the rationale for the existing fixture and trace privacy policy.

## Alternatives

**Enable authentication traces.** They can retain Cookie headers, authorization
codes and response bodies. Fixed operation labels locate the failing await
without introducing those artifact contents.

**Suppress target-closed cleanup errors.** This would lose evidence of incomplete
cleanup and turn a cleanup-only failure into success. Every observed cleanup
failure remains visible alongside the original error.

**Wait indefinitely for interception disable before detaching.** A missing CDP
response could consume the test deadline and prevent release of the session.
Independent cleanup limits permit subsequent cleanup and expose the timeout.

**Replace raw CDP with a provider URL route.** Playwright skips user interception
of redirected requests, so this would change the controlled-provider behavior
after the real gateway redirect. Its
[Chromium network handler](https://github.com/microsoft/playwright/blob/cfe490d941f992655948eee8fd4fd94e1c4234bf/packages/playwright-core/src/server/chromium/crNetworkManager.ts#L342-L351)
continues those redirected requests before invoking user routes.

## Consequences

The native and container executions retain all existing login, responsive layout,
session reload and logout assertions with zero retries. Focused regressions
exercise success, original timeout preservation, multiple cleanup failures,
bounded cleanup and diagnostic attachment failures. Ordinary traces remain off.

Operation evidence and cleanup error preservation diagnose future failures; they
do not establish the trigger of a historical timeout whose original operation
stack and artifact are unavailable. A cleanup timeout is evidence of an
unconfirmed operation, not proof that its underlying protocol command stopped.
The acceptance runner retains ownership of final browser and process cleanup.
