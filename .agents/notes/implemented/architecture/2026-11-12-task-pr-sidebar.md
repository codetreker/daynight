# Agent Note: Task Pull Requests in the Detail Sidebar

Status: implemented

## Problem

Task descriptions and delivery links compete in the reading column, making the
relationship between delivery links and task dependencies less apparent.

## Decision

The shared task detail overview places the existing pull request section in the
sidebar after any relationship error and before dependencies. The reading column
retains the description. Dialog, standalone and fullscreen presentations share
this layout; narrow screens stack the sidebar after the description.

## Alternatives

**Keep pull requests below the description.** This retains the former reading
column arrangement but leaves delivery links mixed with the description instead
of grouping them with task relationships.

## Consequences

The existing pull request rendering, pagination and data ownership are retained.
Long titles and URLs must remain readable in the narrower sidebar. The earlier
[attachment split decision](../../archived/architecture/2026-10-22-task-attachment-split-view.md)
records the original reading-column arrangement and attachment separation.
