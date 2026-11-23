# Agent Note: Read-only Goal Link in Task Detail

Status: implemented

## Problem

A Task reader needs to identify and open its actual Goal without the membership
editor occupying space above the detail tabs. The Goal's summary may be absent
or unavailable while the Task detail still contains its Parent identity.

## Decision

Task overview places a read-only Goal section before dependencies in the related
information aside. It links the detail's actual Parent to its typed Goal overview;
a readable Goal summary supplies its title and truncation indication, while the
Parent ID remains the fallback. No Parent is shown as plain empty-state text.
The link uses existing navigation and draft protection while retaining native
modified-click behavior. Other tabs do not mount the section. The
[requirements](../../../../docs/spec/daynight-task-inspection.md#独立完整任务详情)
own the display and navigation contract.

The earlier [Web Goal operations decision](../feature/2026-11-11-web-goal-operations.md)
retains the shared versioned membership operation; this decision replaced only
the Task detail editor. The [Goal Task entrance decision](2026-11-12-goal-task-entrances.md)
later removed the Goal detail creation and add-existing entrances.

## Alternatives

**Keep the Task detail membership editor.** It allowed removal or transfer from
that surface but occupied the heading and offered an editing action where the
reader needs a compact relationship link.

## Consequences

Task details no longer provide a membership change action. The link remains
usable when graph data is unavailable, but may show a UUID until a matching Goal
summary is available; it adds no parent fetch or cache owner.
