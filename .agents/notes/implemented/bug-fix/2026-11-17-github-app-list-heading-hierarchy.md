# Agent Note: GitHub App List Heading Hierarchy

Status: implemented

## Problem

The names in the GitHub App management list were larger and heavier than the section heading containing them, obscuring the list's visual hierarchy.

## Decision

The list section owns its heading typography: its h2 uses 1.17em at weight 700, while every App h3 uses weight 650 and 15px above 600px or 14px at narrower widths. Both retain their semantic levels and inherited font family. The [registration design](../../../../docs/design/github-app-registration.md#管理工作区) describes the workspace.

## Alternatives

**Change shared panel headings.** This would alter unrelated configuration and management panels even though the hierarchy problem is specific to the App list.

## Consequences

The section is visually stronger than each name without changing the list's behavior. The list-specific rules must remain aligned with the shared typography if its base font changes.
