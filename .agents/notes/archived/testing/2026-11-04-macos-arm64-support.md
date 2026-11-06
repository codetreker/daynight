# Agent Note: macOS ARM64 Support and Native CI

Status: implemented

## Problem

A macOS runner change can keep the OS name while changing the machine
architecture and the runtime cost of the same suite. After the hosted lane
switched from ARM64 to Intel, the ordinary application tests slowed across the
suite and the required job exhausted its existing limit. The compared
[ARM64 run](https://github.com/codetreker/daynight/actions/runs/41697243084/job/126132778071)
and [Intel run](https://github.com/codetreker/daynight/actions/runs/41697903675/job/126141108988)
had the same ordinary test inventory. A single added test did not explain the
regression.

An earlier hosted ARM64 acquisition failure occurred before checkout. It
established a capacity problem for that attempt, not permanent unavailability
or an unsupported architecture; the later successful ARM64 run provides actual
execution evidence.

## Decision

Native macOS support is limited to Apple Silicon (ARM64). Intel macOS is
unsupported. The [client requirements](../../../../docs/spec/daynight.md#c1-包与平台)
own that platform boundary for CLI, Worker, Controller and Review.
At adoption, the [checks workflow](../../../../.github/workflows/checks.yml)
selected the standard `macos-26` runner for each native validation phase. The
[official image catalog](https://github.com/actions/runner-images/blob/a2d4955654f519bd5b559bffaea60d9f90156630/README.md#L32)
and [standard runner table](https://github.com/github/docs/blob/396218f23a6e3fa24d173ebfa74b3499adde67a3/data/reusables/actions/supported-github-runners.md#L83-L87)
identified it as macOS 26 ARM64, preserving the OS major version while restoring
the supported architecture without larger-runner registration. The later
[image availability decision](../../implemented/testing/2026-11-05-macos-ci-image-availability.md) replaces
that image selection with standard `macos-15` after repeated acquisition failure;
this ARM64 support boundary remains in effect.

Darwin ARM64 verification remains mandatory before native validation. The
[phase decision](2026-11-04-parallel-native-cli-validation.md) owns the original
parallel model; the [single-allocation decision](../../implemented/testing/2026-11-05-single-macos-native-allocation.md)
places the complete ordinary and installed macOS phases on one runner with
separate outcomes and evidence. The lane has no Intel
fallback.

This supersedes the Intel runner selection and architecture-independent support
premise in the [hosted capacity decision](2026-11-03-macos-hosted-runner-capacity.md).
Its pnpm setup bootstrap correction, supported executable-link preference,
case-owned preparation and bounded cleanup remain in effect. Linux and Windows
validation, application dependencies and native hook, callback and command
limits retain their existing settings. Each native validation phase retains a
10-minute bound; macOS shares a 20-minute allocation while Linux/Windows keep
independent jobs. Allocation changes affect preparation and scheduling costs.
Task-platform values remain OS enums.

## Alternatives

**Keep an Intel runner or use it after ARM64 acquisition failure.** Intel macOS
falls outside the supported platform policy. The native comparison also showed
suite-wide slowdown after that architecture change, so this fallback would not
preserve the intended validation environment.

**Increase test or job limits.** The regression followed a runner architecture
change with an unchanged ordinary test inventory. Increasing limits would retain
that unsupported environment and change the verification budget.

**Revert the bootstrap and fixture-lifecycle improvements.** Those changes fix
independent package-manager bootstrap, repeated shim work and cleanup ownership
problems. Reverting them does not restore the supported runner architecture.

## Consequences

macOS native validation requires ARM64 evidence on the explicit image selected
by the [image availability decision](../../implemented/testing/2026-11-05-macos-ci-image-availability.md).
Hosted ARM64 capacity is still controlled by GitHub; acquisition failures must
be diagnosed from actual job annotations without substituting Intel execution.
Runner catalog support and historical success do not establish source-bound
whole-suite execution. Native validation receipts retain the actual OS,
architecture, toolchain and tested source.
