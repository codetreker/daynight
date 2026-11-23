# Agent Note: Account GitHub Apps Label

Status: implemented

## Problem

The account GitHub Apps entry sits under the My group, so repeating the possessive in its Chinese label adds redundant wording. The Personal Team entry also needs to remain distinguishable by its scope and destination.

## Decision

The account entry uses “GitHub Apps” in Simplified Chinese and “My GitHub Apps” in English. Its visible text, accessible name, and tooltip share the same localized value. The account and Personal Team entries retain their separate destinations and selection rules.

## Alternatives

**Keep the Chinese possessive.** This repeats the group heading without adding scope information.

## Consequences

Both entries have the same Chinese name in Personal Team context; their groups and destinations distinguish their scopes. The English label and existing navigation behavior remain unchanged.
