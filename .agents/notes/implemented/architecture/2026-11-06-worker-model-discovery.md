# Agent Note: Creation-time native model discovery

Status: implemented

## Problem

Creation settings need native model and reasoning capabilities before an
assistant exists. Launch validation rejects unknown defaults, although a native
catalog can still be useful. Reusing a running Session would couple creation to
another assistant's identity and state.

## Decision

Separate capability observation from strict launch selection validation and
share their existing probe supervisor and retained cleanup ownership. Add a
typed model operation to the authenticated Worker read-only channel. Preserve
native model metadata and unknown defaults instead of inferring common options.
The [design](../../../../docs/design/worker-model-discovery.md) owns the schema,
provenance, pagination and error behavior.

Read a new native catalog for each initial request. Retain only bounded,
short-lived pagination snapshots, tied to the effective configuration, Provider,
cwd and explicit model. Validate result shape against the pending operation and
Provider, not just the connection identity.

## Alternatives

**Call existing Session controls.** Their refresh methods also query skills,
commands or permissions and require a Session. Pure native capability probes
avoid those unrelated operations and cannot change an existing assistant.

**Reuse strict launch validation unchanged.** An unknown Copilot default would
discard a valid native model list. Separate discovery preserves uncertainty
while retaining strict validation when a launch requires a confirmed selection.

**Cache catalogs across initial requests.** This reduces probe startup cost but
can hide native configuration and capability changes. Short-lived page snapshots
provide stable pagination without making a stale catalog the next query's truth.

## Consequences

Queries incur native startup latency and can time out independently of the
default name-only creation path. Cleanup can outlive the HTTP response and must
retain its original ownership proof. Capability results do not authorize or
prove launch success. The current channel still requires Worker and caller to
reach the same service instance; no new persistence or routing service is added.
