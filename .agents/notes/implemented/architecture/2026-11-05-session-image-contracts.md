# Agent Note: Independent image protocol and durable originals

Status: implemented

## Problem

The strict native Session protocol accepts text input and its legacy resource
and archive limits cannot carry the promised image sizes without changing old
readers. A local path or external URL also cannot preserve historical content
when the Controller stops or the source changes. File writes, operation dispatch
and database commits have different failure boundaries; treating them as one
success can lose originals or replay an uncertain native input.

## Decision

The [unified Session media decision](2026-11-09-unified-session-media-core.md)
replaces the separate wire and compatibility-copy choices below. The original
publication rationale is retained as decision history; current production
contracts use one resource model and one archive representation.

The published [protocol and storage design](../../../../docs/design/session-image-contracts.md)
originally adopted a separate `daynight.session.images.v1` representation, immutable private
service originals and Controller files whose metadata and operation pins share
the execution journal. This implemented status originally recorded publication of that design. The
unified decision owns the current foundation and its remaining consumer scope.

The design separates occurrence, resource, upload and operation identities.
Complete upload means both full decoders agree and the service has durably
published the original and its owner reference. Native acceptance requires the
provider's exact oracle. Unknown dispatch retains its original identity and
pins, with observation instead of replay. The original design reserved logical image capacity, physical storage and both
complete archive representations before admission. The later [actual content
capacity decision](2026-11-13-session-actual-content-capacity.md) replaces
that reservation while retaining the identity and publication guarantees.

Service and Controller run the same packaged Node.js 24 and sharp/libvips
validation helper independently. The helper accepts only caller-owned file
snapshots through a strict bounded pipe protocol; it has no locator or network
authority. Full-frame validation and native allocation measurements are part of
its support profile. Rollback disables new writes while retaining readers,
originals, compatible journal handling and unknown-operation reconciliation.

## Alternatives

**Add optional fields to v1 or enlarge the legacy constants.** Old strict
parsers and welcome validation reject changed objects and limits. A separate
representation preserves existing text sessions and permits per-reader projection.

**Reuse v2 or require a simultaneous client upgrade.** v2 already owns Herdr
terminal and native snapshot wrapping. Reusing it would conflate independent
formats and require deployment coordination that compatible readers avoid.

**Keep Base64 in a larger archive JSON.** This retains a simple envelope but
amplifies whole-file copying and memory use. External originals preserve bounded
transfers while exact old and new metadata budgets protect compatibility.

**Store only Controller paths or fetch sources when archiving.** This uses less
service storage but cannot guarantee the original bytes after a source changes,
a Controller disappears or archival capacity runs out. Durable service storage
is therefore part of upload and capture success.

**Relay every byte without service staging.** Pulling the whole image back from
the Controller later saves temporary service space but adds transfer and leaves
final publication dependent on that connection. The normal path stages and
forwards once; `read_prepared` remains a same-identity recovery operation.

**Direct browser uploads or public signed URLs.** These can reduce relay load
but create a separate reachability, credential, revocation and ownership model.
The selected design keeps the existing Session authorization resolver.

**Read user files or hard-link native inputs.** Mutable sources and writable
native paths could alter historical or pending input bytes. Private verified
copies have an explicit storage cost and stable identity.

**Collect files by TTL or turn completion.** Neither fact proves that an unknown
operation, delayed read or native resume no longer needs its input. Evidence-based
pins can retain space longer and must reject new images when capacity is full.

**Deduplicate across accounts or Sessions.** Physical savings introduce content
existence leakage and coupled deletion. Reuse is restricted to one Session and
does not merge logical billing or authorization identities.

## Consequences

Two protocol projections, two independent validation executions, service staging,
private native copies and recoverable file/database transitions add storage and
operational cost. A leased worker's disappearance cannot free physical slots
without termination evidence, so capacity may remain occupied during uncertainty.

The [archive design](../../../../docs/design/session-image-archives.md),
[source design](../../../../docs/design/session-image-sources.md),
[provider design](../../../../docs/design/session-image-providers.md) and
[browser design](../../../../docs/design/session-image-browser.md) consume these
identities and durability guarantees. Their runtime validation remains separate
from publishing these documents. Reconsideration of general files, cross-device
drafts or native path migration must preserve immutable originals, opaque
permissions, exact identity and no replay of uncertain operations.
