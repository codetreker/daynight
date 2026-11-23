# Agent Note: Worker Monitoring Value Size

Status: implemented

## Problem

The scheduler phase and occupied capacity dominate the surrounding Worker
runtime monitoring information, although they are readings within the same cards.

## Decision

The two primary values in Worker detail monitoring select `--text-sm`. The
occupied label retains its existing size and weight. The [shared typography
standard](../../../../docs/spec/web-typography.md) owns the size scale.

## Alternatives

**Keep `xl` for the values.** This retains their disproportionate prominence
relative to the other readings in the cards.

## Consequences

Both values scale with the browser's root font preference. Card headings, other
readings, Worker list summaries and system metrics retain their own sizes.
