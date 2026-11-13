# Agent Note: Worker configuration diagnostic facts

Status: implemented

## Problem

A configuration exchange spans authority reads, local bootstrap preparation,
telemetry, report dispatch, receipt handling and durable checkpoints. Reporting
every failure as a read or a generic unavailable result hides the failing
operation. A confirmed remote response can also wait for local persistence after
its caller times out; describing that as an unknown request can encourage unsafe
replay. Repeated retries need useful progress without flooding logs or treating a
capped backoff position as the number of failures.

## Decision

Configuration diagnostics are a projection of facts supplied by the operation
that owns them. Typed tool and Operation errors, and explicit configuration file
boundaries, produce fixed reasons and permitted context. The source parser owns
a typed error for invalid YAML, top-level shape and pure local validation while
preserving its existing actionable message and cause. A controlled file-reader
wrapper identifies the original filesystem cause explicitly while retaining its
outer error chain. Project preparation requires Node's numeric errno, string
syscall and a known system code before using this evidence; a bare code does not
establish it. Local tool reasons
retain the original closed code; cloud application failures and monitoring keep
their existing vocabularies. Arbitrary error properties, messages and output do
not establish classification. Native arguments, commands, environment values and
credentials are excluded from configuration metadata.

The exchange and application owners emit the actual phase, while each sync and
capture preserves its source generation, exact baseline and report identity.
Item diagnostics distinguish their original generation, targetRevision and
recordId from the current authority source. Unread authority and a read null target
have different states, and a valid initial observation revision remains `"0"`.
An unread source can retain known cached counters without making them a current
authenticated service observation. The sync identity belongs to the original
receive or acknowledgement context frozen with its checkpoint, so its storage
retries and completion preserve the same association.
Known remote confirmation remains confirmed during a pending checkpoint or a
cancelled local wait. A configuration POST cancelled before its queued
transport dispatch remains not_sent, based on the actual mutation metadata;
a GET's absence of an unconfirmed-mutation flag cannot establish that fact.
Terminal principal authentication and permission refusals retain a failed
authority-read event with fixed local reasons, request association and the known
remote outcome without changing retry behavior. A received service target and
baseline are projected
separately from the operation's captured local source until its checkpoint
commits. Old-generation results may be locally ignored without
changing their known remote meaning. Logging neither acknowledges a failure nor
authorizes request or side-effect replay.

A receipt's observationAccepted remains separate from remote confirmation, so a
trusted HTTP success with a false application CAS is not logged as an application
acknowledgement. Checkpoint events retain their actual read, directory or persist
suboperation rather than treating every storage failure as a write.

Request correlation comes only from the actual typed ApiError. The response
X-Request-ID takes precedence; a parsed body ID is considered only when that
header is absent. A malformed body therefore cannot erase an already obtained
header identity. The selected ID must satisfy the existing bounded 64-character
ASCII token syntax. An invalid header is omitted without falling back to body
content, and arbitrary objects cannot supply this evidence. Shared exchange,
initial identity/configuration and management paths use the same projection;
this adds no DTO or dispatch behavior.

The diagnostic owner records the first failure, changed reason or related target,
and matching recovery immediately. Existing calls emit a summary at most every
five minutes for a continuing cause. Its signature uses the component, actual
phase, key, fixed reason and relevant target identity. Native targets use the
captured validation recipe: native tuple, actual execution mode and relevant
configured tool choices. A mode or choice change under the same canonical
revision is still a different target; its success does not recover an old
recipe's retained failure. Dynamic generation and selection keys are excluded.
The recipe remains internal comparison data and is never projected into JSONL.
Changing request, sync, time, count or retry scheduling fields does not create
another cause.
Actual occurrence counts belong to this run and remain distinct from capped
backoff steps. A new process starts a new diagnostic history.

The existing recoverable sink explicitly projects the metadata into JSONL and
applies credential redaction to every emitted string. Terminal events include a
compact projection of key, target, source, correlation, certainty and progress;
full record batches and classifier details stay in JSONL. Its fresh-segment recovery,
unknown append and undispatched omission semantics remain unchanged. Formatting
and notification failures retain independent error chains and do not rewrite
application or receipt results. The
[reporting design](../../../../docs/design/daynight-worker-reporting.md#失败与可观察性)
owns fields, filtering examples and verification. The
[canonical authority decision](2026-11-12-worker-configuration-canonical-authority.md)
owns source and capture lifetime, and the
[storage recovery decision](2026-11-12-worker-configuration-storage-recovery.md)
owns checkpoint and sink recovery. These diagnostics add no wire, database,
checkpoint schema or execution-admission mechanism.

## Alternatives

**Infer stages and causes at the reporter catch.** A final catch cannot reliably
distinguish preparation, collection, sending and acceptance, or reconstruct
whether the remote response was already known. Owner-supplied facts preserve
those distinctions without repeating the operation.

**Group by the complete event.** New request IDs, timestamps and retry deadlines
make every attempt appear different, defeating suppression. Grouping by cause and
target keeps correlation fields available without making them identity.

**Use the backoff step as a failure count.** The delay saturates at sixty seconds
while real failures continue; it cannot represent actual occurrences or a useful
recovery summary.

**Persist diagnostic counters or reconstruct them from JSONL.** Logs can omit
records or contain unknown partial appends. Treating them as a recovery ledger
would create another state owner without reliable replay or completeness.

## Consequences

Operators can correlate an original application or stop with authority changes,
a report and its local checkpoint while retaining remote result certainty.
Fixed projection reduces diagnostic detail deliberately; raw native output and
arguments remain unavailable through this channel. Failure groups occupy memory
for the current run and summary timing depends on existing calls rather than an
extra operation timer. Process restart resets counts, and missing records or an
older partial segment cannot prove absence, success or an exact loss total.
