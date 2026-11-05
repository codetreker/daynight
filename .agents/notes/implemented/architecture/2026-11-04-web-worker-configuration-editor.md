# Agent Note: Account-owned Worker Configuration Editor

Status: implemented

## Problem

Cloud runtime settings remain useful when a Worker has no recent telemetry, and
editing a target does not establish that the machine applied it. Background
application reports can arrive while a person is entering an invalid number or
an incomplete JSON argument array. Replacing that input with the latest resource
would lose work, and retrying an uncertain save could repeat a committed write.

## Decision

The Worker detail page composes independently owned runtime observation and
configuration resources. The
[observation lifecycle](2026-10-29-web-worker-observations.md) retains its server
time anchor, recent window and task presentation. Configuration has its own
strict account-admitted API and page-memory state. A runtime 404 or expiry does
not remove the configuration entry, and the configuration response does not
fabricate an observation clock or a current online state.

The editor separates the latest resource, the target revision used as its edit
baseline, raw draft input, and an immutable submitted value. Background reads
update target and application evidence without replacing the draft. Stable
controls preserve focus, selection and local disclosure state. The mounted
editor survives tab changes, while only its active, visible and admitted view
starts automatic reads. Temporary admission pauses retain the visible editor,
local interactions and in-flight write ownership; results wait for admission
before publication. The Project chooser retains its loaded collection during a
background check, including a successfully loaded empty collection. Account or
Worker retirement invalidates its requests and memory.

Saving sends one complete target against the captured target revision. A
conflict keeps the draft and exposes the current target for explicit loading.
Unknown write results retain the submitted snapshot and use GET reconciliation
without PUT replay. A matching current target describes the resource's state;
it does not establish that the preceding request caused it. Later edits remain
separate from that submitted value.

Field feedback compares each valid parsed field with the current saved target,
independently of errors in other fields. Project native feedback compares the
explicit overrides, retaining the distinction between inheritance and clears.
Invalid input remains unsaved. Formatting differences do not mask the actual
application result, and the raw draft is never rewritten for this comparison.
The form's edit baseline continues to track raw input separately.

The [configuration protocol](../../../../docs/spec/daynight-worker-configuration.md)
owns fields, revisions, initialization and access. The editor preserves omitted
Project overrides separately from model null and an empty argument array. It
shows application items with their own target revision, retains removal results
for Projects absent from the desired list, and never derives applied status from
a successful target save. The
[Web design](../../../../docs/design/daynight-web.md#worker-云端配置编辑) owns the
component and request mechanism.

## Alternatives

**Use the runtime observation hook for configuration.** That hook requires a
database observation time and applies the 72-hour visibility window. The
configuration response has neither that time model nor that expiry policy;
sharing it would either fabricate a clock or hide retained settings.

**Load every successful resource into the form.** Existing settings readers can
replace their draft after loading. Worker configuration also receives frequent
application observations and must retain unfinished input, so it needs an
independent edit baseline and raw draft rather than a resource projection that
is replaced on each refresh.

**End the write lifecycle whenever reads pause.** An identity check is not a
resource change. Aborting a dispatched PUT on that transition obscures its
actual outcome and discards an open chooser and its unapplied selection. Separate
resource ownership from request admission while retaining actual retirement and
error handling.

**Retry a save after a lost response.** The server may already have committed
the target. Reading current state preserves the exact-version decision and
prevents a second write from being mistaken for recovery of the first.

**Compare field feedback as raw text.** Equivalent JSON whitespace or integer
leading zeroes would appear unsaved after the server accepted the same value.
Rewriting input into canonical form would instead disturb the editor and its
selection. Comparing the complete parsed draft would also let an unrelated
invalid field obscure another field's saved state.

## Consequences

The same detail route can manage retained configuration after runtime telemetry
expires. Target edits, actual values and per-item failures remain distinct, and
background observations do not disrupt an active editor. The configuration view
adds a separate single-flight reader while active; it does not persist drafts
across page or account lifetimes.

The browser displays Worker-supplied application evidence and cannot prove
repository preparation or native process termination. Component and controlled
browser validation establish their stated frontend behavior; actual Worker
application requires combined service, CLI and native-runtime evidence.
