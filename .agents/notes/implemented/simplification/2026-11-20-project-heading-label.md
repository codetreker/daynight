# Agent Note: Remove the project heading label

Status: implemented

## Problem

The shared project header repeated the generic project tasks label above the
project name, adding a separate line before the identifying title on every
section.

## Decision

The project header starts with the title line and has no decorative label or
reserved label space. The localized project tasks text remains the title fallback
when project information is unavailable; shared translations and eyebrow styling
remain available to other consumers.

## Alternatives

**Keep the label.** It repeats the page context above the project name and
retains the extra line across all sections.

## Consequences

The project name is the first title in the shared heading. Existing navigation,
repository information, actions and fallback behavior remain in place.
