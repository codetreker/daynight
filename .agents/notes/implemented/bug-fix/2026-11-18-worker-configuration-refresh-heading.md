# Agent Note: Keep Worker configuration refresh in the settings heading

Status: implemented

## Problem

An initialized Worker configuration places a single refresh button in a separate
row above the saved-source disclosure. This consumes vertical space before any
settings appear, particularly on narrow screens, without adding information.

## Decision

The existing refresh button shares the first Runtime settings panel heading.
The saved-source disclosure and notices retain their order before the settings
and their full content width. The button remains a non-submit action with the
same read admission, pending-save guard and refresh feedback. Independent initial,
uninitialized, unavailable and failure states keep their recovery actions.

The [Web design](../../../../docs/design/daynight-web.md#worker-云端配置编辑)
owns placement and the [configuration specification](../../../../docs/spec/daynight-worker-configuration.md#web-消费者)
owns observable behavior. The [source preservation decision](../architecture/2026-11-17-web-worker-configuration-source.md)
continues to own the response source and draft baseline.

## Alternatives

**Keep the separate refresh row.** The row provides no grouping benefit and
retains avoidable whitespace before the first editable setting.

**Place refresh beside the source disclosure.** This couples a configuration-wide
read action to optional diagnostic content and reduces the disclosure's available
width. The existing settings heading already groups configuration actions.

## Consequences

Initialized configurations reach the first settings sooner while retaining raw
source access, drafts and refresh semantics. Browser regression coverage measures
the compact gap, heading containment and readable normal/busy labels in both
languages at desktop and narrow widths, and checks that keyboard refresh reads
configuration without submitting the enclosing form.
