# Agent Note: Responsive Session Footer

Status: implemented

## Problem

The shared Chatbox let individual controls determine wrapping through their
intrinsic widths. On narrow screens, Send could occupy a separate row despite
unused space beside settings, while activity, Interrupt and Send could consume
three more rows. The resulting composer displaced the timeline, including a
pending approval that required the user's response. Truncation on the entire
model button also hid its dropdown indicator, and the command trigger was too
narrow for reliable touch input.

## Decision

The default footer arranges three semantic groups: settings, activity status,
and primary actions. Interrupt shares an unbroken group with submission at the
bottom right. Container queries on the composer's inner surface choose the
number of group rows. Their thresholds use the actual inner width budget for
settings, buttons and gaps, rather than a prototype container width that includes
outer padding. Without visible activity or Interrupt, ordinary Send shares the
settings row from 234px. Longer pending, command or steer actions, and a visible
Interrupt even when status is hidden, keep a separate row until the full
single-row width is available. When status and
actions share a row, their width budgets preserve readable space for each; the
full row also reserves the settings group minimum. Long labels may wrap inside
their group or button without separating the actions or overlapping adjacent
controls. The thresholds and observable layout belong to the
[Session requirements](../../../../docs/spec/task-sessions.md#chatbox-设置命令与运行状态).
DOM order remains settings, status, Interrupt and submission.

Only the model text truncates. Its caret does not shrink, and the button retains
a minimum useful width. Coarse-pointer controls have a minimum height of 36px;
the command trigger also has a minimum width of 36px. The submit container keeps
ownership of the keyboard hint, so moving Interrupt beside it does not broaden
the hint's hover or focus trigger.

`SessionActivity` owns the timer, label and interrupt conditions. Its optional
render callback supplies the existing status and Interrupt nodes separately to
the default footer. The callback also runs when neither node is visible, keeping
submission mounted. Without the callback, activity retains its combined output.
The custom `renderFooter` presentation receives the original settings, combined
activity and submit slots, preserving that contract.

This replaces only the wrapping and interruption placement from the
[unified Chatbox decision](../../archived/bug-fix/2026-11-04-unified-session-chatbox.md). Its common
border, form ownership and panel lifecycle remain applicable. The
[Session design](../../../../docs/design/task-session-protocol.md) owns the
component and CSS mechanisms.

## Alternatives

**Retain individual flex wrapping with narrower controls.** This leaves row
selection dependent on model labels, pending-action labels and small width
changes. It does not keep Interrupt and submission together, and further
truncation would sacrifice the dropdown affordance or readable action text.

**Change the existing footer slot's activity contract.** Removing Interrupt from
that slot would require custom presentations to adopt a different control set.
The optional rendering callback gives the default layout separate nodes while
preserving custom presentations' existing ownership.

## Consequences

The default footer has at most three group rows in narrow containers and keeps
submission in a predictable position. Group rows can grow vertically for long
labels; the layout guarantees readable controls rather than a fixed pixel
height. Container geometry and actual Session pages must be checked alongside
operation and keyboard regression tests. Mobile viewport simulation does not
establish real-device keyboard behavior.

Session headers and outer page spacing remain separately owned. Attachment
input is deferred; the settings group remains an explicit place for
capability-dependent entries, but adding one requires rechecking its width
budget and thresholds. This avoids coupling future entries to activity or
submission without claiming arbitrary extra controls fit the current layout.
