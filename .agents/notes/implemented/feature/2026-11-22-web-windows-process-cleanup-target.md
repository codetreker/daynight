# Agent Note: Web Windows Process Cleanup Target

Status: implemented

## Problem

`enableWindowsProcessCleanup` reaches the service and the Worker, and the
Worker acts on it, but no one can turn it on. The configuration page offers
every other Worker target; without a control here the only way to set this one
is a direct API call, which is not how any other member is managed.

The member also carries more consequence than most: enabling it authorizes the
Worker to terminate processes it never started. A page that offered it without
saying so would be worse than no page at all.

## Decision

The control mirrors `enableSudoCleanup`, which is the same shape of member: an
optional boolean the service sends directly, meaningful on some platforms and
not others, whose application the Worker reports separately.

The mirror is exact in structure and opposite in platform. Sudo cleanup is
editable on Linux and macOS and shows an unsupported notice on Windows; this
one is editable only on Windows. Both follow the same rule when the platform
does not support them: the checkbox is disabled, the draft keeps whatever the
service last sent rather than the local edit, and a save made on an unsupported
platform submits the baseline value instead of the edit. That is what keeps a
value set from one machine from being silently rewritten by a page open on
another.

### Naming the setting in its own messages

The availability notices do not reuse the sudo strings. Both members can be
absent at once, and two paragraphs reading "The service does not yet provide
this setting" give the reader no way to tell which one is missing. Each notice
names its own setting.

The detail text states plainly that the terminated processes may include ones
the Worker never started. That is the fact an operator needs before enabling
it, and it is the reason this is a separate target rather than part of sudo
cleanup.

## Alternatives

**Reuse the sudo control with a platform branch.** One checkbox whose meaning
changed by platform would need no new strings and no new draft field. It would
also mean a single stored value expressing two different authorizations, and a
Worker that moved between platforms would inherit permission it was never
granted. The service models them as two members for that reason.

**Show the control on every platform and let the Worker ignore it.** Simpler in
the page, and the Worker does ignore the value off Windows. It would also let
someone set a target that nothing will ever apply, and the application feedback
would sit at "awaiting application" forever with no explanation.

**Share one availability message between the two members.** Fewer strings, and
the first implementation did this. A test caught it immediately: with both
members absent the page showed the same sentence twice, and the existing
assertion could no longer tell which control it had found. A reader has the
same problem.

## Consequences

The target is configurable wherever it is meaningful, with its own application
feedback and its own name in the summary. A page open on a platform that does
not support it shows why and cannot submit a value for it.

The page does not express that the setting only matters when ordinary cleanup
has already failed, or that a holder keeping an open file rather than a working
directory is outside what it recovers. Those belong to the cleanup behavior and
are documented with it; repeating them in a checkbox detail would bury the one
fact the operator must read before enabling it.
