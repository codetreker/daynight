# Agent Note: Timeline visibility follows a SQLite commit pointer

Status: implemented

## Problem

A late native receipt can associate an already public image with its original
upload. The association, resource reference and actual timeline revision must
be visible together. Overwriting a content file before committing its SQLite
index exposes new content after rollback, while saving only a recovery plan
leaves consumers on an older revision. A process-local cache cannot coordinate
independent history, inspection and archive readers.

## Decision

The original implementation stored each entry revision in an immutable
candidate file. After the candidate was durable, the same SQLite transaction
committed its file pointer, identity, length and hashes with the source outbox.
Every reader used its own SQLite snapshot to select content. Directory scans
accounted for physical bytes and never published uncommitted candidates. The
[SQL activation decision](2026-11-12-session-sqlite-activation.md) replaces file
pointers with current body rows while retaining this atomic visibility rule.
The [resource ownership decision](2026-11-12-session-resource-files.md) separates
resource files from timeline storage while retaining its reference guard.

The named native input publication operation validates the original accepted
observation and canonical input. It applies the association to the current entry,
preserves public native slots and their capture state, and commits original
slots, references, occurrences and a receipt with the actual revision and source
sequence. The receipt is immutable; queries also return the current view, which
may have advanced through capture. Unknown outcomes query the same identity and
never authorize another native send. Capture still waits for the occurrence ACK.
A durable capture result interrupted before its timeline update is repaired at
that same image position on the current view, without registering or sending
again; ordinary receipt adoption does not publish another timeline event.

The named Markdown publication operation commits its projection state in the
same transaction as the current body and source outbox. Analysis and image
receipt state cannot advance independently of visible text. Native-only patches
may precede a Markdown state rebase; recovery reads the committed entry and
adopts only the same native image positions before publishing another Markdown
view. This preserves both completed analysis and late native image receipts
without guessing which body is newer. The
[source decision](2026-11-05-session-image-sources.md) owns that projection flow.

Journal v8 migrates only legacy content that exactly matches its SQL index.
Missing, unindexed or advanced legacy files cannot prove the committed snapshot;
migration refuses them while retaining the original database and files. Under
that format, new candidates left by rollback remain invisible. Old
committed candidates remain available to readers holding older WAL snapshots and
count against the physical metadata budget. The v10 transition imports only
committed pointers and uses a successful reader barrier before retiring files;
current-pointer checks alone do not prove the absence of an older reader.

This completes the atomic publication requirement in the
[provider decision](2026-11-05-session-image-providers.md) without introducing a
Provider resource store or changing native acceptance evidence.

## Alternatives

**Persist an intent and materialize it later.** This preserves recovery facts but
allows timeline, inspection and archive consumers to observe an accepted alias
without its original-image slots. Adopting that behavior would change the
required consistency guarantee and require an explicit unresolved-publication
barrier for reads, capture and archival.

**Wrap mutable file writes in a SQLite transaction.** SQLite cannot roll back a
file replacement. A callback transaction alone leaves the same inconsistent
consumer view after failure.

**Store canonical entry bodies in SQLite.** This makes atomicity direct, but
changes the existing separation of journal metadata and pending archive bodies,
along with budget, migration and reader ownership. Immutable candidates retain
the established content storage while giving SQLite authority over visibility.

**Delete superseded candidates immediately.** WAL readers can retain an earlier
pointer after a writer commits. Current-pointer checks, time delays and keeping
a fixed number of revisions cannot prove that all such readers finished.

## Consequences

An unresolved transaction quarantines the journal when rollback cannot finish.
Its own uncommitted rows cannot satisfy a recovery query; independent readers
retain the last committed snapshot. Cleanup closes owned processes and handles
without clearing the original writer identity or claiming a new commit.

File and SQL failure boundaries are explicit. A candidate can survive a failed
transaction without becoming history, and a lost commit response can be resolved
by the original publication identity. Hash, length and entry identity failures
remain visible instead of falling back to directory scanning or empty history.

Retaining candidates made physical metadata space grow even when logical history
remained small. This cost motivates current-row SQL storage. Migration still
counts retained and orphan files until reader-safe retirement; admission does not
delete possibly referenced content to make room. SQL WAL supplies the snapshot
lifetime for ordinary current-row updates. Native backend qualification and
visual acceptance remain separate from these local storage guarantees.
