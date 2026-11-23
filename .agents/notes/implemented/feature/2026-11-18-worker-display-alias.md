# Agent Note: Account-owned Worker display aliases

Status: implemented

## Problem

Reported hostnames do not necessarily help an account recognize multiple Workers.
Renaming the operating-system host is intrusive, and mutating stored execution
identities would change the meaning of historical claims.
Existing Worker consumers use exact response-field parsers.

## Decision

Workers retain an independent, account-owned nullable display alias and optimistic
version in server storage. Telemetry updates preserve both fields. List and detail
use aliases only for presentation and retain machine names and complete Worker IDs.
An explicit alias endpoint manages observed-version updates and null clearing.
Negotiated list/detail fields preserve exact responses for existing clients.
Task, Bot and project deletion consumers share account-scoped, Worker-ID-keyed
observations from the alias endpoint. Personal task and deletion previews negotiate
original claim identities separately, preserving strict legacy response shapes.
Current aliases have display semantics; recorded machine fields retain historical
execution semantics. In Simplified Chinese, shared task rows label a distinct
current name as an executor alias, distinguishing it from the claim or recorded
machine name while leaving the supplied name unchanged.
The detail title and alias trigger share a wrapping row before metadata. The
editor supplies its trigger through a header render callback while retaining one
draft and both focus references; the form remains separate below metadata. This
keeps placement in the page without splitting editor lifecycle ownership.
The [design](../../../../docs/design/worker-alias.md) owns validation, HTTP
negotiation, concurrency and editor recovery behavior.

## Alternatives

**Rename the reported machine.** This conflates editable presentation with machine
identity and lets the next old Worker report overwrite the user's name.

**Reuse execution configuration.** A display-only update would then share versions
and application acknowledgements with scheduling targets, introducing unnecessary
execution coupling and configuration conflicts.

**Add fields to every existing response.** Old strict clients reject otherwise
valid observations. Header negotiation avoids requiring a coordinated CLI rollout.

**Fetch each alias separately for the list.** This adds one request per card and
allows list names to come from observations different from the Worker snapshot.
Negotiated metadata travels with the existing snapshot instead.

**Use the recent Worker inventory for Task and Bot names.** That inventory only
covers recent reports and cannot resolve older completed claims. Consumers use
the existing account-owned alias endpoint, sharing reads and one polling lifetime
per Worker in an authenticated scope. Claim owner IDs gate these reads; negotiated
identity projections supply missing owner and Worker IDs without exposing aliases
belonging to another account. Current display names remain distinct from recorded
execution hostnames.

## Consequences

Names survive reports and restarts without changing claim or scheduling semantics.
Independent versions detect concurrent edits; unknown results require observation,
not automatic retry. Duplicate aliases remain valid and distinguishable by ID.
The schema and negotiated protocol introduce maintenance cost, and older services
remain readable without alias editing. The header callback couples the detail
layout to the editor composition, and the moved trigger owns explicit hidden,
focus and touch-size styling. Task, Bot and project deletion views resolve current
display metadata without rewriting historical claims. The shared observer retains
known names on transient failures and stops with its last consumer or account
scope. Batch renaming and scheduling labels remain outside this capability.
