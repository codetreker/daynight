# Agent Note: Independent Shell and Browser Workflow

Status: implemented

## Problem

The original PR gate included real-shell toolchain preparation and the frontend
assistant browser suite alongside module validation. Their environment setup
and execution can delay the final PR result. The complete shell behavior harness
also ran through a thin ordinary Vitest wrapper on Linux and macOS, as well as
the dedicated three-shell job. Moving a job alone would leave that implicit
real-shell workload in ordinary CLI tests.

The existing separation has useful guarantees. The
[completion decision](../../archived/feature/2026-10-20-shell-completion.md)
established real Readline and ZLE validation at the supported Bash minimum, while the
[Web validation decision](2026-11-06-web-quality-validation.md) gave browser work
an independent runner so a quality failure could not prevent its execution.
Those guarantees depend on complete suites and isolated execution, and their
scheduling must make the tested revision and remaining PR guarantees clear.

## Decision

The `shell and browser acceptance` workflow in
[`.github/workflows/shell-browser.yml`](../../../../.github/workflows/shell-browser.yml)
runs `verify-completion` and `verify-web-browser` on every `main` push and through
`workflow_dispatch`. Neither job depends on module selection or the other job.
Each validates its event checkout with its own pinned actions, Node.js, pnpm and
locked workspace dependencies. They retain their original job timeouts,
failure propagation, owned-resource cleanup and evidence uploads.

Shell validation retains both `shell-module.py --shell all` and
`pnpm completion:acceptance`, using the prepared Bash 4.2, modern Bash and zsh
toolchains. The module harness owns the full behavior and setup-error matrix;
the artifact suite retains actual Tab and startup-loading checks. The thin
`shell-module.integration.test.ts` wrapper is removed from ordinary discovery.
Completion unit tests remain in the CLI module suite.
The shared `daynight-completion-acceptance` artifact includes both available
JSON receipts, and upload is attempted after the module step starts even if it
fails before artifact acceptance can run.

Browser validation retains the complete assistant Playwright configuration,
locked Chromium installation, private Vite host, one worker, zero retries and
JUnit/capture evidence. The explicit Web module browser command remains
available for all frontend fixture configurations; ordinary unit and quality
commands do not invoke browser suites.

Ordinary `checks` contains neither specialized job nor a dependency or selected
success guard for either. Its CLI, Web quality, Go, API integration and product
E2E jobs retain their existing selection and required outcomes. Product E2E
continues to install Chromium and build and run the complete product from its
checkout. The [module selector](2026-11-06-module-validation-routing.md) is
unchanged: a change to the new workflow follows the existing CI-path fallback
and selects all ordinary application jobs.

The [development guide](../../../../docs/development.md#ci-selection) owns
commands, event triggers and evidence interpretation; the
[Web guide](../../../../packages/daynight-web/README.md#assistant-browser-validation)
owns the assistant suite and browser prerequisites.

## Alternatives

**Keep both jobs in every affected PR gate.** This preserves automatic hosted
shell and assistant-browser validation before integration, but retains their
toolchain and execution time in the ordinary PR completion path. It also keeps
the duplicate real-shell invocation unless ordinary discovery is changed.

**Move only the workflow job declarations.** The ordinary CLI Vitest wrapper
would still launch the real-shell behavior harness on Linux and macOS. Removing
that thin wrapper while retaining the complete explicit Python entry establishes
the intended command boundary without deleting its assertions.

## Consequences

PR `checks` can finish without waiting for shell preparation or assistant browser
execution. This does not establish a measured speedup; hosted durations and
runner capacity still determine the observed result.

A passing PR gate no longer proves either specialized suite passed on that PR.
A regression may first appear after integration on `main`. Manual dispatch and
explicit local commands can provide earlier evidence, but are not automatic
per-PR hosted guarantees. Results belong to their actual checkout, environment
and execution; a main-push result cannot be attributed to an earlier PR tree.

Main-push and manually dispatched failures remain failed workflow results, with
available evidence retained. They do not retroactively change the ordinary PR
gate. Suite assertions, supported shell versions, browser coverage and product
E2E obligations are preserved; the deliberate cost is later automatic discovery
of shell or assistant-browser regressions.
