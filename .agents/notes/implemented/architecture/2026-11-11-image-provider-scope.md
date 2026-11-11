# Agent Note: Image delivery targets Codex and Copilot

Status: implemented

## Problem

An image capability cannot claim native permission equivalence when its adapter
cannot observe all effective restrictions. The original three-provider image
target required Claude support even though its tested Read checker omits
effective hook and module constraints. Neither a partial module listing nor an
unknown image qualification proves that a source read or input is permitted.

## Decision

Current image requirements and acceptance target Codex and Copilot. This
partially supersedes the original [provider](2026-11-05-session-image-providers.md),
[source](2026-11-05-session-image-sources.md) and
[native authority](2026-11-10-single-checkpoint-native-read-authority.md) decisions.
Those designs originally included three providers to offer the same image
workflow across existing native integrations. Their shared storage, occurrence,
permission and immutable-history guarantees continue to apply.

Claude image delivery is outside the current scope. Its existing adapter,
protocol identity and history support remain; unknown image input qualification
refuses input, and local Markdown source capture returns `policy_restricted`
without reading the source or requesting image approval. Already saved originals
remain readable under current Daynight access checks.

The provider-independent checkpoint interface, accepted-input association and
immutable resource model stay extensible. A future Claude adapter must consume
complete effective native decisions and prove their association with the held
source. It cannot substitute settings mirrors, disable hooks or widen native
permissions. External egress validation and supported-platform evidence remain
required for the current providers.

## Alternatives

**Retain Claude as a current delivery requirement.** This preserves the original
provider matrix, but requires an effective native permission producer that the
examined interfaces do not provide. Further repeated probes or broader operator
authorization cannot manufacture the missing facts.

**Remove existing Claude integration.** Scope exclusion does not require deleting
working text, history or compatibility behavior. Removing those paths would
expand the change and disrupt existing sessions without proving image safety.

## Consequences

Claude does not block current image acceptance, and passing Codex or Copilot
evidence never qualifies Claude. This defers a capability, not the native
permission guarantee. Adding it later may require new native interfaces,
version-specific adapters, object-association validation and cancellation tests;
its cost is not known to be a small adapter addition. No existing delivery task
implicitly inherits that work. Reconsideration requires a new scope decision
and actual evidence for the proposed profile.
