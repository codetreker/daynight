# Agent Note: Session Dispatch Refusals and Channel Admission

Status: implemented

## Problem

A browser operation can become stale between being offered and native dispatch.
Closing the Controller channel for that ordinary refusal interrupts unrelated
session traffic. Separately, allocating WebSockets before checking Controller
credentials lets anonymous clients consume the shared connection quota.

## Decision

Controller channel admission checks the grant, its parent credential and active
scope before WebSocket upgrade. The hello transaction repeats authorization and
atomically validates the execution and connection fence. Channel reservations
include pending upgrades and are released when an upgrade fails.

An offered operation whose permission or state changed is persisted as rejected
and returned through its own receipt. The Controller settles the matching journal
operation and rejects dispatch authorization without closing the connection.
Late receipts and reconnect reconciliation retain the same operation identity.
Reconciliation envelopes use the current connection fence, while durable
receipts retain their original execution generation. The parser accepts only
the same binding and a generation no later than the current one; direct
receipts and dispatch authorization retain exact current-generation checks.
Already-dispatching operations keep their uncertainty rules; internal failures
and invalid Controller authority still fail conservatively.

Launchers exchange their bootstrap grant for a reconnect grant before starting
the Controller, allowing recovery from an early network disconnect without
waiting for the first renewal interval. The same parent credential and execution
scope remain required. Session capability and Controller endpoints are reserved
against authentication callback route collisions.

## Alternatives

**Close every channel on an operation conflict.** This treats ordinary concurrent
browser actions as transport failures and disrupts all pending activity.

**Refresh credentials earlier without scoped operation refusals.** That shortens
recovery from a disconnection but still unnecessarily interrupts unrelated work.

**Validate only after hello.** Invalid callers can hold upgraded connections
while waiting for hello, before they have established any session authority.

## Consequences

The service has a read-only admission check followed by authoritative transactional
connection admission. The second check remains necessary because credentials and
claim ownership may change during upgrade. A refusal receipt never grants native
dispatch, and persisted unknown operations are never converted to fresh inputs.
Real HTTP/WebSocket regressions exercise rejected admission, stale offers on a
live connection and capacity reservation during a blocked upgrade.
