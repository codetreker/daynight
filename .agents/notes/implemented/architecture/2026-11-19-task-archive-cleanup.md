# Agent Note: Task Archive Reclamation

Status: implemented

## Problem

A retention deadline can become stale when a Task reopens or its dependency
chain changes. Removing files while a response or upload still owns them can
break an admitted operation. A crash between revocation and physical deletion
must not restore access or abandon the remaining files. Images may also have
owners outside the expired history.

## Decision

The [retention decision](2026-11-19-task-archive-retention.md) supplies the
protected refresh contract. Cleanup extends its Project-before-Session scope
with resource references and a persistent expiration barrier. Every content
operation checks that barrier after authorization, while summary and operation
receipt reads retain their independent purposes. Existing protocol entry points
use `history_unavailable` with an expiration explanation; versioned directory
consumers can distinguish the retained `expired_at` fact.

The cleanup-enablement migration gives existing unexpired ready legacy archives
a one-time seven-day grace floor, including archives published after retention
metadata was introduced. A retention migration may run long before cleanup is
enabled, so its earlier grace deadline cannot provide this guarantee. Later
deadlines and first publication facts survive; changed grace invalidates cached
expiration. Schema3's persisted ledger policy distinguishes `task_body` from
legacy content; the schema number alone does not. Expiration tombstones are
never revived, and migration replay does not renew the grace period.

Reclamation starts only after confirmed expiration commit. It acquires the
original owner's archive residency permit and joins each exact media lease
gate outside database transactions. A busy permit leaves the durable intent for
the next pass. The typed archive namespace includes staging and legacy files;
image blobs are removed individually only after reference-based GC admission.
Committed capture records identify history-owned message references. Unknown
message pins and upload, operation, and native-resume references survive.

The service owns a bounded background scan and drains it before its borrowed
database and storage close. A persistent completion timestamp distinguishes
expired archives still requiring cleanup. Already-expired intents remain
eligible after their Task or Project is soft deleted.

## Alternatives

**Keep the retention migration's original grace deadline.** A delayed upgrade
could start cleanup after that deadline and immediately remove legacy archives.
The one-time enablement floor ties the reading period to the first version that
can actually reclaim them.

**Delete the entire Session resource directory.** A resource can retain an
independent operation or native-resume reference. Namespace ownership alone
cannot prove that history is its last owner.

**Hold the database transaction while waiting for readers.** Readers may need
another transaction to finish, and a small pool can deadlock. Committing access
revocation first permits waiting without retaining a connection.

**Remove only archive reference rows.** Captured images also have message pins.
Keeping known history-owned message pins would retain most archive images
forever; deleting all message pins would discard unrecognized owners. Matching
committed capture identities supplies the missing ownership evidence.

## Consequences

Physical cleanup is idempotent and can resume after failure or restart without
reviving content. Independent Task attachments and Bot namespaces are untouched.
Retained summaries and operation receipts are not erased. Shared references
can intentionally keep image bytes after archive expiry.

The scan visits UUID-ordered pages, including archives whose deadlines need
recalculation. This avoids starvation behind unfinished chains but makes sweep
latency proportional to the retained directory size. The existing per-owner
archive permit can postpone cleanup while another Session of that owner is
reading; this trades reclamation latency for reuse of the established
cross-instance I/O protection.
