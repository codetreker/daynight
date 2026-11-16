# Agent Note: Worker tool path editing and reported selections

Status: implemented

## Problem

A saved executable path does not prove which installation is running. An old
version probe can describe a different tool or mode, and a single actual value
cannot describe new admission alongside existing sessions. Treating an empty
input as automatic also erases the difference between an unadopted local choice,
an explicit reset and an unfinished edit.

## Decision

The existing Worker configuration form preserves nullable choices and raw path
drafts. Each tool has one input and an explicit automatic reset in a collapsed
section. The form negotiates tool support independently and requires a supporting
Worker report before editing. The same CAS, submitted snapshot, unknown-result
query and navigation protection own all configuration fields. A lost capability
does not erase a retained draft or authorize a hidden tool write.

Recovery of an unknown legacy save compares each omitted tool against the
original baseline, the local draft and the current observed target. Untouched
paths adopt the current target; unsent edits survive, and divergent concurrent
edits retain the old revision and require explicit conflict resolution. A legacy
or stale read cannot authorize retained paths against a newer revision. Confirmed
receipts remain bound to their own revision even if a later read is available.

Configuration and software details consume one Worker snapshot through a shared
presenter. Target, candidate, admission selection and active groups remain
separate. Current application requires matching cloud revision and choice,
verified actual selection and an online observation. Missing or older facts
remain readable without implying that the new target has applied. Bounded active
groups expose incomplete inventory independently of target application.
The software summary omits an unchecked context only when it has no actual,
candidate, reason, error or active selections and the zero-count inventory is
complete and error-free. Other contexts retain their reported state and actual
version; checking, pending and error remain visible beside an older actual.
An empty summary uses one tool-level not-checked label. Details still consume
the complete snapshot, and a missing tool report uses the legacy probe.

Tool states use the shared semantic palette: successful application, active
checking, waiting and failure retain distinct labels and readable contrast.
Local helper text and focus outlines meet the same contrast requirements without
changing unrelated configuration styles.

This consumes the [negotiated configuration decision](../architecture/2026-11-11-worker-tool-path-configuration.md).
The [Web specification](../../../../docs/spec/daynight-web.md#云端运行配置) owns
the interaction requirements; the [Web design](../../../../docs/design/daynight-web.md#worker-云端配置编辑)
owns data flow and preservation behavior.

## Alternatives

**Save tool paths separately.** A second write flow would need another revision,
unknown-result ledger and navigation owner, while the service already stores a
single desired resource. Sharing the form preserves its existing concurrency
and user-visible cancellation semantics.

**Advance the revision after comparing only submitted fields.** A legacy save
can omit a path that another client changes before recovery. Reusing the retained
path with the newer revision would silently overwrite that change after tool
support returns. Field-level reconciliation preserves independent edits without
granting a stale full-projection write.

**Pair desired paths with legacy version probes.** A probe can refer to another
installation or mode. Displaying that pair would invent a successful selection
and hide older running instances.

**Show every unchecked context in the summary.** Unused slots can remain
unchecked indefinitely, making normal operation look like an unfinished check.
Filtering only demonstrably empty slots avoids hiding uncertain inventory or
diagnostic information, which remains available in the expanded details.

**Use blank text as automatic.** This would adopt untouched null tools and erase
the user's incomplete path edit. An explicit reset preserves the import and
validation distinctions.

## Consequences

Users can inspect and copy complete paths on narrow screens while background
reads retain their edits and expanded details. Capability loss and unknown
results require projection-aware comparisons, and state tests cover those races.
The UI validates path syntax only; remote existence, launch compatibility and
safe process switching remain Worker responsibilities. Controlled API and
browser verification does not establish real Provider interoperability.
