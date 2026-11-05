# Agent Note: Native Browser Acceptance on macOS

Status: implemented

## Problem

Production browser acceptance must exercise native keyboard selection and link
navigation on the browser's platform without accidentally confirming a business
write. A single direction key does not commit a native selection in headless
macOS Chrome. Adding Enter can confirm an application dialog after selection,
so a sequence that works on one platform can violate a zero-write cancellation
check on another. Control-click also does not select the same browser action on
macOS as on Linux.

A headless macOS browser can also expose the requested layout viewport while
its native content area remains shorter. A wheel event can reach the expected
DOM element below that native area without scrolling it. Layout bounds and
event targets alone therefore do not establish that the entire reading area
can receive native scrolling input.

Browser recovery separately depends on executable identity. Chromium can expose
a different executable path after creating its macOS code-signing clone. Its
[clone contract](https://chromium.googlesource.com/chromium/src/+/6b163abaa66e80f1ebdb990fa070a6bd40fe598e/chrome/browser/mac/code_sign_clone_manager.h)
and [implementation](https://chromium.googlesource.com/chromium/src/+/6b163abaa66e80f1ebdb990fa070a6bd40fe598e/chrome/browser/mac/code_sign_clone_manager.mm)
retain the original main executable through a hard link. Literal path membership
can reject this file while broad directory or filename matching would admit
unrelated executables. Process discovery can also observe an exiting task after
its argument mapping becomes unreadable but before its zombie state is visible.

## Decision

Keyboard acceptance uses native character typeahead on macOS and retains
direction-key navigation on other browser platforms. CDP key-down and key-up
events carry non-ASCII option labels without setting the element value or
dispatching application events. Independent language selections leave and return
to the control to reset its native typeahead prefix. Value, focus, persisted
locale, confirmation, cancellation and zero-write assertions remain unchanged.
Modified-link checks use Playwright's platform-aware `ControlOrMeta` modifier.

Explicit viewport changes in combined authentication acceptance synchronize the
macOS browser's native content size with the emulated viewport through
`Browser.setContentsSize`. The browser calculates its own window-frame size;
the driver does not assume a fixed title-bar inset. The requested layout size,
default hover position, wheel input and scrolling assertions remain unchanged.
Protocol failures remain failures, and temporary CDP sessions are detached.

macOS browser recovery binds an executable alias to the file identity frozen in
the selected browser inventory. A hard link can identify the same trusted file;
a copy, a pathname with a familiar suffix, or another browser version cannot.
The alias does not replace the original PID, start identity, process group,
phase, profile or matching ownership marker. Active processes require current
identity checks before any signal. A completed process does not become a failure
merely because its temporary clone path disappeared, provided its recorded
ownership remains valid and its group is stopped.

The runner freezes recovery inventory before launch. Ownership recording can
read the selected executable again; if an installation replacement changes its
file identity between these observations, recovery rejects the mismatch rather
than authorizing the replacement.

macOS process discovery also preserves its bounded exit check when
`KERN_PROCARGS2` returns `EIO` while the kernel already reports `PROC_FLAG_INEXIT`.
XNU can fail while copying the argument mapping during exit, as described in its
[argument-reading implementation](https://github.com/apple-oss-distributions/xnu/blob/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/bsd/kern/kern_sysctl.c#L1456-L1526).
The existing 100 ms bound and stable PID/start/group checks still apply. Live
read failures, permission failures and an exit that does not finish remain
errors; an `EIO` result alone never establishes that a process stopped.

This extends the executable-path assumptions in the historical
[production acceptance decision](../../archived/testing/2026-10-20-dashboard-production-acceptance.md).
The [functional target isolation](2026-11-04-web-functional-target-overlap.md)
and shared cleanup barriers remain unchanged.

## Alternatives

**Append Enter after every direction key.** Selection can already have opened
the business confirmation dialog. Enter may submit that operation instead of
merely choosing an option, invalidating cancellation and zero-write checks.

**Use `selectOption` or open a new page directly.** These operations bypass the
native keyboard or modified-link behavior being verified. They can prepare
fixtures but cannot establish those interaction contracts.

**Move wheel input to the top of the reading panel or set `scrollTop`.** These
approaches avoid the inaccessible input coordinates without making the full
requested viewport usable. Synchronizing native content size preserves the
original input and the observed scrolling requirement.

**Wait longer or change product overflow styles.** Waiting for rendering or the
previous iframe scroll to finish did not fix the isolated input failure. A
plain scrolling element reproduces it without product styles. Product CSS does
not own the mismatch between native and emulated browser dimensions.

**Accept any code-signing clone path or skip recovery checks.** A familiar path
does not establish process ownership. It would weaken protection for unrelated
browsers and make an incomplete cleanup appear successful.

**Add a separate code-signature trust system.** Chromium's executable hard link
provides the narrower identity relation needed here. Additional signing policy
would reject otherwise supported local browser overrides and duplicate trust
decisions unrelated to recovery of this invocation's processes.

**Ignore argument-read errors.** A live process can fail inspection for reasons
other than exit. Only the kernel exit flag, a stable identity and confirmed
completion within the existing bound justify treating the process as stopped.

## Consequences

The scenarios preserve native input and business confirmation semantics across
platforms. They remain Chromium-specific acceptance drivers; the typeahead
characters must match the actual option labels. Their results do not establish
native IME behavior or a guarantee for every browser.

Recovery accepts verified aliases without trusting a clone directory name.
Unknown startup windows, mismatched records, reused PIDs and unowned profiles
remain failures. File-identity checks are scoped to browser recovery; general
process identity and controller recovery retain their existing contracts.
