# Agent Note: APFS Disk Image Device Ownership

Status: implemented

## Problem

An APFS volume's mountpoint can disappear while disk-image finalization is still
in progress. The [observed macOS failure](https://github.com/codetreker/day-night/actions/runs/39412445956/job/118593266497)
reported a busy detach, then diagnostics could no longer resolve the mountpoint,
and another detach by that path failed. No holder was established. A missing
mountpoint cannot establish whether the backing disk image remains attached.
Cleanup needs an identity that covers the complete image before deleting its
backing directory.

The [original finalization decision](../testing/2026-10-18-apfs-fixture-finalization.md)
retains its ordinary-detach policy, resource budget and diagnostic requirements.
This decision replaces mountpoint-based attachment identity and adds explicit
proof that the fixture's complete image is absent.

## Decision

The APFS fixture creates an explicit single-partition GPT disk image, resolves
its canonical path with `realpath`, and captures `hdiutil attach -plist` output.
The whole-image device is the unique `GUID_partition_scheme` entity's actual
`dev-entry`. It is not inferred from a mounted APFS volume or from an assumed
device-number pattern. Apple's [disk-image test helper](https://github.com/apple-oss-distributions/hfs/blob/d1bac2f062e6e9c0dfcce302d9aacb10173d0eea/tests/disk-image.m#L393-L462)
provides the attach-plist and returned-device identity pattern. Its forced-detach
policy is not adopted.

The platform `plutil` selectively extracts typed fields. Raw array extraction
supplies the inventory count; raw string extraction reads each image path. Only
the attachment's or matching image's `system-entities` array is extracted as JSON.
The entire inventory is never converted to JSON, so unrelated binary image aliases
are not part of identity parsing.

Setup positively verifies that `hdiutil info -plist` reports the exact canonical
fixture image and retained GPT root before granting ownership and starting the
filesystem assertions. Before detach, current inventory must still match that
image and root. When attachment was attempted but its result is uncertain, a
unique positive exact-image observation supplies recovery identity; inventory
absence without prior verified visibility cannot grant ownership. Malformed
output, ambiguous entries, changed ownership and inspection failures retain the
fixture.

The [finalization-window decision](2026-10-20-apfs-finalization-window.md) extends
this device identity with positive visibility, three explicit image states and
use of the existing observation deadline. Cleanup retains at most three ordinary
device-targeted detach attempts within 30 seconds, including every query,
diagnostic and pause. Only confirmed C-locale `Resource busy` permits another
attempt. The original eight filesystem assertion bodies, 40-second hook and
600-second platform gate remain unchanged; one additional same-user file-holder
case validates real Busy and recovery with the same finalization promise.

Observation reports `mounted`, `unmounted_attached` or `absent`, scoped to the
fixture path, retained root and current owned entities. A successful detach must
be followed by verified exact-image absence; a vanished mountpoint alone cannot
authorize deletion. Already-absent state permits removal only with previously
verified ownership. Setup that never attempted attach can remove its directory
directly. No directory is removed while ownership or attachment is uncertain.

## Alternatives

**Continue detaching by mountpoint.** The observed mountpoint disappeared before
the second attempt, so the same path could no longer identify the attached image.
Retaining the returned whole-image device avoids depending on volume mounting.

**Treat an absent mountpoint as successful detach.** APFS volumes and the backing
disk image have different lifecycles. Deleting the image's directory on that
observation would discard evidence without proving that all its devices detached.

**Force detach.** This overrides a busy refusal and can disrupt an active consumer.
Ordinary detach plus exact-image inspection preserves the existing refusal policy
and leaves unresolved resources available for investigation.

## Consequences

Finalization follows fixture image ownership across mountpoint changes and rejects
ambiguous or changed identities. The required filesystem assertions and validation
budgets remain intact; teardown failure continues to fail the native job.

Deterministic fixtures validate image/device selection, changed ownership,
uncertain attachment, disappeared mounts, full-image absence and failure retention.
Native APFS execution remains necessary to establish actual platform behavior;
passing product assertions followed by failed teardown is not a successful job.
