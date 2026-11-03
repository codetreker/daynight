# Agent Note: Native Development Filesystem Coverage

Status: implemented

## Problem

Routine native macOS development should not require disk image authorization,
attachment, or recovery. Security software and other volume users can block
normal detach even after the application exits. Linux developers and the required
Linux CI gate already exercise the production filesystem's case-sensitive
behavior; requiring every developer to reproduce it adds a separate operating
system dependency to ordinary application work.

## Decision

Keep Go and Web development native on macOS. LocalStorage probes the actual
directory and permits a case-insensitive directory on Darwin. Other platforms
retain the case-sensitive prerequisite. Physical paths, PostgreSQL attachment
identities, and the public API remain unchanged; this is not a storage migration.

On a case-insensitive root, LocalStorage checks exact directory-entry spelling
before writes, publication, reads, and deletion. If the operating system resolves
a spelling that has no exact directory entry, the operation refuses that alias.
It uses the filesystem's lookup behavior, not a Unicode case-folding approximation.
An alias write returns the existing attachment path-conflict response before
metadata is written. This protects existing bytes without promising coexistence
of differently cased names on an insensitive filesystem.

Default Web acceptance uses an owned ordinary directory on macOS and records the
measured case-sensitivity capability. Its native attachment fixture avoids the
directory-case collision when that capability is absent. The same functional,
authentication and cleanup scenarios still execute; the
[CI/local stress policy](2026-11-03-ci-stress-separation.md) makes capacity an
explicit local --stress selection on both supported hosts. Linux and the
production container retain the original case-sensitive fixture; a Mac ordinary
directory pass does not establish native case-sensitive storage coverage.
Real-storage case-coexistence tests are separate from ordinary storage and service
tests. The Linux gate must execute them on a capable filesystem.

`pnpm web:acceptance:apfs` explicitly requests the ordinary native Web pipeline
with case-sensitive storage; the direct acceptance entry accepts --apfs --stress
to combine that coverage with scale checks. It uses an owned APFS image only when necessary.
`pnpm web:test:storage-native` retains the image lifecycle checks. CLI review-path
image tests are also explicit through `pnpm test:apfs`; ordinary CLI tests keep
the non-mounting path and recovery tests. No routine command or CI environment
variable implicitly requests image attachment.

The [original macOS acceptance decision](2026-10-22-macos-web-acceptance.md)
required automatic images to preserve the then-current native storage contract.
This decision replaces that default and coverage policy. Its ownership checks,
bounded ordinary detach, persisted transitions, and recovery behavior remain.
Recovery does not require opting into a new attachment. Existing receipts remain
recoverable; a missing capability field in an old receipt is not evidence of a
measured capability.

## Alternatives

**Keep automatic images.** This preserves identical local storage coverage but
keeps disk authorization and environmental detach failures in routine work.

**Refuse default Mac acceptance and offer only an APFS command.** This prevents
surprise mounts but still prevents normal native development on the default disk.

**Use a Linux container backend for Mac development.** This supplies the production
filesystem, but replaces the requested native Go development experience.

**Encode logical paths or introduce another storage backend.** Either can provide
case-sensitive logical names everywhere, but adds storage-layout compatibility and
maintenance work that is unnecessary when native Mac case-coexistence coverage is
explicitly outside the daily development requirement.

## Consequences

Mac developers can run the native application and ordinary validation without
disk images. Case-sensitive filesystem integration remains a Linux gate and an
available Mac diagnostic channel. Aliased names fail on insensitive storage, so a
Linux dataset containing such names is not portable to that directory unchanged.
Directory-entry checks add work only to insensitive roots. The application still
assumes exclusive control of its storage directory; these checks do not add
coordination with unrelated processes modifying that directory.

The [Web README](../../../../packages/daynight-web/README.md#production-browser-acceptance)
owns commands and evidence interpretation; the
[storage design](../../../../docs/design/daynight-task-attachments.md)
owns native path behavior. APFS lifecycle infrastructure remains maintained, but
a routine local pass does not claim it was exercised.
