# Agent Note: Limit New Attachment Paths

Status: implemented

## Problem

Attachment addresses need a predictable bound for consumers that exchange paths
and pagination cursors in bounded requests. The existing attachment path contract
has no total length limit, so an address accepted by one entry point can grow a
cursor beyond another entry point's request capacity.

## Decision

New and replacement attachment paths contain at most 1024 Unicode code points,
including separators. The shared attachment use case validates the limit before
file I/O, so every transport observes the same restriction. Existing longer
attachment records are retained and their reads, deletion and pagination use the
existing paths; the new limit does not silently remove or rewrite them. The
[attachment requirements](../../../../docs/spec/daynight-task-attachments.md)
own the public path rules.

## Alternatives

**Keep unlimited new paths and redesign cursors.** A compact cursor could avoid
some expansion, but changing cursor identity and handling deleted anchors adds
state or new failure semantics. The bounded path gives new writes a clear shared
limit without that protocol change.

**Apply the limit to every existing record.** This would make already stored
attachments inaccessible or prevent enumeration. Restricting new writes preserves
existing data and keeps ordinary recovery operations available.

## Consequences

The bound counts characters rather than UTF-8 bytes and does not override smaller
filesystem or database limits on individual names or addresses. Existing longer
records remain subject to the capacity of their original transport. File content
sizes remain independent of the path limit.
