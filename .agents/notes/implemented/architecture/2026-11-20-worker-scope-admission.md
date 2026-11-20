# Agent Note: Worker report and inspection scope admission

Status: implemented

## Problem

Worker reports can import desired configuration and return existing targets, while
read-only discovery combines a machine producer with a separate user requester.
A single permission for these actions either grants configuration changes through
reporting or prevents legitimate producers and inspectors from working independently.
Prompt denial after a committed report must also preserve the report's result.

## Decision

Scoped Worker services use explicit current-authorization sources bound to their
existing snapshots and write transactions. Report admission requires reporting
permission and configuration exchanges also require read permission for the full
desired response. Core checks configuration permission only when the final locked
candidate changes desired state, covering initial bootstrap and independent tool
path adoption in typed and raw targets. Observation-only and unchanged exchanges
retain reporting semantics. Prompt authorization runs in the independent snapshot
after the report commits; denial becomes a per-selector error without exposing text
or replacing the committed native result.

Read-only Broker authorization has independent requester and producer callbacks.
Current PAT policy is read through the scope DAO after locking the active PAT in
the same identity transaction: the original validity query does not load policy.
Inspectors require inspect permission at dispatch, producer delivery and final
return; machine channels require report permission at their existing checks.
Requester denial affects its query, while producer denial closes the channel.
Session and fixed API OAuth restrictions remain in force.

The [internal design](../../../../docs/design/credential-scope-internal.md#worker-报告与检查准入)
owns the operation mapping and assembly requirements. Production uses scoped constructors and HTTP registrations with
transaction-bound authorization readers.
The [read-only channel decision](2026-11-06-worker-readonly-channel.md) retains the
connection, resource and timing rationale.

## Alternatives

**One shared Broker permission.** Requiring inspect permission from machine
producers would prevent report-only Workers from serving authorized inspectors.
Requiring report permission from requesters would grant unrelated execution-side
capability. Separate callbacks retain the existing recheck locations and effects.

**Authorize from submitted bootstrap fields.** A present bootstrap may already be
adopted, while an independent tool-path bootstrap can change desired state without
a full bootstrap. Comparing the final candidate inside the report transaction
matches the actual mutation and preserves atomic refusal.

**Use the validity query's token projection.** The existing active-PAT query omits
scope storage fields. Reading its policy as authoritative would reject all stored
PATs; the explicit locked scope read preserves the original validity protocol.

## Consequences

Report-only credentials can submit ordinary reports; full configuration receipts
need read permission, and actual imports additionally need configure permission.
Committed report results survive later Prompt refusal. Broker results cannot pass
a requester or producer scope removal at the existing delivery checks. Scope
checks do not create resource membership or alter the original profile limits.
Scoped service sources must preserve principal identity and transaction ownership;
production provides the bound readers for each supplied scope.
