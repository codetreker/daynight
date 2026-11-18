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

## Consequences

Names survive reports and restarts without changing claim or scheduling semantics.
Independent versions detect concurrent edits; unknown results require observation,
not automatic retry. Duplicate aliases remain valid and distinguishable by ID.
The schema and negotiated protocol introduce maintenance cost, and older services
remain readable without alias editing. The header callback couples the detail
layout to the editor composition, and the moved trigger owns explicit hidden,
focus and touch-size styling. Alias propagation into task histories,
batch renaming and scheduling labels are outside this display-only capability.
