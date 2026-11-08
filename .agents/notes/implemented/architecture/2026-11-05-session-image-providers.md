# Agent Note: Native image adapters require durable acceptance evidence

Status: implemented

## Problem

An image may be saved, echoed by an SDK, accepted as native input, and consumed
by a model at different times. Treating these observations as one success can
erase a draft after an unconfirmed delivery or replay an input after a timeout.
Provider history also has different identifiers, media encodings and buffering
costs, which cannot safely share a text-only projection shortcut.

## Decision

The adopted [provider design](../../../../docs/design/session-image-providers.md)
publishes separate native encoders and evidence matchers, with one shared
operation, occurrence and immutable-resource contract. This note records the
published design decision; native image implementation and runtime acceptance
remain pending.

Codex uses stable localImage files and request/client identity, Claude uses
ordered base64 sources and profile-proven root execution evidence, and Copilot
uses blob attachments and the original send Promise's durable messageId. An
unknown result retains the original operation and pins without replay. Model
consumption is verified separately from native acceptance.

History uses persistent source mappings and bounded provider-specific readers.
Copilot preserves an already-public native slot when an exact late receipt
arrives, then adds a separately labelled original-upload slot. Admission reserves
the worst-case metadata before dispatch. Codex owns a streaming native parser;
Copilot owns a single-connection SDK bridge; Claude owns a versioned transcript
reader and uses SDK isolation when its allocation bound requires it.

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
consistent, explainable rejection.

## Consequences

Each supported native version/backend/model must maintain payload, receipt,
history and resource-limit evidence. Bounded readers cost schema maintenance and
platform validation; RSS monitoring must not be described as hard isolation.
The shared journal remains the only durable identity owner.

The design deliberately preserves unresolved sends, even when a local echo looks
successful. A few Copilot late-response cases display two labelled image sources.
Codex native files retain resume pins until native deletion; service history can
remain readable while native-path recovery is unavailable. Image steer is a
separate profile, and Claude image steer remains unsupported.

Adding automatic transcoding, new input formats or cross-machine native path
repair requires new explicit contracts. Those additions must preserve original
bytes, occurrence identity and the distinction between historical read access
and authorization for a new send.
