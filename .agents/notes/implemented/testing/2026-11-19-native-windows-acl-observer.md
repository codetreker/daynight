# Agent Note: Native Windows ACL Observer

Status: implemented

## Problem

The Session operation-store regression must independently inspect the real file
owner and DACL before adding an Everyone ACE and proving that the store refuses
it. A separate shell can exhaust its deadline before this observation starts.
In [Windows shard 1](https://github.com/codetreker/daynight/actions/runs/44448132233/job/135305294441)
at `43d6ba6d20e607a11491bf351657f6015b0c53c9`, the PowerShell readback reached
30,000 ms with no stdout, stderr or `script-start` checkpoint. That evidence
locates the failure before observed script entry but does not establish its
underlying scheduling or initialization cause.

## Decision

The test-only [Windows ACL observer](../../../../packages/daynight/test/helpers/windows-acl.ts)
uses the existing Koffi dependency to bind Win32 security APIs independently of
production code. It reads the current token's SID and the file's actual owner,
security descriptor and ACE. Assertions require current-user ownership, a
present protected non-null DACL, exactly one access-allowed ACE, zero inheritance
flags, FullControl mask `0x001f01ff`, and the current-user SID. The target uses a
namespaced path and a read-control handle.

The observer retains the TokenUser buffer through SID comparisons and releases
the token handle, file handle and allocated security descriptor on every exit.
Owner, DACL and ACE pointers borrow the descriptor allocation and are never freed
separately. Native errors preserve the failed stage and Win32 code;
`GetSecurityInfo` supplies its error code directly. Cleanup failures are exposed
and retain an original observation error when both occur.

The real icacls Everyone grant continues through the bounded command runner,
followed by production operation-store rejection. Its 30-second allowance remains;
the case guard covers that one command plus the existing margin. The
[earlier budget decision](2026-11-10-windows-session-acl-probe-budget.md) records
why the shell allowance originally grew, and the
[phase evidence decision](2026-11-18-windows-oracle-phase-evidence.md) explains
the checkpoints that distinguished this recurrence. The CIM oracle still uses
its existing PowerShell mechanism.

## Alternatives

**Increase the PowerShell allowance again.** The 10-to-30-second increase already
recurred without reaching script entry. A further increase preserves an extra
runtime initialization dependency without establishing a sufficient allowance.

**Call the production ACL verifier.** Reusing the verifier would couple creation
and observation to the same interpretation and allow a shared defect to satisfy
the regression. The observer owns its declarations, reads and assertions.

**Keep shell readback with phase diagnostics.** Diagnostics identified that script
entry had not been observed, but cannot make that dependency reliable. The
remaining external grant retains those command diagnostics.

## Consequences

Private ACL readback no longer starts PowerShell, while the actual disk DACL and
unsafe modification remain required evidence. Synthetic native-boundary tests
exercise unsafe ACL dimensions, failed acquisitions and cleanup error chains;
the Windows operation-store case supplies the real OS proof.

The test helper carries independent Win32 ABI declarations and resource lifetime
logic that must be maintained with its assertions. Its synchronous system calls
run in the test process and cannot be preempted by a JavaScript timer. Passing
native tests does not explain the historical PowerShell stall or prove the
separate CIM oracle reliable. Production ACL policy and CI gates are unchanged.
