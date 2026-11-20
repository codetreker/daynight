# Agent Note: GitHub App List Heading Hierarchy

Status: implemented

## Problem

The names in the GitHub App management list were larger and heavier than the section heading containing them, obscuring the list's visual hierarchy.

## Decision

The list section owns its heading typography: its h2 uses the shared section heading role at weight 700, while every App h3 uses the shared interface role at weight 650 across widths. Both retain their semantic levels and inherited font family. The [registration design](../../../../docs/design/github-app-registration.md#管理工作区) describes the workspace.

## Alternatives

**Change shared panel headings.** This would alter unrelated configuration and management panels even though the hierarchy problem is specific to the App list.

## Consequences

The section is visually stronger than each name without changing the list's behavior. The shared roles preserve the hierarchy as browser font preferences change.
