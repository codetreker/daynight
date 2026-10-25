# Task Status Assignment Prototype

This standalone prototype implements task status assignment for `todo`, `in_progress`, and `done`. A current-status button opens a three-item radio menu, and selecting any item opens target-specific confirmation. New task fixtures start at `todo`. The interface includes shared status/automatic-execution writes, exact-version review, dependency refusals, execution timing, and read-only reconciliation.

Open `index.html` directly or serve this directory with a local static HTTP server. All resources are local. The prototype requires no package installation, API connection, credentials, or persistent storage.

## Visual and resource ownership

The interface derives `app.css`, `auth.css`, `task-detail.css`, `attachments.css`, and `markdown.css` from `packages/daynight-web/src/styles/` at commit `7b426bc0b632e57bb80dea0d5aca35b1e8f71a6e`. The application declares `color-scheme: light`; the prototype preserves that styling. The task-detail copy removes obsolete status and action-specific rules. The other four copied styles remain byte-identical to that source. `prototype.css` owns the status control, confirmation additions, and clearly separated fixture toolbar.

The task's actual title occupies the shared dialog header with the close action; the compact status control begins the state row below it. It remains bounded and keyboard-scrollable for long names. The Overview metadata holds the task ID and its copy control. There is no duplicate task heading or language selector inside details. Fixture language selection belongs to the toolbar. Status, automatic execution, retained read errors, panels, and attachment reading preserve the compact production layout.

A confirmed automatic-execution change displays a success overlay for three seconds without shifting the reading area. Closing details clears that overlay, and reopening a confirmed session does not replay it. Pending, conflict, unknown, and failed-readback feedback remains available until its actual outcome is resolved.

## Simulation controls

The toolbar changes the fixture scenario or initial status, opens/closes details, selects language, and simulates a concurrent task update. It is outside the product interface. The simulation uses a fixed clock at 2026-10-24 09:46 UTC; displayed durations are fixture values, not runtime measurements.

One simulated server task owns every accepted write, concurrent edit, and task read. The interface keeps a separate observed snapshot. Requests check the canonical server version when processed, and response delivery is delayed independently. Polls publish current server snapshots without settling an outstanding write. Readback reads that same server task; it does not replay an earlier write result. One publication rule prevents delayed reads or write responses from replacing a newer observed version. Fixture resets replace both snapshots and invalidate earlier processing and response callbacks through the existing generation.

- Normal tasks support all nine source/target pairs. Version values remain exact decimal integers above JavaScript's safe integer range.
- Selecting the current status opens confirmation and submits a simulated versioned request. Success preserves version, update time, and execution endpoints; a stale version conflicts.
- Separate unfinished ordinary and external prerequisite fixtures refuse entry into execution or completion. Both edge kinds participate equally.
- An active direct successor prevents reopening its completed prerequisite. Status assignment does not cascade to other tasks.
- A conflict reads the current task. A concurrent update during confirmation invalidates the reviewed decision. An edit before request processing causes a stale CAS refusal; an edit after processing may leave a valid response older than the latest observed task, which remains displayed.
- A lost response blocks status and automatic-execution writes until GET-only readback. The failed-readback fixture fails the first read, retains the write block, and permits another read. Attachment reading has independent feedback and cannot remove mutation feedback or its recovery action, including across detail closure/reopening. Readback never repeats the write. A successful read establishes current task facts and is shown as reconciliation; a matching target does not attribute those facts to the unconfirmed request.
- Initial loading, initial failure, retained refresh failure, unavailable task, empty attachments, and long content cover reading states. Loading/error titles use the shared header. The selected attachment and its scroll position survive status writes.
- Entry into `in_progress` records a new start and clears completion. Return to `todo` clears both endpoints. Completion records an end and retains a start only when completing an execution interval. Direct `todo → done` has an unknown start. Same-status writes preserve timing.
- Automatic execution permission uses the same confirmation and per-task write session. It remains independent of status and cannot change while execution is in progress.
- Task ID copying uses the browser clipboard, retains selectable ID text, and reports copy success or failure without changing the task.

## Keyboard and narrow layouts

Overview and Attachments use one active tab and roving tab index. ArrowLeft/ArrowRight wrap between them, Home/End select the first/last tab, and activation moves focus to the selected tab. Inactive panels are hidden and inert; switching tabs retains the mounted attachment panel, file selection, and scroll position.

The status menu marks the current item and keeps it selectable. Arrow keys, Home/End, Enter/Space, Escape, and focus restoration follow the existing attachment-menu pattern. Confirmation initially focuses Cancel, traps focus, closes on Escape, makes its detail owner inert, and restores the opener on cancellation. Submitted writes outlive detail closure.

Chinese and English, 320px screens, long titles, and keyboard-scrollable confirmation content are supported. The product interface does not expose API versions or migration controls.

## Evidence limits

`window.prototype.events` records simulated writes, server edits, and reads; `window.prototype.state` exposes the observed fixture and `window.prototype.server` exposes a read-only copy of the canonical fixture for browser checks. These are test hooks, not product APIs. The prototype demonstrates appearance and interaction. Service authorization, database migration, transaction isolation, restart persistence, execution ownership, and real response-loss recovery require separate implementation and runtime acceptance.
