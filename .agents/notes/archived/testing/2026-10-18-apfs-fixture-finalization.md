# Agent Note: APFS Fixture Finalization

Status: implemented

## Problem

Native filesystem validation mounts both APFS variants to verify path identity.
An observed [macOS run](https://github.com/codetreker/day-night/actions/runs/39134580376)
passed the APFS assertions but failed its one-shot fixture detach with `Resource
busy`. That run captured no holder diagnostics, so neither the responsible
process nor a transient cause is established. Fixture finalization must release
its mounted resources while preserving native assertions and exposing failures.

## Decision

`test/fixtures/apfs-cleanup.ts` owns APFS fixture finalization. It retains at most
three ordinary detach attempts within one absolute 30-second budget, including
inspection, diagnostics and bounded pauses. The enclosing 40-second hook and CI
600-second test gate remain unchanged. The eight native filesystem assertions
continue to exercise both APFS variants.

The original finalizer used the mountpoint as its detach target and required
ordinary detach success before directory removal after attempted attachment.
The [disk-image ownership decision](../bug-fix/2026-10-20-apfs-device-ownership.md)
replaces that identity: cleanup retains the attached image's whole-device identity
and requires inspection proving that the exact fixture image is absent before
removing its directory. An uncertain attach result still requires that proof;
setup that never attempted attachment can remove its directory directly.

Only a failed detach whose C-locale stderr reports `Resource busy` permits another
attempt. Bounded holder and device diagnostics retain command status, stdout and
stderr. `lsof +f -- <mount>` selects the mounted filesystem without recursively
opening its files, as documented by the
[Apple lsof manual](https://github.com/apple-oss-distributions/lsof/blob/7a8a1b2a3c0f35c30a5fcd0927f31d441c3e5255/lsof/lsof.8#L722-L760).
The [controlled-holder observation decision](../bug-fix/2026-10-21-apfs-controlled-holder-observation.md)
limits that volume query to an acknowledged owned child when the native case
provides its PID, using `-a` to intersect process and filesystem selection. Generic
volume diagnostics keep the original query. An exit of 1 is not proof that no
holder exists. Busy results and diagnostics are
reported immediately as structured stderr records, including when a later detach
succeeds. Darwin's [unmount handling](https://github.com/apple-oss-distributions/DiskArbitration/blob/a542bda934211dc3c301bfdcc7f21349c4164a85/diskarbitrationd/DARequest.c#L1672-L1733)
likewise treats busy unmounts and holder investigation as distinct operations.

Unresolved detach failures, ownership or inspection errors and exhausted deadlines
fail finalization and retain the fixture. This is a test resource guarantee
required to preserve native validation; product behavior and native assertions
keep their existing acceptance criteria.

## Alternatives

**Force detach.** This can remove a filesystem still used by another process and
obscure the unresolved holder. Ordinary detach preserves the operating system's
busy refusal and makes a persistent conflict fail visibly.

**Repeat the unchanged suite after a finalization failure.** That provides no
new holder evidence and repeats product work whose assertions already passed.
Bounded finalization handles only the confirmed busy response within its existing
budget and records the information needed when it remains unresolved.

## Consequences

Successful assertions and successful fixture cleanup remain separate requirements.
The test gate stays red when complete image absence cannot be established, and
the fixture directory survives for inspection. Busy diagnostics remain visible
even when cleanup later succeeds; they support investigation without assigning
an unobserved holder or cause.

Deterministic cleanup tests cover busy recovery, persistent and non-busy failures,
diagnostic errors, deadline exhaustion and uncertain attachment. Native APFS tests
remain necessary to validate real filesystem behavior and finalization results.
