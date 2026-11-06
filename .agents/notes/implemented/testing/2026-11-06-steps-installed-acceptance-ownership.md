# Agent Note: Steps Installed Acceptance Ownership

Status: implemented

## Problem

Installed Steps acceptance exercised the complete read and write matrices through
both package launchers, although both launchers resolve to the same CLI entry.
It also repeated the same missing-title rejection under broken configuration in
two files. The decision sought installed-package evidence for native launcher
behavior, argument forwarding, request contracts and failure recovery.

## Decision

The initial decision assigned the complete installed Steps business matrices to
the `daynight` launcher and kept representative native successes and errors for
`dn`. The Add test sent the same complex, separate arguments through both
launchers and compared their request bodies and complete receipts. It also owned
the missing-title rejection for both launchers, including the unchanged broken
configuration and absence of requests. Windows used installed `.cmd` launchers.

The matrices covered explicit and discovered versions, exact routes and fields,
receipts, refusals, unknown outcomes and correlated observations. The
[shared installed CLI preparation](../../archived/testing/2026-11-04-shared-installed-cli-preparation.md)
continues to own one pack and installation and independent consumer views.
The [CLI artifact validation boundary](2026-11-06-cli-artifact-validation-boundary.md)
supersedes the installed business-matrix ownership while retaining a native
launcher argument-forwarding check.

## Alternatives

**Keep both complete matrices.** This repeats the same application behavior
through launchers that resolve to the same entry, increasing native process cost.

**Run the business matrix only and rely on package metadata for the alias.**
Metadata cannot prove that the generated native launcher forwards arguments or
handles success and error execution, especially on Windows.

## Consequences

The consolidation reduced CLI process starts while preserving the original
application-level matrices and explicit launcher equivalence evidence. Changes
to launcher generation or argument handling still require native validation on
each supported platform.
