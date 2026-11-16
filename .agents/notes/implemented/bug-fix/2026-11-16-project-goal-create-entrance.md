# Agent Note: Persistent Project Goal Creation Entrance

Status: implemented

## Problem

The Goal creation entrance was available only while the Goal category was
mounted. Creating a Goal from another category, search, or an unavailable task
snapshot required changing the current view before opening the form.

## Decision

The project toolbar places Goal creation immediately after Task creation and
owns the Goal dialog independently of the active list. It uses the existing
Goal form, project identity and graph refresh. Category, search, filter and
snapshot changes do not replace the dialog or its draft. The
[Goal Task entrances decision](../simplification/2026-11-12-goal-task-entrances.md)
records why the separate Goal detail creation and membership controls were
removed; this decision changes the remaining Goal creation entrance's location.

## Alternatives

**Keep the entrance in the Goal list.** It ties creation to a category that is
not mounted in other views and makes the action unavailable when the list cannot
be displayed.

## Consequences

The entrance is available alongside Task creation without changing the current
selection. The toolbar must accommodate both buttons at narrow widths, while
the existing form retains its write, recovery and focus behavior.
