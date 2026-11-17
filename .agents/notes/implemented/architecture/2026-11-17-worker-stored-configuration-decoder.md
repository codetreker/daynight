# Agent Note: Decode stored Worker configuration independently

Status: implemented

## Problem

A checkpoint can outlive the network configuration contract that produced it.
Using current network types and parsers to read old files makes an unrelated API
change capable of rejecting persisted application, provenance and removal facts.

## Decision

The storage decoder owns the deployed schemas 1–8, including their mode and
three-tool fields, raw source projection, references and validation. It does not
import active network configuration types or parsers. The outer cache owner
converts newly recognized sudo and archive targets into application facts using
the existing state transition, after validating the historical structure. The
current schema 9 writer retains original source strings and converts the
historical ledger as described by the
[Web configuration checkpoint decision](2026-11-17-worker-web-configuration-checkpoint.md).

The [unknown configuration decision](2026-11-17-worker-unknown-configuration-preservation.md)
retains the source and application responsibilities that this boundary protects.

## Alternatives

**Continue sharing network decoders.** Narrowing the live protocol would also
narrow historical disk reads, potentially discarding responsibility for existing
records or preventing the Worker from starting.

**Convert old facts inside the decoder.** This couples historical parsing to
current state transitions and obscures which work is structural validation versus
application reconciliation.

## Consequences

Network contract changes can proceed without redefining deployed disk formats.
The frozen types and validation rules require deliberate maintenance when a new
storage schema is introduced; they do not themselves authorize or apply an old
target. Existing malformed files remain errors and source bytes remain available
for persistence and later interpretation.
