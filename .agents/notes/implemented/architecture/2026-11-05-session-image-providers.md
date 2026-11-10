# Agent Note: Native image adapters require durable acceptance evidence

Status: implemented

## Problem

An image may be saved, echoed by an SDK, accepted as native input, and consumed
by a model at different times. Treating these observations as one success can
erase a draft after an unconfirmed delivery or replay an input after a timeout.
Provider history also has different identifiers, media encodings and buffering
costs, which cannot safely share a text-only projection shortcut.

## Decision

The original design covered all three adapters. The later
[provider scope decision](2026-11-11-image-provider-scope.md) limits current image
delivery and acceptance to Codex and Copilot. Existing Claude adapters and
history remain compatible, and unknown image qualification still refuses input.

The adopted [provider design](../../../../docs/design/session-image-providers.md)
uses separate native encoders and evidence matchers, with one shared operation,
occurrence and immutable-resource contract. The original decision established
these boundaries before native implementation. The adapters now connect them
through the existing Controller journal and media owner; production qualification
still requires the exact backend, model and platform evidence.

Codex uses stable localImage files and request/client identity, Claude uses
ordered base64 sources and profile-proven root execution evidence, and Copilot
uses blob attachments and the original send Promise's durable messageId. An
unknown result retains the original operation and pins without replay. Model
consumption is verified separately from native acceptance.

Codex preserves Markdown eligibility for a single trusted text block alongside
native images in accepted input and history. Completion still requires native
terminal evidence or the durable input intent. Multiple text blocks remain
unmapped rather than being joined into a new source body. The text part and
native image slots keep their identities and acceptance receipts; the presence
of an image does not make an otherwise trusted Markdown body plain text.

History uses persistent source mappings and bounded provider-specific readers.
Copilot preserves an already-public native slot when an exact late receipt
arrives, then adds a separately labelled original-upload slot. Admission reserves
the worst-case metadata before dispatch. Codex owns a streaming native parser;
Copilot owns a single-connection SDK bridge; Claude owns a versioned transcript
reader and uses SDK isolation when its allocation bound requires it.

Media extraction preserves native command and text semantics. A discovered Codex
skill supplies input even without text arguments; this does not permit empty
ordinary messages. Claude history retains assistant failure evidence through
indexing and paging so reopening cannot turn a failed request into acceptance.
Known tool-result text is bounded before metadata accounting while the scanner
still validates its discarded tail. Unknown fields retain the metadata ceiling.
An SDK FileReadOutput image can share a transfer with its exact content-block
mirror; similar bytes or an unrecognized structured field do not establish that
relationship.

Claude's persisted Read result uses `toolUseResult`, while the live SDK exposes
`tool_use_result`. The transcript scanner verifies a persisted mirror with a
bounded logical-string signature and the complete native record's schema before
discarding the redundant bytes. It retains the authoritative content block's
offset, occurrence and failure state. Unknown or unmatched copies remain subject
to the original metadata budget. This comparison only identifies a documented
copy within one record; it cannot establish input acceptance or merge distinct
image occurrences.

## Alternatives

**Send paths or Markdown through text.** This would avoid native encoders but
would not establish native image input, preserve the intended attachment order,
or share its authorization and lifetime guarantees.

**Use Codex data URLs or Copilot file attachments as transparent fallbacks.**
Data URLs amplify a 20 MiB payload to roughly 26.67 MiB; file attachments add
native delayed-path and resume dependencies. Each could be reconsidered with a
separate validated profile, not as an invisible retry after failure.

**Confirm an SDK echo or match text, hash, time or the only pending request.**
Hooks can block a materialized Claude input, and repeated identical content can
represent distinct operations. Only explicit native correlation can settle the
original unknown result.

**Replace a public Copilot slot after late correlation.** This changes published
image identity and may replace native-transformed bytes with different originals.
Keeping both labelled sources preserves public history and original uploads.

**Increase whole-frame or full-history thresholds.** Checks after aggregation
do not bound the allocation that already happened. SDK pagination may itself
follow full-file loading; item counts also do not bound bytes. Streaming or
isolated readers therefore carry explicit frame, queue and process budgets.

**Infer vision support from model names or missing negative flags.** Unknown
backend, limits or cumulative context may reject otherwise small images. Exact
profiles and conservative proven geometry envelopes trade availability for
consistent, explainable rejection. Matching SDK and CLI versions to a published
model name also proves neither native acceptance nor the geometry of the actual
backend and platform; public vision limits cannot substitute for qualification.

## Consequences

Each supported native version/backend/model must maintain payload, receipt,
history and resource-limit evidence. Bounded readers cost schema maintenance and
platform validation; RSS monitoring must not be described as hard isolation.
The shared journal remains the only durable identity owner.

Copilot retains its accepted native identity separately from publication. The
shared [content commit owner](2026-11-10-atomic-content-publication.md) publishes
aliases, original references, occurrences, the actual entry revision and outbox
sequence together. The original implementation persisted a recoverable plan
before separate timeline and occurrence writes; that preserved recovery facts
but could not meet the atomic requirement. Immutable candidate files and a
SQLite commit pointer now govern every content reader. The Provider adopts the
current committed view rather than replaying an older entry draft.

Provider aliases, cursors and occurrence state use the existing bounded metadata
store. Wire spools charge actual bytes to the shared media ledger and retain their
charge until readers stop and removal is durable. Transcript index writers retain
a process-bound reservation across crashes; recovery must prove that the original
writer stopped before admitting another writer. None of these private adapters
creates an independent upload or public resource protocol.

An image modality in a model catalog does not prove geometry. Codex binds the
actual thread backend before applying a profile; Copilot combines its model
catalog limits with an explicitly verified geometry profile. Claude observes the
SDK-selected executable and effective backend settings rather than assuming a
fixed JavaScript entry point or trusting the parent's environment alone. These
identity observations do not establish qualification. No Claude image profile
currently has the required evidence, so production send support and geometry
remain unknown, with empty media types and zero image limits. Native model
readback updates identity without granting image admission; the adapter rejects
images before file verification or native submission. Unknown geometry or backend
identity keeps image input unavailable, even when a direct native probe can
describe a small image. Controlled profile injection belongs to tests and cannot
widen production capability.

The design deliberately preserves unresolved sends, even when a local echo looks
successful. A few Copilot late-response cases display two labelled image sources.
Codex native files retain resume pins until native deletion; service history can
remain readable while native-path recovery is unavailable. Image steer is a
separate profile, and Claude image steer remains unsupported.

Adding automatic transcoding, new input formats or cross-machine native path
repair requires new explicit contracts. Those additions must preserve original
bytes, occurrence identity and the distinction between historical read access
and authorization for a new send.
