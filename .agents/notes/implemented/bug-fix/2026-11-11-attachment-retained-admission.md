# Agent Note: Preserve Attachment State During Remote Admission Pauses

Status: implemented

## Problem

A temporary remote admission pause can interrupt attachment reads and writes while
users still need the displayed list, preview, selection, and upload draft. Native
browser links and preview sources do not pass through the shared request gate.

## Decision

The attachment controller keeps resource identity separate from remote admission.
It cancels pending operations and fences late results by pause revision, while
retaining published state and locally editable drafts. The panel removes remote
link addresses and download attributes during a pause, and retains loaded native
preview nodes across local selection changes. Unloaded native sources wait for
admission. The [attachment design](../../../../docs/design/daynight-task-attachments.md#web-文件树与预览)
owns the detailed behavior and the trusted HTML execution boundary.

## Alternatives

**Reset the attachment controller on pause.** This discards the user's selection,
preview and draft even though the resource itself has not changed.

**Block only the shared request helper or ordinary clicks.** Browser-native
links and media sources can dispatch without either path, including modified
clicks and keyboard activation.

## Consequences

Temporary pauses retain local context without admitting new attachment operations.
The controller must fence late results and resume interrupted reads without
replacing the published inventory with a partial recovery; preserving a
loaded native preview also retains its existing browser document and its trusted
HTML execution semantics.
