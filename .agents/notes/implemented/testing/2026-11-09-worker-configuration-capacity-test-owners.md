# Agent Note: Worker Configuration Capacity Test Owners

Status: implemented

## Problem

Worker Configuration capacity HTTP tests execute real service and Core decisions
through DAO mocks and complete application construction. Parser admission,
configuration version changes, no-op behavior and observation writes are mixed
with HTTP arguments and responses. Moving only parsing assertions would lose
existing exact write arguments and unchanged-configuration observations.

## Decision

This decision partially supersedes the [root HTTP DAO boundary](2026-11-09-root-http-test-dao-ownership.md)
for the eight Configuration capacity cases. They share the narrow registered
Worker adapter, real credential middleware and strict operation fixture from the
[Report capacity decision](2026-11-09-worker-report-capacity-test-owners.md).
Normal configuration PUTs call PutConfiguration once; the normal observation
calls Report once with its complete exchange. Invalid inputs pass through actual
parsers and call neither business operation. Supplied results do not evolve from
captured writes. Private identity/cache headers remain checked; the observation
response additionally retains protocol version 1 and its complete receipt.

Core parser tests retain the original seven configuration and one observation
boundary pairs, including UTF-8 byte values, complete maximum collections and
all nullable observation fields. Observation identifiers are deliberately
nonmonotonic so unintended item sorting cannot preserve the expected order. Independent full expected values preserve the
original defaults: maxConcurrent 3, pollIntervalMs 60000 and recoveryLimit 0.

Core business tests execute PutConfiguration for every normal configuration
input. Changed values require revision 2 and exact full write arguments;
pollIntervalMs 60000 and the unchanged 128-project configuration retain revision
1 without a write or project reauthorization. ExchangeConfiguration retains the
maximum observation, exact observation revision and content, one observation
write, no desired write and the complete accepted receipt. Strict callbacks
supply independent current and returned facts. The
[configuration service decision](2026-11-09-worker-configuration-test-boundary.md)
owns direct Core binding and transaction coordination.

## Alternatives

**Keep complete application construction and DAO mocks.** This repeats unrelated
route and MCP schema preparation while leaving HTTP behavior dependent on lower
business decisions.

**Move only the input parser matrix.** Parsing cannot prove next revision,
unchanged configuration, skipped project admission or exact observation writes.
The business observations remain with actual Core operations and strict DAOs.

## Consequences

The Configuration capacity HTTP and receiving Core selections execute without
database or UniAuth fixtures. The existing thirteen Report capacity cases remain
in the same shared operation fixture. Assistant-host cases retain their existing
DAO fixture and separate responsibilities.

Performance comparisons include the receiving Core package and complete
validation. Matched semantic faults distinguish preserved detection from newly
precise call constraints; local package changes do not establish hosted savings.
