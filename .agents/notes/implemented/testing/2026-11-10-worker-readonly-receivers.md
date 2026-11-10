# Agent Note: Worker Read-only Receiver Ownership

Status: implemented

## Problem

Directory acceptance spans HTTP adaptation, broker routing, native filesystem
enumeration, and browser decoding. A native end-to-end test alone does not give
each Go owner an independent, deterministic observation of its responsibilities.

## Decision

The read-only HTTP routes depend on a private operations interface with the
same six broker methods. The public constructor binds the supplied broker
directly. HTTP tests control the Request result while exercising authentication,
routing, deadlines, validation and response encoding. Broker tests exercise
two concurrently current connections and route independent directory pages
through their actual queues and fences.

The real WebSocket large-frame tests remain responsible for channel decoding
and delivery. Store tests retain SQL visibility and account isolation. Native
filesystem enumeration and browser stream decoding remain with their respective
consumers; supplied HTTP results do not establish those mechanisms.

## Alternatives

**Use only the native acceptance.** It observes the combined path, but couples
Go owner feedback to CLI processes and filesystem setup.

**Replace the WebSocket tests with supplied results.** This would lose the
large-frame channel decoding and delivery evidence that the HTTP fixture does
not exercise.

## Consequences

The private interface adds a test boundary without changing the public
constructor or moving broker state to HTTP. These receivers add test cost and
do not alone establish live credential validity, SQL filtering, filesystem
pagination, or browser decoding. The existing mixed channel fixtures still
depend on real authentication and PostgreSQL.
