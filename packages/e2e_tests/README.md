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
PostgreSQL 18.6 container and data volume, a Redis monitoring container, runtime image and application container. Redis has no published host port or persistent volume; it uses a bounded 64 MB memory budget, no eviction and no persistence. The application container runs
the compiled Daynight Server, compiled UniAuth and a local OAuth provider. The
compiled CLI and Playwright browser drive the system from the host through
loopback-only published ports. A run-local TLS gateway preserves Host for
`app.daynight.localhost`, `preview.daynight.localhost` and Task subdomains.
OpenSSL creates a temporary CA and certificate; the copied CLI trusts that CA
through `NODE_EXTRA_CA_CERTS` and the browser accepts it in its own context.
The Node test processes resolve those `.localhost` names to loopback; other
names use the system resolver. No system trust store is modified.

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
do not start a Worker process. A registered Worker's monitoring read returns an
absent observation through the real Redis-backed Server. Separately, a real
compiled Worker with no selected Projects reports to that Server and Redis; the
production Web reads the same Worker's observation, capacity and timestamps.
That Worker also keeps reporting while the Web sets a Chinese display alias,
reloads it, observes a later report without losing it, modifies it and explicitly
clears it. List/detail readback verifies the same stable Worker and machine IDs.
The journey starts no native agent and does not replace normal tool preflight. The same resource IDs and content cross the clients
and persist in the real database.

A second account signs in through the same authentication path using the local
provider. An ordinary Team administrator searches for that account in the Web,
adds its exact UUID and verifies the persisted member role through the CLI and a
Web reload.

A third account signs in through the same provider. A project invitation and
role edit establish the second account as an independent project administrator
outside the owner Team. That administrator directly adds the third account,
whose real login verifies project access; the owner Team roster remains unchanged.
Separate projects exercise direct addition by an inherited Team administrator
and a Personal project administrator. Each addition verifies the resulting
project grant through the real service.

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

The Worker patrol journey uses the compiled Worker and Controller against the
real Server and isolated PostgreSQL, with a controlled Codex protocol peer in
place of the upstream model. It retains the original claim, worktree and native
Session across Worker restart, verifies the resumed assignment and repeated idle
pings, and checks pause, resumption and claim-bound completion. The peer does not
establish autonomous behavior by a real model. On an explicit version-conflict
response to completion, the fixture reads the Task again and rechecks the original
active assignment and authorization before another attempt. It makes at most
three attempts; unknown responses and changed assignments fail the journey.

The tag journey reads empty catalogs in the Web catalog, shared child filter and
Task editor, then creates a shared catalog and independently tagged Goal and
child Tasks through the CLI. It reads a CLI-created color through MCP, associates
the same tag with the Goal and child, and checks their actual Web color markers
before and after a versioned MCP update and reload. An uncolored CLI creation
also verifies the server's default gray marker. It verifies toolbar order as
Assignee, Status, Tag filter and Child task tag filter. Web reads and edits the child's tags, uses the
shared toolbar condition to filter sibling Tasks and clears it to restore them;
CLI reads the saved set, renames and confirms deletion of a shared tag. Web
reloads and CLI readback verify current names, retained identities and association
cleanup on the same Goal and Task. Menus close before pointer navigation, and
filter conditions and search text are cleared between journey operations.

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

The separate provider navigation validation exercises controlled TLS and HTTP
stalls, CONNECT head handling and connection reuse with the real local provider
and Chromium. It is not part of the normal product journey or CI harness:

```bash
node --test packages/e2e_tests/validation/provider-navigation.test.mjs
```

## Results and cleanup

Each invocation prints a `.tmp/product-e2e/<run-id>` result directory. It retains
the source revision and fingerprint, binary and Web asset hashes, container
identities, Playwright result, failure screenshots/traces and runtime logs.
`results/auth-bootstrap.json` records bounded main-frame Document and action
stages for Console bootstrap. It freezes unresolved requests before browser
shutdown, so shutdown aborts do not replace the original failure boundary.
`logs/provider-diagnostics.json` records bounded CONNECT, TLS and provider HTTP
stages; a live snapshot survives an unconfirmed runtime shutdown, while a
completed snapshot marks a confirmed provider close. IDs are local to each
stream and do not associate browser requests with provider connections. Both
streams report truncation and retain only allowlisted origins and paths, methods,
status and restricted error codes, without query strings or credentials.
A diagnostic write failure fails the run and remains visible with any original
failure and cleanup errors.

Setup and execution have deadlines, readiness detects early service exit, and
failures propagate to the command exit status. Cleanup runs after success,
failure or cancellation. When ownership and stopping are confirmed, it removes
only the current run's containers, data volume, networks and runtime image, and
verifies their absence. After product processes stop, parent cleanup uses a tracked helper container
with no network to restore private mount ownership. This also works when the
application was forcibly terminated, so the host can remove nonempty attachment
trees. Private credentials,
auth SQLite data, attachment storage, certificates and copied build artifacts
are removed. A cleanup failure makes the run fail rather than producing a
successful result.

Recovery requires the exact recorded resource set and owner labels, including
Redis. Clean up runs created by an older runner with that runner before upgrading;
the current runner does not infer missing resource identities from old receipts.

Playwright and the patrol Worker start through gates whose process identities
are persisted before they can launch their targets. Test CLI and Git commands
have their own recorded process groups. Independent recovery
first verifies that the original runner has exited, then stops the recorded
groups and checks the Worker's original Controller and native process evidence.
Fixture credentials remain in a separate private, retained directory outside
uploaded results. Before Chromium starts, the fixture records a browser launch
intent and binds the original process-group leader's identity. Cleanup confirms
that recorded group has stopped, including after a failed Playwright run; a
missing or conflicting proof cannot establish browser shutdown. An interrupted
Worker or Test Session may leave detached helpers. If their original stop cannot
be proved, or build or environment setup has not reached a confirmed boundary,
recovery fails and retains the original state for inspection instead of reporting
cleanup success. A failed build that has joined all of its commands records the
build stop boundary and releases its own build lock while preserving the build
failure. Cancellation or an unconfirmed command keeps the lock and evidence.
Independent recovery serializes lock removal with recovery for the same run and
never removes another run's lock. Docker cleanup mutations record an intent
before dispatch. An unknown result keeps that intent and prevents automatic
replay or treating a temporarily absent resource as final absence.

The framework does not touch an existing deployment or use its database. A
passing local run establishes only the recorded source and scenarios; it does
not establish hosted CI or live third-party authentication behavior.
