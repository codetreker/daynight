# Agent Note: Frozen native selection for assistant creation

Status: implemented

## Problem

A name-only assistant request must remain independent of changing previews and
defaults. Explicit model and reasoning choices also need to reach the original
Worker without being overwritten by its native arguments. Remembering choices
before verified startup, or using completion order as preference order, can make
failed or older creations change subsequent defaults.

## Decision

The creation request retains only explicit overrides. Its fingerprint excludes
resolved defaults. The frozen configuration includes versioned selection sources
and typed effort, while old definitions preserve their original representation.
A Worker advertises support for this creation format separately from native
model discovery.

Native discovery runs before the short creation transaction. The transaction
first reconciles the original ID, then checks that the resolution inputs still
match before freezing the new definition. Holding credential locks across the
read-only broker request would conflict with the broker's independent credential
validation and would make native latency a database lock duration.

Model preferences belong to an owner, Worker and Provider; effort preferences
also belong to the effective model. Verified ready commits only explicit fields,
using independent creation-order watermarks in the same lifecycle transaction.
Unsupported historical choices may fall back, but cannot hide incompatible
current explicit configuration. The Worker alone maps the final typed choice
to native arguments and revalidates fresh execution.

The [assistant design](../../../../docs/design/assistant.md) owns the runtime
mechanism and the [specification](../../../../docs/spec/assistant.md) owns public
requirements. This extends the historical
[default resolution decision](../../archived/architecture/2026-11-04-bot-default-resolution.md),
whose original model-from-report restriction matched the creation fields then
available.

## Alternatives

**Query native capabilities inside creation locks.** This would preserve one
transactional read scope, but the independent broker credential transaction can
self-block and native probes can hold database locks for their full deadline.
Rechecking the inputs after discovery preserves short database ownership.

**Store the preview as the original request.** This would make name-only replay
depend on a changing default and would falsely record defaults as user choices.
The explicit request and resolved configuration remain separate.

## Consequences

Ordinary name-only creation has no additional catalog query when no native
selection preference needs validation. Adjusted creation may fail on stale
configuration or unavailable native discovery, retaining the original request
identity for observation. Schema support, actual native capabilities and eventual
startup remain distinct observations. Existing assistants and resumed native
sessions do not acquire new defaults.
