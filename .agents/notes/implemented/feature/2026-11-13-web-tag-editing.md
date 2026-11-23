# Agent Note: Web Tag Association Editing

Status: implemented

## Problem

Task and Goal classification must be editable without overwriting concurrent
changes or coupling a user's selection to the current catalog page. Catalog
creation has a different lifetime from an unsaved association draft, and an
uncertain write cannot safely be repeated as if it had failed.

## Decision

Both details use one picker and a versioned Task detail mutation. The picker
holds selected identities separately from its bounded catalog page and resolves
them when the catalog changes. An editor captures its resource version and
retains its draft across fresh detail reads and mutation failures. A conflict or
unknown outcome presents a current observation; adopting its version requires
an explicit action. Creating a catalog tag is independent of saving its
association. An outstanding creation finishes before association submission.
Draft navigation protects local edits, and real access withdrawal retires them.

## Alternatives

**Replace the draft whenever detail refreshes.** This would erase local choices
while background synchronization is running and conceal a concurrent edit.

**Replay a complete set after an unknown result.** The original write may have
committed; replay could overwrite a later edit and cannot establish the first
outcome. Reconciliation reads current state instead.

## Consequences

The picker can preserve off-page choices without storing the entire catalog.
Users must compare and explicitly adopt a newer version after a conflict. An
independent catalog creation remains even if the association edit is cancelled.
