# Agent Note: Codex Reporting Probe Ownership

Status: implemented

## Problem

The optional assistant-host collector and ordinary telemetry collector can both
probe Codex through the same native PATH. Independent cleanup-failure state lets
one collector start replacement probes after the other loses confirmation of
process cleanup. A cached ordinary success can also hide that uncertainty.

The [assistant observation decision](../architecture/2026-11-04-worker-assistant-host-observations.md)
keeps assistant reporting optional and preserves per-collector failures. Those
local refusals alone do not protect a composed observer of the same invocation.

## Decision

A telemetry-owned Codex probe owner is passed to the optional assistant
collector. It serializes matching ordinary version observations and whole
assistant version/help chains, retaining the first typed cleanup failure as its
original private error object. The ordinary version cache is read inside that
owner. Waiting calls join the preceding chain and check cancellation before
starting a command. A standalone assistant collector keeps its own owner.

Matching uses the existing Codex PATH invocation: executable name `codex`, the
same captured startup directory, PATH and, on Windows, PATHEXT. Each collector
captures a dedicated bare Codex environment before execution. On Windows it
retains Node's alphabetically first case-insensitive PATH/PATHEXT value, removes
other spellings, and uses one uppercase key. Both launcher and owner receive
that environment. This preserves Node's native executable search selection and
makes the locked launcher's shebang selection agree with ownership comparison.
Other environment keys, providers and explicit executable paths keep their
original values. The assistant's existing real-directory validation supplies its execution directory while its
captured startup directory identifies the shared source. This is shared
invocation provenance, not arbitrary executable-file identity. No additional
filesystem lookup or resolver is introduced. Different search inputs and
explicit executable paths remain independent; Copilot's ordinary PATH probe and
bundled assistant executable are deliberately outside this owner.

The [reporting requirements](../../../../docs/spec/daynight-worker-reporting.md)
and [collection design](../../../../docs/design/daynight-worker-reporting.md)
own acceptance and lifecycle details. Runtime activation, report schema,
dependencies and CLI version retain their existing owners.

## Alternatives

**Keep separate barriers and copy failures after collection.** A second collector
can start its chain before the first returns. Updating state after both finish
cannot prevent those replacement commands or an intervening cached success.

**Add a global tool-name barrier or resolve every executable file.** A global
barrier would disable unrelated executables without evidence that they share
ownership. Additional resolution would introduce filesystem work and native
search policy solely for this refusal. The delivered default Codex resolvers
already share the invocation inputs; that narrower proof covers the supported
composition without claiming path aliases or arbitrary binaries are identical.

**Change only the owner's Windows key selection or reject duplicate keys.**
The locked launcher selects the last PATH spelling for shebang wrappers, while
Node native startup selects the alphabetically first. Choosing either only in
the owner would leave the other branch inconsistent. Rejecting duplicates would
refuse an input that Node already accepts deterministically. Capturing Node's
selected search values once for both launch and comparison removes the ambiguity
without new executable lookup or refusal.

## Consequences

Either collector's typed cleanup failure blocks later matching commands and
remains visible to reporter shutdown after owned probes join. Other providers
and nonmatching invocation inputs remain observable. Windows duplicate search-key
aliases cannot select one shebang script while the owner classifies another;
native launches retain their previous Node environment selection. Matching Codex
commands share their collection deadlines while waiting, so contention can yield timeout
without starting another command. Ordinary command failures remain retryable.

The owner lives only in this telemetry composition. It does not coordinate
independent reporters, task execution, arbitrary executable aliases, or
unrelated native providers. Assistant reporting remains disconnected in the
default runtime until hosting is integrated.
