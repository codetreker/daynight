# Agent Note: My Tasks Heading

Status: implemented

## Problem

The account-scoped task page repeats its scope above the title even though the
workspace breadcrumb already supplies that context, adding a redundant line.

## Decision

The `/my-tasks` content heading starts with its page title. The breadcrumb and
sidebar retain their existing account-scope navigation, and the shared eyebrow
style remains available to other pages.

## Alternatives

**Keep the scope label.** It repeats context already present in the breadcrumb
and occupies space above the title.

## Consequences

The heading has one fewer line in both languages and all data states. The title
continues to serve as the fallback focus target when a detail view closes.
