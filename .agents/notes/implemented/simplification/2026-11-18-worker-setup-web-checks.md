# Agent Note: Worker setup checks for Web execution

Status: implemented

## Problem

Setup inspected Herdr endpoints, integration hooks and native prerequisites even
though Worker execution uses the Web Controller. Those checks could report
irrelevant failures and retained dependencies on the old execution path.

## Decision

Setup checks the operating system, Node.js and Git. It reports native
authentication, capabilities and working-directory identity as unverified until
the Controller checks them before dispatch. Git transport and task tools are
checked when used. Owned command cleanup failures remain visible even during
cancellation. Existing native verifier consumers retain their own interfaces. This replaces the
setup-specific checks in the archived [repository selection decision](../../archived/architecture/2026-10-27-worker-repository-selection.md).

## Alternatives

**Keep Herdr checks in setup.** They would report prerequisites unrelated to Web
execution and keep the old instance and preflight dependencies alive.

## Consequences

Setup can save despite missing common prerequisites, while showing the repair
needed. It cannot establish provider authentication or actual task readiness.
