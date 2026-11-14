# Agent Note: GitHub Connection Settings

Status: implemented

## Problem

Project members need to understand synchronization health, and administrators need to manage a repository connection without losing edits or confusing an uncertain write with a confirmed result.

## Decision

Project settings present the independent GitHub resource and its polling and Webhook observations. Administrator mutations use the observed version and share the Project management guard. Conflicts and unconfirmed writes retain drafts and hold that guard until an admitted read reconciles the state or the scope ends, without replay. Administrators can disconnect an existing binding even when App access or configuration is unavailable. The [Web design](../../../../docs/design/daynight-web.md#项目执行提醒设置) describes the admission and presentation boundaries.

## Alternatives

**Embed GitHub state in Project settings.** Connection and synchronization observations have independent versions and update lifetimes; coupling them to the execution threshold would mix unrelated writes and invalidate drafts unnecessarily.

## Consequences

Members can see retained status while only administrators manage the connection. A successful connection verifies access but does not prove synchronization completed. Synchronization is a separate Project setting, as recorded in the [synchronization setting decision](../architecture/2026-11-14-project-github-sync-setting.md); independent channel failures remain visible. Private repository facts are shared according to Project access.
