# Agent Note: PAT Revoke Cancel Focus

Status: implemented

## Problem

Opening the PAT revocation confirmation focused its close control. Keyboard users
need a predictable, non-destructive initial action while retaining access to all
dialog controls and the original revocation entry.

## Decision

The PAT revocation dialog selects its cancel button through the existing
`ManagementDialog` initial-focus mechanism. The shared dialog retains focus
containment and restoration. The [authentication specification](../../../../docs/spec/daynight-auth.md)
owns the observable behavior.

## Alternatives

**Keep the default focus.** The default searches for a body input and falls back
to the close control in this text-only confirmation, leaving cancel unfocused.

## Consequences

Enter or Space on the initial focus cancels instead of submitting revocation.
The selection is local to PAT revocation and does not change other dialogs.
