# Agent Note: Reuse HTTP Fixtures Without Repeating Their Business Proofs

Status: implemented

## Problem

Project creation input and response contracts were exercised in both the root
HTTP package and the Project route package. Each copy prepared a PostgreSQL
schema and an authenticated identity. Native and terminal Session fixtures also
created a second complete application after using the first one to create their
domain state. The replacement application repeated composition even when the
same authentication, borrowed database and live relay could serve the scenario.

Other avoidable fixture work included replay, collision and snapshot-decoding
assertions in every Test Session setup, and an additional 64 MiB input string for
an archive reader-limit test. Removing those costs must retain the actual HTTP,
database, relay, encoding and cleanup observations.

## Decision

The Project route package owns the complete creation-body matrix, exact response
fields and UTC timestamps, uppercase resource lookup, empty-page shape and safe
request diagnostics. Its existing authenticated route fixtures also verify that
all rejected creation requests leave the original project list unchanged. The
root package retains a small authenticated production-mux witness for Project
listing and creation, including the SCP repository spelling and resource
Location. This extends the existing
[HTTP scenario ownership decision](2026-11-06-server-http-proof-owners.md).

Ordinary native and terminal Session fixtures retain the first authenticated
production application for domain setup, HTTP requests and WebSocket traffic.
Their configuration and declared server origin come from that actual fixture.
The foreign-relay test still creates a separate application with the same
configuration, so it observes process-local relay ownership rather than an
origin mismatch.

The HTTPS Cookie/Origin regression keeps its HTTPS authentication configuration
and `__Host-daynight_session` credential. The browser-ping regression keeps its
focused production adapter and 100 ms interval. These two scenarios require
different application configuration or route assembly; they stop the preparation
application before exercising their dedicated adapter. Application shutdown
continues to precede release of borrowed database and file resources, using the
existing explicit cleanup expectations.

Test Session fixture creation performs only registration, grant, connection and
synchronization. The existing untouched-execution stop test owns registration
replay, changed-provider collision and initial snapshot decoding for both `none`
and `prompt`, in its existing schema. Thus unrelated control and lifecycle tests
do not repeat those baseline assertions, and no additional schema is needed.

The archive reader-limit test generates exactly 64 MiB plus one byte through a
bounded repeating reader. It still exercises the real body reader and byte
limit; it no longer allocates a second complete input string.

## Alternatives

**Keep both complete Project suites and reconstruct every Session application.**
That retains the observations but repeats identity/database setup and application
composition. The moved Project assertions remain in the actual Project adapter;
the root witness retains production registration and authentication.

**Use the same loopback application for the HTTPS Cookie regression.** A loopback
HTTP origin selects a different cookie name and security configuration. Reuse
would change the boundary under test, so that case retains its HTTPS adapter.

**Reduce Task status, Steps-placement or page-budget matrices solely by case
count.** Those matrices already share their fixture, and their distinct wire
forms, no-op diagnostics and actual cursor envelopes remain meaningful adapter
proof. They remain intact rather than treating a smaller count as a runtime gain.

**Replace Session integration with mocks or reuse the fresh-process command
binary implicitly.** The first removes real transaction, relay and network
observations. The second changes a source-bound build/provenance contract and
would require an explicit producer/consumer identity design. Neither is needed
for local fixture reuse; those proofs retain their existing mechanisms.

## Consequences

Project input/document assertions have one domain owner, while production mux
assembly still has a root witness. Ordinary Session and terminal scenarios build
one complete application, retain real PostgreSQL and authentication, and keep
one live relay for HTTP and WebSocket observations. Dedicated HTTPS, ping and
foreign-relay cases retain their different configuration or process-local owner.

Reader limits and Test Session replay/collision behavior remain tested at their
actual boundaries. Mutable schema, credentials, storage and cleanup expectations
remain local to each test. These changes reduce redundant construction and
operations; source-bound measurements, rather than test counts or this decision,
establish package, complete-check or hosted-job improvements.
