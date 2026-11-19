# Agent Note: Bot Server Takeover and Recoverable Authorization

Status: implemented

## Problem

A Bot outlives its hosting Worker and the PAT used to register its Session.
Requiring either original identity forever makes a same-machine Worker rebuild
unable to resume the assistant. Replacing only the grant does not invalidate an
already connected Controller, and a lost grant response leaves a caller unable
to distinguish committed authorization from a failed request.

## Decision

The independent recovery v1 API binds a private recovery identity to the service,
owner, Bot and reported machine. A current PAT authorizes registration and
recovery; an expired original PAT is not recovery evidence. Registration requires
an existing Bot Session and the original Worker. Subsequent operations use the
recovery proof and hosting generation, while legacy runtime writes refuse a
registered recovery Bot.

The Bot lock precedes the Session lock. Takeover advances current hosting,
invalidates the old connection, installs the new grant, and records the original
operation receipt in one PostgreSQL transaction. Frozen creation configuration,
platform Session, test execution and native identity retain their owners.
Current Worker identity lives in the recovery record; the old Bot definition and
management DTO keep their original Worker binding so strict existing clients
continue to read internally consistent frozen configuration.
Hosting generation is distinct from Controller execution generation. The latter
advances only through its existing previous-generation and stop-proof rules.

Clients generate and durably retain a fresh controller token before submitting a
grant operation. The database retains only its hash and a safe receipt. Exact
request replay returns the recorded result without another grant or generation;
operation queries never issue authorization. Every new token is checked against
all historical token hashes under the Bot lock, preventing an older authorization
from becoming usable again after intervening grants. A receipt is current only for its
selected hosting and, for grants, its unexpired hash and authenticated parent PAT.
Changing PATs requires a new explicit authorization operation.

The [assistant design](../../../../docs/design/assistant.md#bot-独立存储与接管能力)
owns the protocol and integration. This implements the server portion of the
[storage contract](2026-11-18-session-storage-contracts.md); Worker discovery,
local exclusivity and real Provider resume remain separate obligations.

## Alternatives

**Reuse the old Bot runtime runner.** It checks the old Worker and parent PAT,
which are precisely the identities that recovery must be able to replace.
Relaxing those checks would also admit legacy writes without a hosting fence.

**Persist recoverable server-generated grant secrets.** Recovering a lost grant
would require secret storage and its protection lifecycle. Pre-generated client
tokens allow the receipt to remain non-secret and keep private material with
the Worker that must already persist the original request.

**Rotate only the grant.** Existing Controller leases have their own parent
credential and remain live after ordinary grant renewal. Explicit disconnection
is required to reject delayed observations before the new connection synchronizes.

## Consequences

Recovery survives a Worker rebuild or replacement PAT without creating an empty
thread or changing ordinary Task and assistant-task claims. Old connections lose
server write authority immediately after commit, including same-Worker takeover.
Every recovery grant requires reconnection and synchronization before input.

The operation journal adds durable per-Bot metadata. Historical receipts are not
usable credentials, and successful server takeover cannot prove that a process
or external command stopped. The first recovery promise remains same-machine;
cross-machine restore and native Provider qualification need their own evidence.
