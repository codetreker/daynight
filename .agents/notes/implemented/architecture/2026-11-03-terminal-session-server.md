# Agent Note: Terminal Session registration, control, and archival

Status: implemented

## Problem

Terminal execution needs the existing Session identity, permissions and history,
while its screen samples and native input cannot use timeline or provider-turn
semantics. A final zero-frame assertion alone cannot distinguish a legitimate
empty recording from missing selected content. Network retries, input loss and
native recovery must not create another owner or revoke a replacement connection.

## Decision

The shared registry dispatches by backend. Herdr stores its own typed state and
continuous run ledger, with task-before-session transaction ordering. Generation
grants and immutable finalization use the same row lock. A Worker channel advances
its polling and disconnect fence only after that transactional grant succeeds.
Recovery uses the native identity established by the validated prior run, including
an identity first learned in its stop proof. The frozen run binding remains intact;
requiring it to be rewritten or reconnected would prevent otherwise valid recovery.
Requests routed to another relay while the owning Worker is live fail explicitly
before changing leases or operation receipts. Local cache absence does not prove
the owning connection is lost; real heartbeat expiry and execution invalidation
retain their normal suspension rules.
Explicit v2 selection
preserves strict v1 producers, responses and historical files.

Recording responsibility belongs to the trusted Worker. The server registers its
identity and policy, retains monotonic evidence and freezes closed evidence before
accepting a final archive or unavailable receipt. Per-run file counts and source
digests must match. Downloads send the original stored bytes without JSON
re-encoding, preserving the receipt hash and length even for formatted JSON.
Missing responsibility, selected content or credible closure
cannot be reclassified as an empty successful recording. Journal hashes identify
local evidence; they do not independently prove the remote filesystem's history.

Control dispatch carries the authenticated actor and request digest. Durable ACK
must match the pending request and valid state transition before a lease becomes
usable. Input deduplication metadata survives restarts; raw pending input remains
bounded process memory. Unknown delivery is never replayed. One physical Worker
channel consumes each connection epoch; browser identity remains reserved through
release so old disconnect callbacks cannot revoke replacement connections.
Viewer cleanup also matches its captured claim, Worker connection epoch and relay
instance. A subscription ends on connection replacement rather than following it;
generation advancement on the same connection retains that viewer's cleanup duty.
Process-local browser reservations alone cannot fence a delayed callback after
another relay has taken over the Worker connection.
Preview entries expire by connection liveness, and pending input expires by its
durable operation deadline. Allocation reclaims expired entries independently of
archive success or credential validity; connection-fenced cleanup preserves newer
connections and valid pending writes.
Failed submissions and suspension callbacks cancel only their captured body
reservations. The transaction releases its row lock before cleanup, so operation
identity alone cannot distinguish a rolled-back write from a successful same-ID
retry.

See the [server design](../../../../docs/design/terminal-session-server.md) for
routes, authorization, state transitions and validation, and the
[shared protocol decision](2026-11-03-session-v2-terminal-contract.md) for wire
strictness and version ownership.

## Alternatives

**Server-authorized recording windows.** Persisting every recording responsibility
before local collection gives the server stronger evidence after local loss, but
requires network availability for opening new windows and adds a second recording
coordination mechanism. It does not back up the actual screen contents. Trusted
Worker journals preserve the established offline collection behavior.

**Defer unavailable receipts.** Retaining every zero-frame worktree would fail
closed but leave legitimate empty executions unable to clean up, consume resource
budgets and block later claims for the same task. This does not meet the complete
recording lifecycle requirement.

**Use realtime preview as recording evidence.** Viewer subscriptions and coalesced
frames omit unattended collection. Absence of a preview frame cannot establish an
empty recording, so previews remain a separate live projection.

## Consequences

The server can preserve original ownership and immutable results without taking
over native runtime or storing pending paste bodies. The Worker remains trusted
for local process observations and durable journal provenance; complete malicious
or externally rolled-back Worker state cannot be disproved by a hash alone.

Supplemental messages require explicit capability discovery. Existing v2 peers
that lack responsibility or correlated control ACK support remain gated. Actual
Worker journal, native adapter and browser implementation must be validated before
claiming combined Herdr functionality. Archive failure preserves resources and
never authorizes restarting an execution or silently deleting its evidence.
