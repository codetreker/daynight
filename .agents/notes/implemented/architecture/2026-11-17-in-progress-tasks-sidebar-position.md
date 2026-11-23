# Agent Note: In-progress Tasks Sidebar Position

Status: implemented

## Problem

The account's ongoing work is a frequent destination, but its entry was below the
project directory in the My group. A long directory made the entry less immediate.

## Decision

The sidebar places In-progress tasks after the Team selector and immediately
before Projects. Its `/my-tasks` link remains account-scoped and available while
the Team selection is restoring or has failed. Project and Team links retain their
existing admission rules. This placement partially replaces the resource-scope
grouping in the [sidebar scopes decision](2026-11-12-sidebar-navigation-scopes.md).

## Alternatives

**Keep the entry in My.** This groups account resources together, but leaves the
frequent destination below the potentially long project directory.

## Consequences

The entry is easier to reach in each sidebar layout. Its visual proximity to the
Team selector does not filter the page by Team; the account scope remains distinct
from the adjacent project directory.
