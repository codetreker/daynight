# Agent Note: Project scope pagination

Status: implemented

## Problem

A project can be accessible through its owner Team or a direct grant. A page of
all accessible projects cannot represent a selected Team or external shares
without filtering before pagination, and a continuation position alone cannot
identify the account and selection that produced it.

## Decision

The project list defaults to all accessible projects. A Team selection requires
membership in that Team and includes its projects; shared selects direct grants
whose owner Team does not include the principal. Membership admission and the
page query use one read snapshot. The database applies eligibility before the
keyset limit and lookahead. A missing or inaccessible Team is a not-found
refusal; operational failures remain errors.

Project cursors use a new kind and version 2, binding the canonical user and
all/team/shared selection, including the Team ID, to the position. The previous
project cursor is rejected. The cursor is not tamper-proof or an authorization credential; each request
checks access independently. Task and account-Worker cursors retain their own
versions. The [assignment decision](2026-11-03-task-assignment-foundation.md)
records why task cursors advanced independently.

## Alternatives

**Filter an all-accessible page in the client.** A page can contain fewer than
the requested matches while later matching projects remain unseen, and the
lookahead would describe the wrong set.

**Sign cursor contents.** A signing key would detect intentional changes, but
the list contract does not require tamper protection. Access is independently
checked on each request, avoiding a new key and its deployment lifecycle.

**Keep the original project cursor.** It does not bind the account or selection,
so reusing it for another list can skip eligible projects.

## Consequences

Existing discovery continues to traverse the complete accessible set. Team and
shared callers can paginate without a second list cache or a count query. The
new cursor invalidates outstanding older project cursors; pages remain separate
snapshots and are not an authorization credential. New CLI and Web scope
controls remain independent additions using the same API.
