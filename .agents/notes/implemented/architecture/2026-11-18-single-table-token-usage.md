# Agent Note: Single-table token usage

Status: implemented

## Problem

Task execution state cannot establish how many model tokens were consumed.
Retries, native recovery and cumulative snapshots can count the same work more
than once, while missing native data can look indistinguishable from a genuine
zero. Reporting can also arrive after an execution finishes, without being
authorized to modify its successor.
The current Session snapshot also advances on reconnect, so it cannot prove
every field of the original usage registration, parent credential or stopped
generation. Effective coverage can change on revocation or expiry without a
usage row update, so stored row versions alone cannot establish a consistent
execution-state page. Usage authorization must also share the account and
Session lock order of existing registration operations; opposite orders turn
valid concurrent requests into a database deadlock.

## Decision

The [usage contract](../../../../docs/spec/task-token-usage.md) separates
execution coverage from native measurements in one `usage_records` table.
Existing Sessions remain the execution authority. Native source identity spans
Controller generations, and measurements retain their originating execution
state. Source revisions replace facts rather than adding transmission attempts.

The [backend design](../../../../docs/design/task-token-usage.md) uses independent
bounded usage grants and HTTP acknowledgements. Late reporting retains the
original authorization window; it does not acquire a claim or extend authority
to a new execution. SQL aggregates current counted facts, preserving decimal
precision and explicit unknowns. Read-time coverage includes unregistered
executions and expired collectors.

Coverage fixes the existing Session scope once and uses predicate-matched
partial indexes for known measurements and attribution gaps. Sessions without
measurements remain in the result. It reads only state identity and coverage
fields; API records keep their independent complete projection. Each state's
original parent credential remains its authorization source, and confirmed
generation transitions preserve stopped collectors' gaps without revoking
their valid late-report windows.
State-inclusive page revisions include the effective state and reasons at one
operation clock in the same read snapshot, not the clock value itself.
Batch summary validators include ordered Task IDs alongside the item summary
hashes and permission token. Equal usage values do not identify the selected
Tasks or their requested order, so summary hashes alone cannot validate a batch.
Authorization locks the original PAT and account before the Session, matching
the existing Test registration ordering and retaining the account-deletion
barrier.

The private grant hash record combines a versioned token hash with an immutable
registration-identity digest. Rotation preserves that digest, allowing exact
registration replay checks after the live Session connection advances. This
uses the existing opaque `bytea` field without exposing authentication metadata
or adding an authorization table.

Native profiles choose a single evidenced measurement plane. Copilot exposes
partial output, Claude exposes partial root-message input, and Codex cumulative
snapshots do not enter the counted plane. Current Chain and Goal membership
provides views over the same ledger, not another accounting store.

Web usage reads remain separate from Task synchronization. Cards share bounded
batch summaries, while Detail reads execution and measurement pages with their
own snapshot tokens. Decimal strings stay exact through formatting with BigInt.
Unknown totals retain their metric labels and coverage instead of being inferred
from available input or output. The usage tab uses the existing Detail route and
retained panels, preserving unrelated reading and drafts through pagination resets.
Chain and Goal views consume server aggregates and their missing-member cursors
directly. Current graph filters never redefine accounting membership; the UI
shows known coverage and unknown members independently of completeness categories.

Controller journal format 019 keeps usage source identities, grants and pending
events separate from timeline acknowledgements. Copilot's live immutable event
plane enters this journal before history buffering; only the exact advertised
SDK/runtime qualification permits measurement uploads. A bounded HTTP uploader
checks complete per-event receipts before deletion. Stopped Worker maintenance
uses the original journal and retained grant without reopening native execution,
and runs independently of history archiving. Standalone Test shutdown and its
archive retry use the same bounded original-journal replay after local stop
proof, independently of server stop receipts and history upload outcomes.
Retryable usage keeps an archive retry entry even when history succeeds.
Retained evidence without a valid original grant, or only quarantined conflicts,
reports a usage limitation without turning successful history archival into a
permanent failure. Retry advice uses the uploader's current event-kind filter:
known unqualified measurements alone cannot become a retryable batch, while a
transient capability lookup failure remains distinguishable. Its pending
evidence count remains unchanged for retention. State events must match the
complete current capability before joining a batch. A qualification or other
capability change excludes incompatible state bodies only from the current
batch, without rewriting, quarantining or acknowledging them. Selection is
reevaluated after each capability read: restoring the original capability with
a valid original grant allows the original final seal to upload. Eligible
measurements receive independent ACKs, and filtering precedes the batch limit
so retained states cannot starve delivery.
Pending or quarantined measurements
and unresolved local source-conflict evidence retain their sole journal during
explicit and automatic recording discard. Local conflicts have no uploadable
event; acknowledging the accepted measurement and partial state cannot resolve
or delete that evidence even after the outbox becomes empty.

Controller metering admits Task claim tickets and explicitly identified
standalone Test tickets before creating any Provider's usage runtime. The
standalone launcher writes usageScope=standalone_test on fresh and resumed
tickets; the optional field is restricted to testExecutionId tickets without a
Bot recovery binding. Bot and Test tickets otherwise share the same identity
kind, and retained Bot tickets can lack recovery bindings. Legacy ambiguous
tickets therefore continue native execution without collecting usage.
Standalone Test resume creates a new, identified execution; immutable retained
tickets are not rewritten to infer a purpose they never recorded. This admits
local collection only. The existing server rejects a native anchor already
registered to another Test Session with source_conflict. The resumed native
execution continues, but cannot obtain a new usage grant or move old sources.
Cross-Test usage recovery requires a server-verifiable resume relationship;
sharing a native ID alone cannot authorize it.

Provider identity is fixed at journal state admission and checked across recovery.
The uploader selects the fixed profile by that identity and the state's admitted
profile. The original Codex snapshot profile registers unsupported coverage;
stopped replay preserves this result instead of treating absent tokens as failure.
The [response usage decision](../feature/2026-11-23-codex-response-token-usage.md)
adds a separate response plane originally tested on Codex 0.169.0, retaining old
state semantics. The
[version admission decision](../simplification/2026-11-25-usage-default-enabled-codex-version-admission.md)
enables usage writes by default in environment assembly and removes the Codex
exact binary gate and per-version deployment requirement. New response states
use the actual valid semver handshake and matching rollout metadata; missing or
invalid versions cannot establish their identity. The original tested version
remains evidence for that runtime, not E2E certification of later versions.
Other providers retain exact deployment qualification.

Claude admits immutable root-message input only when the actual SDK, CLI and
Anthropic backend are known, retaining that combination in providerVersion.
The actual SDK initialization result must identify apiProvider=firstParty,
in addition to consistent backend and endpoint checks at the spawn, native
global environment, resolved settings, and final flag-merged stages. A flag
cannot erase a managed settings endpoint difference to acquire qualification. The native legacy/current global configuration selection
is inspected for its env projection; unrelated fields are neither transmitted
nor retained. Indeterminate, unreadable or malformed global configuration stays
unknown. Host credential-file environment injection and custom OAuth endpoint
selection also stay unknown without reading credential files. A nonempty
ANTHROPIC_UNIX_SOCKET in the actual spawn or effective settings/flag environment
prevents Anthropic qualification even with the official base URL and firstParty
readback: the socket changes model request routing independently of those
values. Socket paths such as `0` and `false` are not disabled boolean selectors.
WIF profiles can supply an independent base_url, including through the native
default profile. Actual and merged environments resolve that selected profile
when no explicit official base URL overrides it; nonofficial, unreadable or
indeterminate configuration remains unknown. This reads endpoint configuration
without reading credential files or executing configuration helpers.
Mantle and
the separate Anthropic AWS and Google Cloud providers cannot inherit the
Anthropic profile merely because older environment selectors are absent.
Windows environment keys are compared without case; ambiguous duplicate
spellings cannot establish first-party endpoint provenance. Only
the provider discriminator crosses the profile channel; account details stay
native-private. Process proof and version probing do not wait for native
initialization. A pending profile cannot establish a usage identity; the final
backend is published before returning the original initialization result. This
keeps the existing native startup deadline independent of usage qualification. Unknown backends never lend their values to the Anthropic plane.
Missing
profile evidence cannot create a temporary identity that would later conflict
with the same generation. Transcript rows lack original version provenance, so
recovery replays retained ledger facts instead of requalifying historical rows
with the current executable. Unsafe native integers become unknown per field,
retaining other known cache facts and an explicit precision gap.

Immutable Claude facts require native message completion. SDK 0.3.247 emits
assistant wrappers at content-block completion while their input usage can still
change in later message deltas. One bounded root stream retains only the native
message ID, model and input fields, applies explicit non-null delta corrections,
and commits at message_stop after a terminal stop_reason. Unfinished streams are
discarded with a recovery gap on replacement, interruption, result, disconnect
or shutdown; a child stream cannot terminate its parent. Complete non-streamed
wrappers require their own terminal stop_reason and no aborted/error marker.
A complete new-ID wrapper retires an unfinished stream with a recovery gap;
the CLI consumes its streaming-fallback marker internally and cannot emit a
tombstone when the failed stream produced no completed block. Same-ID wrappers
cannot finalize a pending stream.
Local-command wrappers use the synthetic model sentinel without a model call.
They are excluded by both collector and mapper before retiring pending native
input, preserving no measurement instead of manufacturing a zero-valued fact.

CLI 2.1.247 can replace a message's model during server refusal fallback without
changing its native ID, while filtering the internal fallback block from public
stream events. A root model_refusal_fallback notice or a fallback_message in
delta usage.iterations therefore invalidates the initial model's attribution.
Collection discards and suppresses that message through subsequent deltas, stop
and complete wrappers, recording a recovery gap until a new message_start.
Explicitly local or child-agent notices leave the unrelated root stream intact.
Client refusal fallback also synthesizes a refusal delta and stop before its
public fallback notice. Refusal closures and wrappers therefore record a gap
and suppress the old message immediately, including when no notice arrives.

## Alternatives

**Relaxing native anchor ownership for independently resumed Tests.** Resume
creates a new platform Session by product contract. Reusing the old Session
would change that contract, while accepting the same native ID across Sessions
without verified provenance would widen grant and source ownership. The
existing explicit registration refusal remains; cross-Test metering requires
a separate provenance design rather than a Provider-local identity rewrite.

**Recognizing Bots only by their recovery bindings.** These fields are absent
from some retained Bot tickets, and the launcher can reuse those tickets
directly. A botId added only to new tickets would leave the same ambiguity.
Positive standalone Test provenance protects the existing Task/Test-only scope
for all Providers without reconstructing Bot history or changing Bot recovery.

**Disabling all testExecutionId collection.** This would exclude standalone
Tests together with Bots. An explicit local ticket marker preserves newly
launched Test collection and identifies resumed tickets without bypassing
server registration authority; the deliberate cost is no new
usage from legacy ambiguous tickets until a classified execution is created.

**Committing each completed Claude content block.** A completed text or tool
block is useful timeline evidence, which originally made its assistant wrapper
look sufficient for input accounting. Its null stop_reason and mutable native
usage do not establish an immutable input fact. Waiting for the native message
stop preserves the source identity and final corrections without inventing
local revisions or summing pipeline results.

**Attributing fallback usage to the message_start model.** Stable message ID
does not imply a stable model: server fallback can update the native message
in place. Guessing a split or trusting its initial model would assign input to
the wrong model. Suppressing an ambiguous source preserves honest partial
coverage and avoids an irreversible immutable attribution.

**Waiting for a public refusal-fallback notice before suppressing usage.** The
CLI's synthetic refusal close can precede that notice, so provisional zeroes
would already be immutable by the time suppression runs. Excluding refusal
closures preserves the existing bounded collector and normal message-stop
latency, at the cost of also excluding genuine refusals that cannot be
distinguished from synthetic ones through the public SDK stream.

**Measurements without execution coverage.** This cannot distinguish a complete
empty execution from an unregistered or failed collector. A state row in the
same table preserves the distinction without introducing a second Session.

**Summing cumulative snapshots or taking their maximum.** Arrival order and
local revisions do not establish native authority, and context estimates are
not consumption. This would produce precise-looking but unprovable totals.
Partial evidenced facts retain useful measurements without inventing coverage.

**Reusing Session cumulative acknowledgements.** A timeline acknowledgement
does not prove a usage batch was persisted and can discard unrelated pending
measurements. Independent acknowledgements keep delivery identities separate.

**Relying on the live Session snapshot for registration replay.** Reconnect
replaces the connection epoch, losing the original comparison value. Separate
identity columns would widen the storage schema for equality-only evidence;
a private hash envelope retains that evidence and independently rotatable
token hashes in the existing credential field.

**Using the latest Session credential and lifecycle for every state.**
Reconnect can replace the PAT, and recovery can leave the Session active under
a new generation. Applying those facts to older states hides revoked original
credentials and stopped collectors. Per-state authorization and generation
context preserve the original source's bounds and coverage gaps.

**Using only stored row versions for execution-state page revisions.**
Pause, revocation and natural grant expiry can alter the visible projection
without changing a usage row. Such cursors mix two effective states under one
snapshot token. The revision must also cover the effective projection, without
keeping a transaction open between requests or adding a snapshot table.

**Historical aggregate membership.** A financial point-in-time membership ledger
would require another stored history and product contract. Current distinct
members satisfy operational summaries, with deletion exclusions and observation
times made explicit.

**Unfiltered measurement probes and complete state rows for coverage.**
Per-Session existence checks without predicate-matched indexes inflated
PostgreSQL's estimated plan cost enough to trigger costly JIT compilation.
Decoding full ledger rows also transferred and allocated unused fields.
Selective indexes and a narrow state projection preserve the same semantics
without changing database settings or performance thresholds.

**Grouped measurement flags.** Grouping all active measurements added scans on
top of the totals query. These facts only require existence, so indexed probes
avoid materializing or regrouping the full measurement set.

The [unsigned pagination decision](../simplification/2026-11-20-unsigned-usage-pagination.md) changes the cursor format and startup dependency while preserving these read boundaries.

## Consequences

Only one business table is added, and usage does not change Task versions or
sorting. Unknown totals remain null; profile limitations are visible rather
than hidden behind estimated complete totals. Consumers must support partial
metrics, source conflicts and pagination resets.

Usage needs its own refresh and account-scoped lifetime because usage writes
deliberately leave Task versions unchanged. A successful Task refresh alone is
not evidence that its usage summary is current. Batching avoids per-card reads,
and independent paginated Detail queries bound the cost of opening large histories.

Late uploads remain bounded by the original grant and parent credential.
Losing the only token after an execution ends can leave an explicit data gap.
This is not a permanent import credential or a billing ledger. Broader native
profiles require new evidence and cannot reinterpret an already counted source
under another profile.
Copilot ephemeral events lost before durable ingress cannot be reconstructed;
this plane remains partial even after its queue drains. Separate local tables
require a journal migration, and old CLI builds cannot read the new format.
Pending conflict or expired-grant evidence can retain a journal until an explicit
retention policy resolves it; archive completion alone cannot justify deleting it.

Grant hash records have a strict versioned encoding. Malformed stored values
fail explicitly rather than weakening original-identity verification. Clients
never consume this private encoding; changing it requires compatible stored
record handling.

Coverage indexes add storage and write maintenance. Native revisions that alter
canonical metrics can also affect the known-measurement predicate; this cost
buys bounded existence checks instead of repeatedly scanning ledger history.

Coverage and state-inclusive page revisions depend on retained original
credentials and confirmed generation transitions, not only ledger mutations.
These reads remain batched; measurement-only pages do not acquire a time-based
reset merely because an unrelated collector's effective state changes.

Migration retention means rollback requires a binary that recognizes the usage
migration even when its feature is disabled. Removing migration history or the
table is not a compatible rollback.
