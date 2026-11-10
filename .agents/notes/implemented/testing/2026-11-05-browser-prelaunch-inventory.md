# Agent Note: One Prelaunch Browser Inventory

Status: implemented

## Problem

Browser selection and recovery freeze an executable inventory before launch.
If ownership recording samples the installation again after a replacement,
it can persist a receipt with a different inode. Recovery rejects that receipt
before checking whether its process has stopped, so even normal browser closure
and profile removal cannot make repeated recovery succeed.

## Decision

Ownership recording requires the prelaunch inventory as an explicit argument.
Combined authentication passes the inventory saved in its receipt. Playwright's
acceptance fixture reads the inventory persisted by its runner in the same
phase's `target.json`. Missing or malformed inventory fails explicitly without
resampling. New macOS ownership requires saved executable file identities;
path-only inventories remain a recovery compatibility concern, not permission
to write new macOS ownership.

The launched executable must match a saved device/inode before writing its
profile marker or process receipt. Hard-linked code-sign clones retain the
same-file allowance. Rejection preserves every existing receipt and leaves
closure of the launched browser with its caller. After confirmed closure and
profile removal, this rejection introduces no record that can block recovery.
PID, start identity, process group, phase, profile, marker and companion checks
remain required. Failed closure and unknown processes or profiles remain errors.

This partially supersedes the second-sampling allowance in the
[macOS browser acceptance decision](2026-11-05-macos-browser-acceptance.md).
That decision correctly refused to authorize a replacement from a mismatched
receipt. Moving the refusal before persistence preserves its safety rationale
while avoiding a durable record known to disagree with recovery's inventory.
The former full-stack acceptance runner has since been removed. The
[Web module browser entry](2026-11-06-web-module-browser-entry.md) runs controlled
frontend fixtures and does not recreate its inventory or recovery mechanisms.

## Alternatives

**Resample and let recovery reject.** This protects unknown executables but
leaves a mismatched receipt even after successful caller cleanup. A fresh
inventory cannot substitute for the selection that recovery must validate.

**Trust the path or discard mismatched receipts.** Path equality does not prove
file identity. Deleting a rejected record can also discard evidence about a
still-live process. Both weaken the existing ownership boundary.

**Require file identities for every historical recovery.** Older records can
use exact executable paths. Tightening that compatibility boundary is unnecessary
for requiring saved file identity in new macOS recordings.

## Consequences

Both entry points share the identity basis already saved for recovery. Runtime
validation complements the required parameter because persisted JSON is
untyped input. Deterministic entry-point fixtures and native macOS executable
replacement/hardlink tests establish the persistence and cleanup behavior;
they do not establish replacement of a real browser installation or complete
combined authentication acceptance.

Inventory is an observation, not an installation lock. Replacement and other
startup failures still fail acceptance, and unknown resources require diagnosis.
No new authority to delete unknown resources or guarantee all cleanup is added.
