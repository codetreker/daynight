# Agent Note: Goal list row density

Status: implemented

## Problem

Goal rows occupied more vertical space than task-chain rows for equivalent
content, making the two project lists less consistent in density.

## Decision

Goal headers use the task-chain desktop minimum height and compact vertical
spacing. Their title and metadata retain their own content and controls. Narrow
headers use compact padding and may grow when content wraps. The [Goal
specification](../../../../docs/spec/daynight-goals.md) owns the visible behavior.

## Alternatives

**Fix the row height.** Long titles, metadata and progress can wrap, so a fixed
height would clip or overlap content.

## Consequences

Equivalent unwrapped desktop rows align while localized or long content can
still increase their height. The two lists retain independent responsive layouts.
