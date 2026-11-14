# Agent Note: GitHub Connection Settings

Status: implemented

## Problem

Project members need to understand synchronization health, and administrators need to manage a repository connection without losing edits or confusing an uncertain write with a confirmed result.

## Decision

Project settings present connection, separately saved synchronization intent, and polling and Webhook observations. Members read the setting; administrators change it through a separate request, using the observed version and sharing the Project management guard with other management operations. The switch shows the confirmed value while a write is pending. Conflicts and unconfirmed writes retain drafts and the original page owner and hold the guard until an admitted read reconciles the state or the scope ends, without replay. Administrators can disable synchronization or disconnect an existing binding even when App access or configuration is unavailable. The [Web design](../../../../docs/design/daynight-web.md#项目执行提醒设置) describes the admission and presentation boundaries.

## Alternatives

**Embed GitHub state in Project settings.** Connection and synchronization observations have independent versions and update lifetimes; coupling them to the execution threshold would mix unrelated writes and invalidate drafts unnecessarily.

**Combine the synchronization switch with interval saving.** A switch action would also submit an unrelated unsaved interval draft. Independent writes preserve the administrator's separate intent and prevent an accidental configuration change.

## Consequences

Members can see retained status while only administrators manage the connection and synchronization. A first connection verifies access but does not enable synchronization; reconnecting an unavailable binding preserves its saved intent. The [synchronization setting decision](../architecture/2026-11-14-project-github-sync-setting.md) records the default-off setting and stop guarantee. Disabled synchronization retains PR reading and historical channel observations; errors from an earlier attempt do not describe an active failure. Private repository facts are shared according to Project access.
