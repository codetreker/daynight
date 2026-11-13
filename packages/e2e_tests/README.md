# Product E2E tests

This package builds the complete CLI, production Web and Go Server from the
current checkout and runs normal cross-client workflows against an isolated
system. It also builds the unmodified UniAuth production command and Console
from a pinned source revision. No running database, auth service, external
account or manually supplied application secret is required.

## Run

Use Linux, Node.js 24, pnpm 11.28.6, Docker and Git. Go 1.27.2 is selected for
builds, and OpenSSL generates a temporary provider certificate. Install workspace
dependencies and the locked Playwright browser from the repository root:

```bash
pnpm install --frozen-lockfile
PLAYWRIGHT_BROWSERS_PATH="$PWD/.tmp/playwright-browsers" \
  pnpm --filter @codetreker/daynight-e2e exec playwright install chromium
pnpm e2e:test
```

Set `PLAYWRIGHT_BROWSERS_PATH` to reuse an existing matching Playwright browser.
The runner otherwise uses the checkout's `.tmp/playwright-browsers`. Browser
profiles, credentials and temporary runtime files remain inside the run's private
directory.

The first preparation can download the pinned UniAuth source, Go toolchain,
dependencies and container images. Later runs reuse the checkout's
`.tmp/product-e2e-cache`. An optional local Git source can supply the pinned
UniAuth commit without changing the repository source pin:

```bash
pnpm e2e:test -- --auth-source /path/to/uniauth-checkout
```

Only preparation accesses dependency registries or source repositories. The
running application system uses a dedicated internal database network and a
private ingress bridge. Its container removes the default route before services
start, retaining only local runtime connections. Runtime services and authentication dependencies are all started by
this package.

## Runtime topology

Each run owns a dedicated internal database network, private ingress bridge,
PostgreSQL 18.6 container and data volume, runtime image and application container. The application container runs
the compiled Daynight Server, compiled UniAuth and a local OAuth provider. The
compiled CLI and Playwright browser drive the system from the host through
loopback-only published ports.

Server and UniAuth use their complete production entry points. The production
Web is embedded in the Go binary. The CLI executes a copied compiled `dist`
tree using the checkout's locked runtime dependencies. Packaging and launcher
compatibility remain the responsibility of installed CLI tests.

The normal authentication path runs through real UniAuth gateway and Console
logic. The local provider replaces only GitHub's upstream OAuth service because
the pinned UniAuth GitHub adapter uses fixed HTTPS endpoints. An allowlisted
HTTPS CONNECT proxy terminates those requests locally with a temporary
certificate; it never connects to GitHub or forwards to another destination.
UniAuth trusts that certificate only in its own process, and the test browser
accepts it only in its own context. No system trust store is changed.

The runner first signs in to the real UniAuth Console through the local provider,
then registers a Daynight App through the Console API. It uses the returned
credentials to start Daynight. Product login and CLI device authorization are
then performed through the real application. Database rows and product sessions
are not inserted directly to bypass these flows.

## Scenarios and fixtures

`tests/main-flow.spec.ts` verifies browser login, CLI device login, the same
device-issued PAT's initially empty and subsequently recorded usage in the
production Web account list after a successful CLI request, CLI project
and task creation, default proposed readback, explicit todo creation for confirmed
reference work, project detail and attachment-tab Back/Forward, direct Web proposed-to-in_progress modification, CLI readback and
completion, and Web reload. A second Task is claimed, registered, released and
claimed again through the real service; CLI reads both Session identities and the
Web shows the retained history without the old current claim. These API registrations
do not start a Worker process. The same resource IDs and content cross the clients
and persist in the real database.

The same authenticated journey launches the compiled CLI's public Test Session
Controller with an environment-owned Codex stdio peer. The peer replaces only
the upstream native agent: the production adapter, source authority checks,
Markdown parser, image decoder, sealed media owner, relay and service run
normally. One native tool image and one local Markdown image are captured through
direct submit and read back with their exact bytes and resource identities.
The runner packages the production image validator with its locked native
dependencies, records helper and manifest hashes, and configures the real service
through its `DAYNIGHT_IMAGE_*` settings. Its private decoder directory shares
the environment's cleanup lifecycle.
After the source is removed, normal Controller stopping publishes a complete
archive; the manifest, timeline, originals and production Web are read again.
This establishes the product's normal Controller path, without claiming live
third-party provider behavior. Failure, capability, retry and transport matrices
remain with their CLI and service owners.

Add normal sequential journeys under `tests/`, using `tests/fixtures.ts` for the
compiled CLI, isolated configuration and topology. Product scenarios use valid
data and ordinary sizes. Boundary, denial, conflict, race, recovery and stress
matrices belong to module tests and their own integration entries.

Framework verification is separate from product journeys:

```bash
pnpm --filter @codetreker/daynight-e2e typecheck
pnpm e2e:test:harness
```

Harness tests verify process failures, deadlines, cancellation, descendant
termination, partial setup cleanup and the local provider protocol. They do not
start the complete product system. Product E2E is an explicit local entry and is
not implicitly called by CLI, Web or Go module test jobs. Its independent CI
job runs the same explicit entry.

## CI

The `verify-e2e` Linux job is selected when framework or production build inputs
change, and on every main push. It prepares the locked toolchain and browser,
checks the framework, runs harness tests and calls `pnpm e2e:test`. The final
`checks` gate requires a selected product E2E job to succeed.

The hosted Ubuntu image supplies Chromium's runtime shared libraries. CI runs
`playwright install chromium` from this package's locked dependency within a
four-minute step, using the checkout-local browser directory. It does not run
an APT transaction for Playwright's additional fonts on every job. Playwright's
default host dependency checks remain enabled, and the complete journey must
launch that locked browser successfully. Download failures and missing runtime
libraries still fail validation. The
[browser installation decision](../../.agents/notes/implemented/testing/2026-11-10-product-e2e-browser-installation.md)
records the dependency assumption and its limits.

CI writes the exact run pointer and preparation phase through
`DAYNIGHT_E2E_RUN_POINTER`. Every step has a deadline: the declared maxima total
38 minutes inside a 40-minute job, including a 15-minute journey, a 3-minute
recovery step and evidence upload. It always invokes `pnpm e2e:cleanup` when the
journey started. Recovery uses the persisted run identity and owner
labels to reconcile only its resources. It can reclaim files after the original
runner process is dead, and it does not replace the original test failure with
success. Only results and logs are uploaded; private files and build artifacts
stay excluded.

Dependency caches can accelerate preparation, but every invocation still builds
and runs the current checkout. The [test-writing rules](../../docs/writing_tests.md)
define the distinction between module, API integration and product E2E tests.

## Results and cleanup

Each invocation prints a `.tmp/product-e2e/<run-id>` result directory. It retains
the source revision and fingerprint, binary and Web asset hashes, container
identities, Playwright result, failure screenshots/traces and runtime logs.

Setup and execution have deadlines, readiness detects early service exit, and
failures propagate to the command exit status. Cleanup runs after success,
failure or cancellation, removes only the current run's containers, data volume,
networks and runtime image, and verifies their absence. After product processes stop, parent cleanup uses a tracked helper container
with no network to restore private mount ownership. This also works when the
application was forcibly terminated, so the host can remove nonempty attachment
trees. Private credentials,
auth SQLite data, attachment storage, certificates and copied build artifacts
are removed. A cleanup failure makes the run fail rather than producing a
successful result.

The framework does not touch an existing deployment or use its database. A
passing local run establishes only the recorded source and scenarios; it does
not establish hosted CI or live third-party authentication behavior.
