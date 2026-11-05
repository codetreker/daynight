# Agent Note: Attachment Confirmation Language Entry

Status: implemented

## Problem

The attachment deletion confirmation duplicates the global language control and
its preference feedback inside a modal whose purpose is to confirm one file's
deletion. Additional copies tie the global entry to presentation layers and add
controls to an interaction that already needs clear focus and path inspection.

## Decision

The confirmation uses the shared current locale without rendering a language
selector, preference notice or save retry of its own. Existing page language
entries and their preference feedback remain in place. Locale updates still
translate the confirmation and its errors without changing the target, restarting
or duplicating an operation, or replacing attachment and preview state. Modal
isolation, focus containment, layered Escape and focus restoration continue to
follow the [attachment confirmation decision](../feature/2026-10-23-attachment-delete-confirmation.md).

This partially supersedes that decision's original selector placement. The
selector had allowed switching while the modal made the underlying page inert;
the confirmation now remains focused on deletion and the page retains its
existing entry. The [requirements](../../../../docs/spec/daynight-task-attachments.md#web-管理与预览)
and [design](../../../../docs/design/daynight-task-attachments.md#web-文件树与预览)
own the current interaction.

## Alternatives

**Keep a selector in the confirmation.** It permits changing the language while
the underlying page is inert, but duplicates a global entry and its preference
feedback in a file-deletion interaction.

## Consequences

The existing page entry remains available under its original layout and modal
isolation rules. The confirmation still responds to shared locale changes and
retains its target and request identity. Browser checks remain necessary for modal focus,
isolation and narrow long-path layouts; the attachment API and write semantics
are unchanged.
