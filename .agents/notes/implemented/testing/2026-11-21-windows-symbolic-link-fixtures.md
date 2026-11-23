# Agent Note: Windows Symbolic Link Fixtures

Status: implemented

## Problem

Creating a symbolic link on Windows requires `SeCreateSymbolicLinkPrivilege`,
which an ordinary account holds only under Developer Mode or elevation. Seven
worker tests build a symbolic link as part of their fixture, so on an
unprivileged developer machine they fail with
`EPERM: operation not permitted, symlink` before reaching any assertion. The
failure says nothing about the behavior under test; it reports that the fixture
could not be built.

Those same tests pass on the `windows-latest` runner, which does hold the
privilege, so the suite is green in CI and red locally. A developer running the
worker tests on Windows therefore cannot tell a real regression from this
standing noise, and the usual response — ignoring a known-bad list — hides the
next genuine failure in the same file.

Junction-based fixtures are unaffected: a junction needs no privilege, and the
tests that already pass `"junction"` on `win32` build theirs successfully.

## Decision

`test/helpers/symlink-support.ts` probes the capability once, by creating a
link in a temporary directory, and exports `skipWithoutSymbolicLinks`. The
seven fixtures consult it.

The probe treats only `EPERM` and `EACCES` as absence of the privilege; any
other error propagates, so a broken temporary directory surfaces as itself
rather than as a silently reduced suite.

`skipWithoutSymbolicLinks` is false whenever `CI` is set, regardless of the
probe. Coverage in CI is therefore identical to before this change: every one
of the seven runs on `windows-latest`, and a runner that lost the privilege
fails loudly instead of quietly skipping. The skip exists for the developer
machine alone.

Two of the seven are parameterized cases whose siblings need no symbolic link,
so those arrays drop the one affected case instead of skipping the whole set:
`duplicate-final-symlink` among the manual-alias kinds, and `symlink` among the
replaced-registration kinds. The remaining nine cases keep running locally.

`owned-source-directory.test.ts` bundled three unrelated claims in one test —
root deletion is refused, a symbolic link inside the source is refused, and only
the selected directory is removed. Skipping it would have taken the other two
claims with it, so the symbolic-link claim moved into its own test and only that
one is guarded.

## Alternatives

**Guard the fixtures with `process.platform === "win32"`.** The file already
uses that for cases that cannot apply to Windows, and it would turn the suite
green locally. It would also stop these seven running on `windows-latest`, where
they currently pass and where the behavior they cover — refusing to read through
a symbolic link — matters most. The obstacle is the privilege, not the platform.

**Require Developer Mode and document it.** This keeps the tests honest, but it
makes a first worker test run fail on a stock Windows install for a reason the
error does not explain, and enabling Developer Mode is a machine-wide change
some managed devices refuse.

**Create the links through junctions instead.** A junction substitutes for a
directory symbolic link, but not for the file links at two of the sites, and a
junction resolves differently from a symbolic link in exactly the traversal
checks these tests exercise. The fixtures would no longer build the condition
under test.

**Probe inside each test and return early.** This reports per test rather than
through the runner's skip list, so a skipped case looks like a passing one.
Vitest already distinguishes skipped from passed; the probe belongs where the
runner can read it.

**Leave the failures and track them as known.** Tried first and rejected: a
known-bad list has to be consulted by hand on every run, and it grows silently
whenever a new failure matches the pattern loosely enough.

## Consequences

The worker suite passes on an unprivileged Windows machine without a known-bad
list, and the seven tests still run unchanged in CI on every platform. A
developer who does enable Developer Mode runs them locally too, with no further
configuration: the probe succeeds and nothing is skipped. The cost is one extra
temporary-directory creation per test process on Windows, and one guard to keep
in mind when adding a fixture that builds a symbolic link.
