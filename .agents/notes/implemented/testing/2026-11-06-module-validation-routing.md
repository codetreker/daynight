# Agent Note: Module validation routing

Status: implemented

## Problem

Per-file cross-module routing couples PR scheduling to imports and fixture
readers. Those lists grow as implementation details change and make a change
inside one module trigger unrelated module jobs. Treating every Node workspace
input as a Go input adds validation without a Go dependency on that tooling.

## Decision

PR application jobs follow module directories. `packages/daynight/` and installer
tooling in `scripts/` select CLI; `packages/daynight-server/` selects both the Go
module and [startup/shutdown job](2026-11-09-independent-go-startup-shutdown.md);
`packages/daynight-web/` and `deployment/` select Web. Implementations, fixtures
and test tooling follow the same ownership, without cross-module file lists.

Root `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `.npmrc` and the
`patches/` directory select CLI and Web. Selection accumulates across paths, so
those inputs combined with a Go-directory change select all three modules.

Independent Go API integration and product E2E follow their own runtime inputs.
API integration selects server inputs and the production Web build inputs
embedded by its Server, including root Node configuration and patches. These
inputs do not select the Go module job unless they also belong to its directory.
The [API integration decision](2026-11-09-independent-go-api-integration.md) owns
that scheduling and build boundary.

Product E2E selects its framework and actual production build inputs. Production
code/configuration can select E2E alongside its module; module-only tests and
fixtures retain their module validation and any selected API integration. The
[product E2E decision](2026-11-08-self-contained-product-e2e.md) owns that complete
runtime boundary, without restoring cross-module unit-test routing.

Documentation, repository instructions, the root `.gitignore` and manual
publication workflow retain their exclusions. Bundled CLI source Markdown
retains CLI selection. The strict version-only CLI manifest exception remains.
CI workflow, routing and unknown paths select every module, API integration and
product E2E. Complete merge-base diffs retain deletions and both sides of renames;
every main push runs them all. Final checks retain failure and cancellation
propagation and explicitly require selected CLI, Go module, startup/shutdown,
API, Web quality and product E2E jobs to succeed.

This routing originally selected real-shell completion with CLI and assistant
browser validation with Web. The
[independent shell/browser workflow](2026-11-12-shell-browser-workflow.md)
replaces that scheduling: both complete suites run on `main` pushes or manual
dispatch, outside PR module selection and final `checks`. CLI completion unit
tests and Web quality retain module selection. The new workflow file follows
the existing CI-path rule and therefore selects all ordinary application jobs
when changed in a PR; it does not add a selector exception or alter product E2E.

The [README routing table](../../../../README.md#ci-selection) owns the directory
map, and the [development guide](../../../../docs/development.md#ci-selection)
owns execution details. This replaces the cross-module scheduling assumptions in
the archived [module-scoped CI decision](../../archived/process/2026-10-21-module-scoped-pr-ci.md).

## Alternatives

**Maintain per-file consumer lists.** Import and fixture readers require ongoing
updates to the selector and make a single-module edit schedule other modules.

**Select Go for Node workspace inputs.** Go module validation owns its toolchain
and does not consume the Node workspace configuration or dependency patches.

**Run all modules for every PR.** This repeats unrelated validation for each
module change; full main-push validation remains the shared integration point.

## Consequences

Directory ownership gives existing and new files the same scheduling rule.
Other module-test consumers are validated on main unless their own module
directory also changes in the PR. Production cross-client integration is checked
by the independent E2E job when its inputs change. API integration validates the
assembled Go API and its production Server build without coupling that build to
module coverage. Mixed module changes still select every affected module, and
unknown inputs retain full ordinary validation until their ownership is defined.
Shell and assistant-browser regressions have no automatic per-PR hosted gate;
their independent results belong to the integrated or manually selected revision.
