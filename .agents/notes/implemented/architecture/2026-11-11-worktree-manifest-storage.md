# Agent Note: Durable worktree manifest storage

Status: implemented

## Problem

A worktree's owner and location need a durable, independently readable mapping
before allocation or conversion can depend on it. A visible file alone does not
prove that its contents and namespace links have passed their durability barriers,
and conflicting owner or location mappings cannot safely be treated as absence.

## Decision

The synchronous manifest store records exactly the version and five canonical
UUID fields in the Git common directory. It rejects malformed records and
conflicting worktree, claim, or directory identities. Publication prepares both
namespace directories and their parent links, flushes a temporary file, renames
it and flushes the containing directory. An identical visible record is reusable
only after its file and directory barriers succeed. Removal compares the full
expected record and retires only metadata. Inventory reads do not flush files.

The shared durable JSON and directory primitives live in platform modules. The
Worker continues to use its existing lock, physical identity and task directory;
the manifest store does not activate a format or convert existing resources.

## Alternatives

**Keep ownership only in Git locks and physical identity.** This couples owner
metadata to Git registration and persistent filesystem identity, which can be
lost or change independently of the resource's intended owner and location.

**Publish a content-addressed immutable object.** A separate hash and publication
protocol would duplicate the existing durable JSON mechanism without being needed
for semantic identity and controlled synchronous writers.

## Consequences

A failed barrier remains an error even if the record is visible, and a retry
can establish durability without overwriting a different record. The store relies
on the existing single-instance ownership and task gate rather than providing a
cross-process transaction. Windows retains the existing limitations of directory
synchronization. Adoption, conversion and retirement of the old ownership path
remain separate work; a manifest alone does not authorize checkout deletion.
