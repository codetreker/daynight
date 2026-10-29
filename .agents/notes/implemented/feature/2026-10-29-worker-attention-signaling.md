# Agent Note: Worker Attention Signaling

Status: implemented

## Problem

A background task can need a human decision while its agent is still working or
has ended its current turn. Execution phase and native idle/done observations do
not express that need. A browser cannot highlight it consistently, and routine
continuation prompts can restart the conversation while the decision is pending.

## Decision

A retained worker record has a required raw `signaling` string. Empty means no
attention signal; every nonempty value, including whitespace, requests human
attention. The task PATCH accepts only this nested worker field on an existing
record, with ordinary member access and the exact task version. A missing worker
is an input error. Worker identity remains protected, and PR, status and execution
updates preserve the signal. The CLI exposes the same operation through
`task update --worker-signaling`, including an explicit empty value for clearing.
The [property design](../../../../docs/design/daynight-task-properties.md) and
[claim protocol](../../../../docs/design/daynight-worker-claims.md) own the full
write and persistence contracts.

The central store derives the boolean `worker_needs_attention` from the same
typed properties and saves it atomically with every task write. Graph and sync
resources expose only `workerNeedsAttention`, keeping arbitrary-length signal
text in full task details. The migration adds empty signaling to retained claims
and initializes the projection without changing versions or timestamps. The
[persistent cache](../architecture/2026-10-24-persistent-task-summary-cache.md)
upgrades its schema and rebuilds old summaries rather than supplying missing
fields at read time.

Lists, chain children and graph nodes highlight **Needs attention / 需要处理**.
A collapsed chain retains an aggregate cue for its ordinary members; details
also render the original text. Display depends on the signal, without an extra
status, phase or automatic-execution-permission gate.

The execution driver checks the coordinator's latest remote inventory before a
routine ping. A nonempty signal suppresses pings while the agent works and after
it becomes idle or done; clearing it restores the existing patrol conditions.
Initial assignment, execution recovery and terminal cleanup retain their existing
owners. This partially supersedes the idle/done continuation eligibility in the
[patrol decision](../bug-fix/2026-10-27-worker-agent-patrol.md) and the blanket public
worker-PATCH restriction in the [claim foundation](../architecture/2026-10-24-worker-claim-foundation.md).

## Alternatives

**Write signaling through the owner-only execution-summary endpoint.** That
endpoint already fences progress by claim and owner, but attention is task
metadata that project members can set and clear. A narrowly typed public patch
preserves ownership protection without making other execution fields writable.

**Return raw signaling in every graph and sync summary.** Browsing needs only
presence. Carrying unbounded text would enlarge every poll and cached graph,
while full details already own the content. The boolean projection retains the
required browsing behavior without that repeated payload.

**Extract JSON properties during graph and sync reads.** Existing opaque PR and
signal strings may contain escaped NUL or Unicode sequences PostgreSQL JSON
extraction rejects. Reading and decoding every full property document in Go would
preserve those strings but load unrelated PR bodies on each poll. The atomically
maintained boolean keeps reads compact and leaves strict typed decoding with the
complete task resource.

## Consequences

One task version coordinates attention, metadata and execution updates; a stale
write cannot silently clear a newer signal. The store projection is a derived
column, so every maintained task-write path must use the central writer. Direct
SQL maintenance must preserve that derivation or rebuild it before serving data.

The signal prevents automatic continuation pings; it does not stop a native
process, change claim ownership or implement a human response conversation.
Those capabilities can be added independently while keeping attention separate
from lifecycle state. Signal text remains opaque, so no client may infer an
execution action from its contents.
