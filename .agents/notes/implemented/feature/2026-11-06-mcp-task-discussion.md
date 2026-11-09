# Agent Note: MCP Task Discussion

Status: implemented

## Problem

Remote clients need to read and contribute to Task discussions without losing
message content, attribution, or the distinction between an observed message and
a confirmed submission receipt.

## Decision

The MCP discussion tools call the shared TaskThreads service and return its
complete encoded messages and pages. The service retains its transaction-scoped
credential and Project authorization checks, message write-byte limits, ordering
and reply validation. Reads preserve count pages and complete natural encoding
without stored-field or page-byte admission, as recorded in the
[ordinary resource-page decision](../simplification/2026-11-09-canonical-resource-pages.md). Thread write errors retain the store’s completion fact separately
from cleanup errors so the adapter can report a confirmed rollback. Agent attribution requires an explicit claim ID. A successful post
returns its confirmed message ID; an unknown outcome retains available references
and advises reading the thread without automatically repeating the submission.

## Alternatives

**Reimplement discussion writes in the adapter.** This would duplicate the
existing transaction, credential revalidation and outcome classification and
could diverge from the REST discussion contract.

**Infer a receipt from a matching message.** Equal text cannot identify a
submission; another participant or an earlier post may have produced it.

## Consequences

Clients receive complete messages in count-selected pages; message write
capacity remains independently enforced. Clients must retain their draft and decide explicitly how to proceed after
an unknown result; reading current messages cannot recover a lost receipt.
