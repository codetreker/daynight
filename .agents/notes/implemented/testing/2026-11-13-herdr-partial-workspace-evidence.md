# Agent Note: Herdr Partial Workspace Cleanup Evidence

Status: implemented

## Problem

A real Herdr workspace can be created and its Windows PowerShell root layout
replaced before root readiness fails. The preparation call then returns no
binding to its caller, even though the workspace and processes remain cleanup
responsibilities. Closing the daemon and observing its endpoints disappear do
not establish that the workspace was closed while its original identity was
still observable. The normal stop path also requires a prepared process journal,
which is not yet available at this stage.

A Windows platform run exhausted its existing preparation deadline during root
readiness. Its artifacts did not retain the root pane output or readiness-file
state, so they cannot identify the PowerShell bootstrap step or explain why the
readiness proof was not obtained.

## Decision

The isolated real-platform fixture handles an unbound Windows readiness failure
only after observing the exact execution owner, workspace, pane, terminal and
original layout intent. It verifies the current layout and process root before
closing that workspace, then requires a confirmed close and a fresh observation
that the original owner, workspace, pane and terminal are absent. An ambiguous
owner, layout, process capture, close result or subsequent observation remains
unconfirmed and prevents successful cleanup. This fixture-only recovery does not
authorize a production workspace close without the normal stop proof.

The independent Windows checker accepts this distinct partial-preparation path
only with its owner-bound workspace closure evidence and complete original
process-stop evidence. It independently observes each captured original using
its recorded birth token and continues to require closed endpoints and removed
runtime resources. The complete-journey path retains its four original process
identities and workspace-closure requirements. The [frozen launch decision](../architecture/2026-11-12-herdr-frozen-tool-launch.md)
owns the normal mapping, process and independent observer rules.

Bounded failure diagnostics retain the available readiness-file and owned-pane
observations before cleanup. The preparation deadline and the real PowerShell,
Herdr, official tool, identity and command-mapping checks remain unchanged.

## Alternatives

**Treat daemon shutdown as workspace closure.** Closed endpoints and an exited
daemon do not identify the original workspace or establish its removal from the
live Herdr session. The fixture observes closure before stopping the daemon.

**Use the ordinary stop path without a prepared process journal.** That path
requires the original journal to establish process ownership before closing the
workspace. Fabricating it after a failed preparation would turn an unknown
identity into a stop proof.

**Extend the preparation deadline.** The historical artifact does not locate
the stalled bootstrap step or show that a larger budget would complete it. A
longer shared budget would delay a genuine failure without establishing its
cause; a stage-specific budget requires evidence of the work it must bound.

## Consequences

The fixture can distinguish verified partial workspace closure from unknown
cleanup while preserving independent process and endpoint checks. A failed
diagnostic does not replace the original readiness failure or establish a cause;
the available artifact cannot reconstruct the historical bootstrap state. The
normal production stop path and successful real-platform acceptance remain
unchanged. Process-tree PID incarnation remains a separate ownership concern.
