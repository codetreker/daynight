# Agent Note: PR List Heading

Status: implemented

## Problem

The PR list heading repeated the scope already conveyed by the project and list title, consuming space above the operational synchronization information.

## Decision

The heading contains the title, connection fact and refresh action. Synchronization information remains separate, as described in the [PR reading design](../../../docs/design/github-pr-reading.md#web-工作区与列表).

## Alternatives

**Retain the explanatory subtitle.** It repeats the list context and takes vertical space without adding a status or action.

## Consequences

Both languages have a shorter heading while actual synchronization information remains available. The list's reading and refresh behavior is unchanged.
