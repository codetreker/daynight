# Agent Note: CLI Portable Case Evidence

Status: implemented

## Problem

A portable file passing at least one test on Linux does not establish that
Linux executes every case removed from the macOS selection. Skipped, missing,
or ambiguously named cases can otherwise conceal lost coverage.

## Decision

The focused evidence verifier compares each portable file's passing macOS full
cases with passing Linux full cases from the same verified source and toolchain.
Case identity consists of the suite hierarchy and case title. Both reports must
contain a passing case in each portable file and must not repeat an identity,
including across different statuses. Linux may contain additional passing cases.
Existing native sentinels, discovery, report totals and platform comparisons
remain required.

## Alternatives

**Compare file-level success.** A passing file can still omit or skip individual
cases, so this cannot prove coverage transfer.

**Require identical platform reports.** Platform-specific skipped cases and
additional Linux cases need not match the macOS passing set; requiring equality
would reject evidence without improving the transfer proof.

## Consequences

Duplicate parameterized cases need distinct stable titles before their file can
be classified as portable. The verifier establishes case execution, not the
portable classification itself; the classification and source guards still
require review. Ordinary required workflow selection is unchanged.
