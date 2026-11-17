# Agent Note: Windows Process Proof WMI Oracle

Status: implemented

## Problem

The independent Windows process proof test compares native identity with the
actual management provider's birth and complete command line. Its PowerShell
`Get-CimInstance` query can exceed the isolated sixty-second allowance without
returning output, failing the test even after native self, parent and inspection
proofs agree. The timeout does not identify which part of shell startup or the
provider query stalled.

## Decision

The independent format oracle queries `Win32_Process` through
`System.Management.ManagementObjectSearcher`, converts the provider's CIM birth
with `ManagementDateTimeConverter`, and transports UTF-8 JSON in the existing
ASCII Base64 envelope. It requires exactly one row and disposes its query
resources. Bounded diagnostics distinguish shell entry, assembly load and WMI
query completion without exposing the command line. The native proof and its
identity comparisons remain owned by the [native process proof decision](2026-11-05-windows-native-process-proof.md).

## Alternatives

**Extend the CIM cmdlet timeout.** The stalled command supplied no evidence of
how long a successful query would require. The direct WMI observer avoids the
cmdlet dependency while retaining the provider comparison.

**Replace the provider comparison with native-only assertions.** Native
self-capture and parent inspection share an implementation; they cannot alone
check compatibility with the independently produced persisted birth format.

## Consequences

The test retains a real provider comparison and its existing deadline and
cleanup obligations. Direct WMI still depends on the management provider and
can fail or stall; checkpoints preserve the observed stage if that happens.
