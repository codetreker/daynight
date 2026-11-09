# Agent Note: Worker and Bot canonical reads

Status: implemented

## Problem

Worker and Bot list queries interpreted stored JSON as if every read were a new
untrusted write. Recursive shape checks, case-folded field lookup and projection
byte guards repeated JSON semantics in SQL, including fields absent from the
Worker summary. Bot page admission also queried and authorized successive
candidates and repeatedly encoded the growing response. These mechanisms added
work to ordinary canonical records and made SQL, Go decoding and protocol
accounting jointly responsible for the same stored representation. Client
single-response caps smaller than their aggregate transport budgets could also
reject ordinary count-based Bot pages containing valid persisted definitions.

The original [encoded response decision](../architecture/2026-11-07-encoded-response-budgets.md)
addressed a real distinction between row counts and encoded bytes, including
records predating write limits. Its Worker summary projection also protected
lists from transporting complete telemetry and task payloads. That projection
remains useful independently of validating every stored JSON field.

## Decision

Write ingress owns structure, fields, normalization and existing capacity rules,
including internal producers and conditions checked inside write transactions.
Worker and Bot domain reads trust the canonical stored representation and use
ordinary scanning, JSON decoding and response serialization. They add no stored
field validation, capacity review, domain response-byte admission, historical
compatibility, historical scan or migration. Removed read budgets do not become
new write quotas. Natural decode, encode, cancellation and persistence errors
retain their causes.

Worker lists use one `limit+1` summary query. It projects canonical machine,
platform and observation fields, converts task references to UUIDs, and joins
current undeleted Tasks and the shared project-access relation to count visible
saved observations. It excludes complete telemetry and task payloads. The DAO
returns `WorkerSummaryPage{Items,HasMore}`; the service derives the continuation
from the last returned item. Account ownership, the inclusive 72-hour window,
creation-order cursor, unavailable null count and current visibility remain.
Details decode one full snapshot and apply the same visibility rules.

Bot REST lists use `List` or `ListWorker`; MCP lists use the same `List`.
Authorization occurs once within the domain list snapshot, followed by the
ordinary `Bots` page query and `scanBot` JSON decoding. Scope, deletion filtering,
complete response fields and count-based cursors remain. SQL JSON emulators,
read-byte guards and candidate measurement callbacks are absent. The shared MCP
entry retains its independent result limits; they do not cause Bot candidate
queries or byte-based page slicing.

Bot clients preserve their existing aggregate transport budgets while allowing
one count-based page to use the remaining budget. Worker Bot inventory reads
use 64 MiB for both a response and the complete operation. CLI `bot list` uses
`DEFAULT_OPERATION_LIMITS.totalBytes`, 256 MiB, as its response limit through the
existing runtime options; its aggregate limit remains 256 MiB. Both retain
100-item pages. Other CLI commands keep their defaults, and deadlines,
cancellation, identity checks and whole-list failure semantics remain. The
[Worker inventory design](../../../../docs/design/worker-bot-inventory.md#权威读取与对账)
and [CLI assistant design](../../../../docs/design/assistant.md#cli-管理与远端观测)
own these transport settings. They introduce no server read admission or quota.

The [Worker design](../../../../docs/design/daynight-worker-snapshots.md) and
[assistant design](../../../../docs/design/assistant.md#查询与授权) own these read
paths. This partially supersedes the encoded response decision for Worker/Bot
domain reads. Its other read budgets and Task write completion/admission
mechanisms remain. The [Bot fixture decision](../testing/2026-11-08-bot-projection-fixtures.md)
preserves the former guard tests' rationale; the
[Worker test decision](../testing/2026-11-08-worker-test-cost.md) owns the maintained
summary-result observation.

## Alternatives

**Reverse the entire encoded-response change.** This would also discard write
response admission and completion-fact fixes, restore earlier read validation,
and remove useful Worker summary projection. It would not preserve the chosen
write/read responsibility split.

**Disable PostgreSQL JIT.** This avoids compiling the expanded expressions but
retains their recursive JSON interpretation, repeated candidate queries and
protocol measurement. It leaves the query complexity and duplicate semantics
in ordinary reads.

**Keep canonical summary projection and ordinary Bot reads.** This is the
selected approach. It keeps Worker lists independent of full payload transport
and preserves authorization and pagination while removing the SQL interpreter
and read-admission machinery responsible for ordinary request overhead.

## Consequences

Worker summaries keep a bounded row count and compact result projection. Bot
pages use one candidate query and ordinary decoding rather than per-item
admission. Neither domain promises a response-byte bound or interprets arbitrary
historical database contents. Write limits continue to protect accepted input;
there is no new aggregate storage quota. Client response bytes still count
against their unchanged aggregate transport budgets; a later page failure does
not publish a partial CLI list or permit Worker inventory absence reconciliation.

Tests observe canonical field output, current visibility, pagination and natural
error propagation. Worker result metadata permits the projected observation-time
JSON scalar while excluding full JSON payloads and individual-record queries.
Former Bot stored-row alias and encoded-guard fixtures no longer define a
production read requirement. Performance evidence must compare the same normal
fixtures and PostgreSQL settings; removing query machinery alone does not imply
a particular hosted request or CI duration.
