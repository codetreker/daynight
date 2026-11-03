# Agent Note: macOS Hosted Runner Capacity

Status: implemented

## Problem

A required macOS job failed to acquire a hosted runner before checkout or test
execution. GitHub reported runner acquisition failure and an arm64 capacity
advisory. The required gate therefore had no macOS validation result, even
though other platforms completed. Test deadlines cannot correct a failure that
precedes test execution.

The Intel runner then exposed a package-manager bootstrap failure before
workspace installation. The setup action's older bootstrap checked standalone
binary identity even when the JavaScript engine would run. Its self-update
returned without replacing that bootstrap because the project already declared
the requested pnpm version. This led to verification of an unpublished
Darwin x64 standalone package, rather than a missing application dependency.

## Decision

The [checks workflow](../../../../.github/workflows/checks.yml) selects the
standard `macos-26-intel` runner for its macOS lane. This preserves macOS 26 and
the complete native and installed CLI suites while selecting the Intel pool.
The [official standard runner table](https://github.com/github/docs/blob/9e46fa10eb2ed55c59bf6770a220477c91e1b3bf/data/reusables/actions/supported-github-runners.md)
and [runner image catalog](https://github.com/actions/runner-images/blob/a2d4955654f519bd5b559bffaea60d9f90156630/README.md#L19-L47)
list this label as a standard hosted runner. It requires no larger-runner
registration.

The native lane uses
[pnpm/action-setup v6.1.1](https://github.com/pnpm/action-setup/tree/73e46992e05b19abd31f2f3c20e0e7370d762115)
with the existing requested pnpm version, `11.28.6`. The action patch refreshes
its bootstrap to a version with engine-specific identity verification. Workspace
installation retains `--frozen-lockfile`; application dependencies and the
workspace lockfile retain their existing versions and integrity records.

The repository requires native Linux, macOS and Windows validation. It does not
require a particular macOS CPU architecture. This lane records Darwin x64
evidence; it does not establish Apple Silicon compatibility. Environment
receipts retain the actual OS, architecture, toolchain and tested source.

Linux, Windows, Node.js versions, test selection, deadlines, coverage thresholds
and required checks retain their existing settings. Ubuntu still builds the
packed artifact used by the runtime compatibility matrix. The
[development guide](../../../../docs/development.md) owns validation commands
and the native platform description.

## Alternatives

**Retain `macos-latest`.** The alias currently selects macOS 26 arm64, whose
runner acquisition failed. An unchanged retry would continue depending on the
same pool and would not change the acquisition conditions.

**Add a standalone binary record to the application lockfile.** The selected
JavaScript engine does not execute that binary, and the requested Darwin x64
standalone package is unpublished. The setup bootstrap requires correction;
inventing a package identity would misrepresent the dependency graph.

**Select `macos-15-intel`.** This is also a supported standard Intel label, but
changes the OS major version as well as the architecture. The macOS 26 label
preserves the current OS coverage.

## Consequences

The macOS lane has an explicit OS major version and architecture. Its image
continues receiving normal GitHub image updates. The full native CI must pass
on the selected runner before the configuration is accepted; catalog support
and dependency targets alone do not prove execution.

Intel capacity remains controlled by GitHub. A future acquisition failure must
be diagnosed from its native job annotations. An explicit Apple Silicon
validation requirement would need its own supported execution environment.
