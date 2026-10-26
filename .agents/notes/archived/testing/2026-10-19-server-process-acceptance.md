# Agent Note: Built-process Task Service Acceptance

Status: implemented

## Problem

In-process tests cannot establish that the built command assembles the intended
routes, owns its OS process, retains state across restart or stops database work
when signalled. Coverage alone also cannot prove competing HTTP mutations and
resource cleanup. A delivery needs evidence tied to its actual tested source.

## Decision

Test-only command-package files build a fresh race-enabled executable for each
test invocation and drive it over loopback HTTP against isolated PostgreSQL
schemas. They parse existing JSON readiness logs instead of adding a health
endpoint, test-only production API or alternate runtime. Package tests continue
to own store/service/server coverage. The
[installed project/task extension](2026-10-20-installed-project-task-acceptance.md)
reuses this fixture for public CLI workflows, restart and
version competition. It keeps CLI requirement identifiers in the `PT.V*` namespace and
uses a separately prepared installation without replacing the service scenarios.
Resource-budget probes run after the existing Go gate, outside its default
ten-minute test timer, while the Go CI job retains its 20-minute bound. The
[CI efficiency decision](2026-10-21-ci-validation-efficiency.md) defines short
test-only deadline values, unchanged real byte-limit probes and bounded parallel
scenario execution. Independent scenario subtests have at most four active
slots within their sequential top-level test. Each owns its schema, server
processes, database barriers and cleanup; top-level tests that modify process-wide
environment do not overlap them.

The original twelve service scenarios exercise persistence, refusal semantics, filtered pages,
three deterministic write races, partial-write rollback, request cancellation,
graceful/forced SIGTERM, migration failures and simultaneous process startup.
Exact child application names identify PostgreSQL waiters. A nontransactional
sequence verifies that changed metadata and the first dependency existed before
an injected write failure. This prevents a pre-write error from passing as
evidence of rollback.

Error assertions verify status, code and exact body/header request correlation.
Known secret markers and database URLs remain forbidden across the whole body.
The SQL diagnostic view masks only the direct error.requestId string after
validating unique, syntactically valid header correlation. All other original
JSON bytes, including unknown members and keys, remain subject to the scan.
This treats an opaque ID as metadata without exempting diagnostic fields; the
[metadata decision](../bug-fix/2026-10-21-http-error-acceptance-metadata.md)
records the false-positive mechanism and rejected alternatives.

Only owned children are stopped or killed, then waited for. Row locks are
released before cleanup waits; child sessions must disappear before isolated
schemas are dropped. Build directories are removed after execution. Cleanup is
part of each scenario's pass/fail result, not an assumed final action.

The incremental JSON receipt records Git/GitHub revision, required gitTreeSha
from actual `git rev-parse HEAD^{tree}`, dirty state, compiler and database
versions, tested binary hash, named results and cleanup counts. The packed CLI's
source tree must match the service receipt alongside existing artifact checks.
The [lifecycle cross-layer extension](../../implemented/testing/2026-10-22-task-lifecycle-cross-layer-acceptance.md)
adds genuine historical-SQL startup/restart and competing installed-process
proof using these same fixture and cleanup owners; deterministic package-level
interleavings remain separate. CI requires a clean checkout matching its supplied
GitHub SHA. The Go job
uploads that receipt and the exact raw profile after validation, including on
failure. The [server README](../../../../packages/daynight-server/README.md)
owns requirement mapping and receipt interpretation. Observed results belong to
the tested revision's PR and CI run under the
[validation evidence decision](../process/2026-10-20-source-bound-validation-evidence.md).

## Alternatives

**Call the command's run function for all acceptance.** Those tests exercise
composition but cannot prove an executable's actual signal, exit, listener reuse
and restart behavior. Existing in-process tests remain useful, while the binary
scenarios provide separate caller-visible evidence.

**Reuse an already-built executable.** A stale binary could pass while the
current checkout is wrong. Building once per invocation and recording its hash
and source identity makes the artifact attributable.

**Use HTTP 500 alone as rollback proof.** A failure before the first mutation
would satisfy that assertion. A database-side sequence after verified partial
mutation supplies an observable, non-rolled-back barrier.

**Replace package tests with end-to-end coverage.** The selected tool does not
credit cross-package calls to their owning packages. Real package tests retain
coverage and precise interleaving proofs; binary tests supplement them.

## Consequences

The complete validation command now proves both the module's strict `>90%`
statement gate and actual process behavior. Controlled unavailable-database
validation still fails; positive and negative receipts are retained separately
so a negative control cannot masquerade as the successful acceptance artifact.

The suite targets the Ubuntu Go CI job for process signals. The
[module-scoped CI decision](../process/2026-10-21-module-scoped-pr-ci.md) controls
which PR jobs run; selected jobs retain their full workloads, and main pushes
retain every native CLI job. The suite creates no production helpers, service
interfaces or coverage exclusions.
