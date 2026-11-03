# Agent Note: Independent Session v2 Boundary Fixtures

Status: implemented

## Problem

The Go Session v2 recording-budget test must exercise a real 60 MiB archive and
its one-byte overflow with valid frame identities, lengths and hashes. Repeatedly
canonicalizing that content to construct the input adds four full serialization
passes before the decoder is exercised. Under race detection and atomic
coverage, this redundant work leaves little room inside the existing package
timeout. Using the production canonical serializer to choose its own boundary
input also weakens the independence of the size oracle.

## Decision

The recording-budget fixture sizes an unpadded, small `{files,index}` scaffold
with the standard JSON encoder. It adds planned ASCII spaces by byte count and
accounts for changes in the decimal width of each `byteLength`. It materializes
the padded frame strings and their actual hashes once, then checks the exact and
one-byte-overflow counts from actual data lengths before invoking the production
archive decoder. The overflow retains valid frame lengths and hashes and remains
inside the individual frame limit; its decoder failure must be `recording_limit`.

This size oracle accepts only the generated fixture's printable ASCII strings
without `<`, `>` or `&`. Its strings contain neither control characters nor
Unicode whose escaping differs between the standard and canonical encoders.
Quotes and backslashes have the same encoded length in both; each appended
space adds one byte. Hash replacements retain their fixed width. Small tests
check independent literal lengths, quote and backslash escaping, decimal-width
transitions, padding, unsafe text and invalid planned lengths.

The [contract design](../../../../docs/design/session-v2-contract.md) owns
canonical budgets and validation responsibilities. The
[terminal contract decision](../architecture/2026-11-03-session-v2-terminal-contract.md)
continues to own the wire format and production decoder responsibilities. The
fixture does not alter those decisions or replace canonical serialization for
untrusted content.

## Alternatives

**Encode the complete padded content with the standard JSON encoder.** This
avoids strict decoding but still allocates and scans tens of MiB repeatedly. It
requires the same escaping proof as the small scaffold without avoiding those
large intermediate values.

**Optimize production typed projection.** Validated values could avoid some
canonical encoding before typed decoding. This affects numeric equivalence,
embedded original frame text, error ordering and the native v1 adapter, and
requires broader differential verification. The existing separation between
strict parsing, canonical serialization and private projection permits that
optimization independently if future measurements justify it.

**Reduce boundary workloads or relax verification.** Smaller frame inventories,
skipped maximum cases, disabled race or coverage, and longer deadlines would
change the guarantees being tested. They do not address redundant fixture work.

## Consequences

Large inputs still pass through the real decoder at the original limits. The
100000-frame case and every existing exact/overflow case retain their workload.
The recording fixture no longer performs its four large canonical passes during
setup, while production canonical quotas, raw-byte hashes and strict validation
remain authoritative.

The independent oracle is deliberately restricted to this generated fixture.
Richer frame text requires revisiting its escaping proof; widening the accepted
character set without that proof would invalidate the boundary test. Runtime
measurements remain source-bound validation evidence rather than a permanent
performance promise in the wire contract.
