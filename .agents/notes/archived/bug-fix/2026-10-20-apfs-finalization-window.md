# Agent Note: APFS Finalization Observation Window

Status: implemented

## Problem

The [device-ownership decision](2026-10-20-apfs-device-ownership.md) preserves an
image identity after its mountpoint disappears. A later [macOS failure](https://github.com/codetreker/day-night/actions/runs/39431840901/job/118658576936)
passed 1,518 test assertions but failed finalization after three ordinary detach
calls returned `Resource busy`. The mountpoint was gone while the exact image
remained attached. Calls and two short pauses consumed about four seconds of the
30-second budget. The original holder is unknown; the receipt does not establish
an infrastructure cause or a pending successful eject.

A useful finalizer must retain ownership across this partial state, leave time
between ordinary attempts, and collect holder evidence before a known descriptor
can disappear. A repeated finalizer must not silently receive another call budget.

## Decision

Before filesystem assertions, setup verifies that the same-user image inventory
positively reports the canonical fixture image and the actual GPT root retained
from attach metadata. Only that observation grants a verified ownership record.
Cleanup with an uncertain attach must recover a unique positive exact-image/root
observation; absence without prior verified visibility is an error. Selective
typed `plutil` extraction and device identity retain their existing rules.

Observation distinguishes `mounted`, `unmounted_attached` and `absent`. Both
attached states require current exact-image and root agreement. A disappearing
mountpoint is not complete image absence. Only verified absence permits directory
removal; changed ownership, inventory failures and unresolved attachment preserve the
fixture. Setup that never attempted attach can remove its temporary directory.

One absolute 30-second finalization budget covers every query, diagnostic, pause
and at most three ordinary detach calls. After Busy, the remaining time is divided
between the remaining calls and a final observation interval. Early Busy responses
normally place detach opportunities near 0, 10 and 20 seconds; after the third,
observation continues within the original deadline without a fourth call. Queries
are bounded and serial, and each completes before a detach starts. Only actual
C-locale Busy permits another attempt; unrelated failures preserve the error chain
and fail immediately. Persistent attachment fails at the original deadline.

The first Busy is reported immediately, followed first by volume `lsof`, then a
fresh exact-image observation and one set of diagnostics over only its current
root/child devices, their raw aliases and root `diskutil` metadata. Volume sampling
precedes inventory queries because their legal execution costs can exceed the
controlled holder's six-second lifetime. The
[controlled-holder observation decision](2026-10-21-apfs-controlled-holder-observation.md)
adds optional acknowledged-child PID selection to that volume query, intersected
with the filesystem through `lsof -a`; generic and device diagnostics retain their
existing scope. Every diagnostic retains its two-second bound. Diagnostic status,
bounded stdout/stderr and image-state transitions remain visible even when finalization succeeds. Raw
device queries inspect known entities; they create no raw-device holder and infer
no parent device. Disk Arbitration's [eject investigation](https://github.com/apple-oss-distributions/DiskArbitration/blob/a542bda934211dc3c301bfdcc7f21349c4164a85/diskarbitrationd/DARequest.c#L1742-L1810)
also examines raw devices and media descendants. Empty diagnostic output does not
establish resource absence.

A final native case reuses the case-sensitive image after the original eight
filesystem assertion bodies. A same-user child, with cwd on the host repository,
holds an ordinary fixture file read-only. Real detach must return Busy; that event
starts a six-second release timer. The case requires the child's actual PID in
volume `lsof`, acknowledged release after six seconds, at most three ordinary
calls, final verified absence and child exit. It records monotonic detach timings,
elapsed finalization and final image state. The case and `afterAll` share one lazy
promise, including rejection, so failure cannot start a second finalization cycle.
Only the known child is released or terminated during its own bounded cleanup.

The original eight filesystem assertion bodies, 120-second setup hook, 40-second
teardown hook and 600-second platform gate remain unchanged. The additional case
has a 40-second test limit while its finalizer retains 30 seconds. This is a test
resource guarantee with no force detach, privileged setup or reduced workload.

## Alternatives

**Three closely spaced ordinary retries.** The failed run exhausted all calls
while most of its allowed time remained. Distributing the existing opportunities
and observing between them preserves the call limit while allowing later release.

**Private attachment.** Apple's [completion metadata](https://github.com/apple-oss-distributions/zsh/blob/666e91a595af505ef61d5f9b87df7a014a4937c6/zsh/Completion/Darwin/Command/_hdiutil#L169-L175)
establishes notification suppression, not inventory visibility through mounted and
partially unmounted states. The chosen cleanup needs positive inventory evidence;
private attachment is not used to make absence appear successful.

## Consequences

Deterministic cases cover partial unmount, delayed release, final-window absence,
persistent attachment, diagnostic costs, changed ownership and one-shot success
and rejection. A timed case gives each inventory/extraction command 1.6 seconds,
requires holder capture before those queries, and completes recovery at 22.4
seconds. These cases verify scheduling and error attribution without a native disk.

Native validation must execute all nine cases and produce actual Busy, known-PID,
six-second release and final-absence evidence. Disk Arbitration's [ordinary unmount path](https://github.com/apple-oss-distributions/DiskArbitration/blob/a542bda934211dc3c301bfdcc7f21349c4164a85/diskarbitrationd/DARequest.c#L1630-L1677)
and XNU's [busy vnode handling](https://github.com/apple-oss-distributions/xnu/blob/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/bsd/vfs/vfs_subr.c#L2800-L2839)
explain the expected ordinary-file mechanism. The controlled case does not identify
the original holder or prove the native `unmounted_attached` phase. The
[APFS repair PR](https://github.com/codetreker/daynight/pull/59) and its CI run
own source-bound hosted receipts. The [validation guide](../../../../README.md#validation)
defines their interpretation and limits.
