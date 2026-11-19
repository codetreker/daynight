# Agent Note: Independent Controller tool binding

Status: implemented

## Problem

Standalone Test Sessions launched Codex and Copilot without a frozen executable
recipe. A successful process start therefore lacked the verified artifact
identity consumed by image runtime observation. Re-reading PATH during a later
launch could also select a different installation without a retained comparison.
Worker-owned selection state cannot establish which tool an independent execution
actually starts.

## Decision

The independent launcher uses the platform
[tool resolver](../architecture/2026-11-11-worker-tool-path-resolution.md) before
Test Session registration. It freezes Codex's captured PATH selection and Windows
Copilot's bundled direct native executable into the existing inline ticket field.
The resolver hashes real artifacts and validates their mappings; the Provider's
existing verification remains the final check before spawn. No Worker target,
claim, selection manager or model probe participates.

Resume first verifies an original inline or ticket-bound sidecar selection and
copies that recipe into the new ticket. A changed or damaged binding fails rather
than authorizing a replacement. A legacy ticket without any binding remains
unchanged: the new execution resolves its current standalone tool and records its
first recipe. This proves only the new launch. Native identity, home, arguments
and the absence of a model override retain their existing resume semantics.

Copilot on non-Windows platforms or requiring materialization retains the
Provider's existing read-authority preparation. Passing it a plain recipe would
suppress that preparation without owning the required runtime or its cleanup.
Existing materialized selections, when present, still undergo verification
against the original trusted runtime root. Claude keeps its existing launch path.
The [Test Session specification](../../../../docs/spec/controller-test-sessions.md)
owns the resulting behavior and platform boundaries.

## Alternatives

**Write a sidecar for the old independent launch.** The Worker sidecar writer
requires its instance lock and proof that the original launch was never submitted.
An already executed standalone ticket cannot satisfy that ownership contract.
Inline binding in the newly created ticket preserves immutable old evidence and
uses the existing runtime reader without another publication protocol.

**Use the full Worker selection runtime.** That runtime owns cloud/local targets,
materialization admission, probe cleanup and active selection inventories. An
independent Test Session owns none of those resources. Reusing the lower resolver
provides artifact verification without taking over Worker lifecycle state.

**Pass plain recipes to every Copilot platform.** The Provider skips legacy
authority preparation when a frozen recipe is supplied. Supporting materialized
standalone runtimes requires an independent private root, mutual exclusion,
bounded extraction cleanup and dependencies retained across resume. Keeping the
existing path preserves read-authority guarantees without borrowing a Worker
lock. Full platform binding can be added through that explicit ownership model;
the ticket already accepts the complete recipe, so this decision adds no new
stored format to migrate.

**Reject all unbound legacy resumes.** Old Test Sessions have valid native and
stopped-process identities despite lacking executable provenance. First binding
in the new execution preserves that supported continuation without inventing
historical evidence. Existing bindings never use this compatibility path.

## Consequences

Supported standalone starts expose verified tool identities before native image
observation, while selection failures avoid Session registration and credential
side effects. Legacy continuation remains available with an explicit provenance
limit. The same operation deadline and cancellation bound resolution, and failure
still releases a resume lease only under the existing never-started cleanup rule.

This does not enable image profiles or establish visual correctness. Non-Windows
Copilot's additional binding remains outside this implementation; its existing
authority path is retained. Future materialization work must keep runtime
ownership independent and preserve frozen artifacts needed by later resumes.
Tests separate real artifact and ticket I/O from controlled launcher wiring and
do not treat fixtures as native qualification evidence.
