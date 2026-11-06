# Agent Note: Steps Installed Acceptance Ownership

Status: implemented

## Problem

Installed Steps acceptance exercised the complete read and write matrices through
both package launchers, although both launchers resolve to the same CLI entry.
It also repeated the same missing-title rejection under broken configuration in
two files. Native launcher behavior, argument forwarding, request contracts and
failure recovery still require installed-package evidence.

## Decision

The `daynight` launcher owns the complete installed Steps business matrices.
The `dn` launcher retains representative native successes across the operations
and error checks.
The Add test sends the same complex, separate arguments through both launchers
and compares their request bodies and complete receipts. It owns the missing-title
rejection for both launchers, including the unchanged broken configuration and
absence of requests. Windows uses the installed `.cmd` launchers.

The matrices retain explicit and discovered versions, exact routes and fields,
receipts, refusals, unknown outcomes and correlated observations. The existing
[shared installed CLI preparation](2026-11-04-shared-installed-cli-preparation.md)
continues to own one pack and installation and independent consumer views.

## Alternatives

**Keep both complete matrices.** This repeats the same application behavior
through launchers that resolve to the same entry, increasing native process cost.

**Run the business matrix only and rely on package metadata for the alias.**
Metadata cannot prove that the generated native launcher forwards arguments or
handles success and error execution, especially on Windows.

## Consequences

Installed acceptance starts fewer CLI processes while retaining complete
application-level checks and explicit launcher equivalence evidence. Launcher
checks sample operations rather than duplicating every error and recovery case;
changes to launcher generation or argument handling still require native
validation on each supported platform.
