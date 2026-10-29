# Agent Note: Target-owned Web acceptance

Status: implemented

## Problem

Complete production acceptance proves native Go and container execution together,
but its resource record and cleanup assume both targets exist. Reusing that
orchestrator for one target would either prepare unrelated resources or omit
checks implicitly. Separate hosts also cannot share the same installed directory
or use another host's process receipt as local recovery authority. Target
execution needs an explicit proof scope while complete delivery retains both
targets, fixed capacity and all failure and cleanup requirements.

## Decision

Acceptance declares `all`, `native` or `container`. The default `all` schedule
retains overlapping native/container preparation, native functional and combined
authentication before container permission, and native capacity after complete
container cleanup. A native run prepares its own Go/PostgreSQL/storage and
executes functional, combined authentication and capacity phases. A container
run prepares its installed CLI and uses the normal dev-ci source build and
callback without waiting for a native run. It has no native resource object.

The runner reuses the same production phase operations and validators. Scope
selection does not create empty successful phases. Each selected target requires
its exact inventory, combined authentication receipt and real resource cleanup;
a scoped pass is not complete delivery. The complete union remains 34 native
and 29 container browser results plus both combined journeys. Single-worker,
zero-retry, fixed inputs, repetitions, timing, geometry, screenshots, traces and
privacy rules retain their existing meaning. The [Web README](../../../../packages/daynight-web/README.md#production-browser-acceptance)
owns commands and receipt interpretation.

`evidence.mts` owns the top-level schema version and parent-header parser.
Runner creation, callback/recovery and combined database controls share that
source and compatible-target admission. Top-level evidence and recovery use
schema 4 with an explicit scope. Recovery validates that scope and visits only
its recorded resources and phase directories. Process/platform/start identity, exact Docker ownership, native
binary and storage identity, browser/profile markers, managed command groups
and bounded error-preserving cleanup remain mandatory. Older or ambiguous
receipts fail rather than acquiring guessed resource ownership. Capacity,
combined authentication and container-permission child formats keep their own
versions.

The shared installed-CLI fixture separates packing from private installation.
Ordinary complete acceptance keeps one source-packed installation shared by its
targets. An explicit target owns its installation and can consume verified
tarball bytes prepared elsewhere. The Web package manifest binds source
commit/tree/dirty state, package version, tarball SHA-256 and producer run/attempt.
The caller supplies expected producer identity independently; CI checks the
clean checkout and workflow run while permitting a successful earlier producer
attempt. Actual bytes and source/package identity are checked before copying
the tarball into the target's exclusive root. The existing installed receipt,
launcher, entry hash, process tracking and cleanup retain their local authority.

Portable completion data preserves target validation and contained artifact-relative
file references. It does not interpret a downloaded PID, Docker identity or
absolute path as a resource on the receiving host. Source and producer identity
do not replace actual target-local process, image, browser, file and cleanup
checks. The [quality isolation decision](../../implemented/testing/2026-10-26-web-quality-job-isolation.md)
owns independent quality work; the [cross-layer decision](../../implemented/testing/2026-10-22-task-lifecycle-cross-layer-acceptance.md)
owns installed-process and source-attribution proof.

## Alternatives

**Run the complete orchestrator separately for each desired target.** This
duplicates unrelated preparation and can report both targets when only one
was intended. Explicit scope binds execution, required inventory and recovery
to the same declared responsibility.

**Skip phases by substituting successful callbacks.** Empty phases would make
missing work indistinguishable from executed validation and retain resource
assumptions that do not hold for a standalone container.

**Transport an installed directory and receipt.** Its absolute paths, launcher,
Node executable and live process ownership belong to the producing host.
Transporting checked package bytes retains package identity while each target
establishes its own installation and cleanup.

**Pack independently and assume identical bytes.** Equal version and source do
not establish tarball byte equality. Prepared-package input permits reuse of
one concrete tarball without adding a reproducible-build assumption.

**Remove the complete local schedule.** Serializing all preparation would lose
its useful overlap, while overlapping browsers or capacity would change timing
conditions. The complete strategy remains explicit beside standalone targets.

## Consequences

Target resources, installed artifacts and cleanup have separate owners, and
portable results can express their strict union without pretending remote
resources are local. This adds explicit scope and package admission cases,
including rejection before target startup, while retaining one set of real
production operations and acceptance assertions.

Complete acceptance still costs both target journeys. Separate execution alone
does not establish a hosted speedup or a new timing allowance. Runtime results
remain tied to the tested source, workload, browser and environment.

The production Web build context admits product sources, shared session
protocol sources and the asset publisher. Its directory exceptions re-exclude
descendants before listing those inputs, so acceptance tooling does not become
a production image input through parent-directory matching. Full workspace
TypeScript and harness checks retain their complete development inputs outside
the image; the container still typechecks and builds its real product closure.
