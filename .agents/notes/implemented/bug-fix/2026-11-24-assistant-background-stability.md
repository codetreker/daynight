# Agent Note: Stable assistant presentation during background reads

Status: implemented

## Problem

An offline observation without a freshness deadline expires after the short
polling window. Adding its timestamp to the compact list at expiry changes row
heights and moves neighboring assistants while the next response is pending.
Sharing transport activity with manual refresh feedback also makes a periodic
read look like a user operation. Neither effect indicates a navigation or a
change in the selected conversation.

## Decision

The [management design](../../../../docs/design/bot-management-web.md#读取与展示)
separates transport busy state from explicit refresh feedback. Background
refresh remains silent. An explicit refresh joins an existing read or queues
the target through the same admission and concurrency controls. Its feedback
ends when the corresponding work succeeds, fails or is cancelled. Resource
and account changes retire the feedback together with the original request.

Compact status uses separate status and machine slots. Expiry replaces the
status with a short label; its timestamp remains accessible without occupying
layout space. Details keep the visible timestamp and historical facts. The
[observation decision](../architecture/2026-11-20-bot-web-observation.md)
continues to own freshness and identity: delay, failure and repeated samples
cannot extend evidence. State changes update existing presentation; polling
does not redefine list keys, navigation or Session bindings.

## Alternatives

**Remove only the compact timestamp.** A longer expired label can still wrap
or change the machine label's remaining width. Independent slots prevent this
coupling while allowing long machine names to remain readable.

**Disable refresh whenever any request is pending.** This prevents a user from
joining a background read and preserves the distracting periodic disabled
state. Explicit feedback tracks user intent without adding requests.

**Treat every refresh call as explicit.** Creation and attention-count updates
also request reads. Making those calls visible would conflate internal
synchronization with the user's refresh operation.

## Consequences

Expiry remains truthful without moving the list. A background failure still
shows the real error, and authorization loss still removes affected facts.
Manual progress requires one additional state field per read and queued
observation, with cancellation and late-response coverage.

Controlled browser tests measure three delayed polling rounds at desktop and
phone widths and retain original DOM, selection, menu, scroll, focus and draft
evidence. They establish Web behavior with controlled API and Session
transports, not real Worker availability or native Provider recovery.
