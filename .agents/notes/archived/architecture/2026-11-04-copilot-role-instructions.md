# Agent Note: Copilot Native Role Instructions

Status: implemented

## Problem

Controller tickets can carry a frozen role independently of user input, but
Copilot needs that role on both initial creation and exact native recovery.
Sending it as a user message would create an artificial turn, while replacing
the native prompt could discard the CLI foundation and its guardrails.

## Decision

The Copilot adapter conditionally sets `systemMessage` to append the exact
`ProviderOptions.instructions` text in the config shared by create and resume.
An absent role leaves the config key absent. The pinned SDK 1.0.11 accepts append
in both operations and preserves its CLI foundation. Ticket validation and
cross-generation frozen-text selection retain their
[existing owners](2026-11-04-controller-role-instructions.md).

The role does not affect model or effort selection, interactive permissions,
native identity checks, or owned-runtime cleanup. Opening failures propagate
through the existing startup failure path without a replacement session or
fallback user input. The [requirements](../../../../docs/spec/controller-role-instructions.md#copilot-原生追加)
and [design](../../../../docs/design/task-session-protocol.md#copilot-sdk-与私有-runtime)
own the observable contract and mechanism.

## Alternatives

**Send the role as initial user input.** This conflates role configuration with
the first request and creates a turn before the user supplies any work.

**Replace the native system message.** The SDK exposes this option, but it
removes the CLI foundation and SDK guardrails. Append satisfies the role
requirement while retaining those native responsibilities.

## Consequences

Creation and exact recovery receive the same frozen role without additional
user messages. Legacy sessions omit the new configuration, and recovered
sessions keep their native settings. Provider fixture tests cover append,
default and explicit settings, permissions, and startup cleanup; real SDK/CLI
acceptance remains a distinct source-bound result. This adapter does not supply
Bot templates, hosting, or the other providers' role implementations, and it
does not establish complete Bot behavior or model adherence to the role.
