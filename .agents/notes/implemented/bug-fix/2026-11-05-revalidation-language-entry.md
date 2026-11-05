# Agent Note: Revalidation Language Entry

Status: implemented

## Problem

The blocking identity recovery overlay duplicates the page's global language
preference control and its storage feedback. The overlay still needs to present
localized errors and a usable account retry while protecting retained work.

## Decision

The revalidation overlay consumes the current `LocaleProvider` messages without
rendering a language selector or its preference feedback. The underlying page
retains its own entry and feedback. The native modal continues to isolate the
background, prevent Escape dismissal and attempt to restore focus to the connected
original element after recovery. Initial
identity loading and other independent authentication pages keep their entries.
This narrows the modal selector policy in the [authenticated workspace decision](../feature/2026-10-22-web-auth-workspace.md);
the [foreground identity decision](2026-10-23-silent-foreground-identity-checks.md)
continues to own recovery and request admission.

## Alternatives

**Keep a selector in the recovery overlay.** It allowed language changes while
the background was inert, but duplicated a global preference and its error
feedback in an identity recovery flow.

## Consequences

Recovery feedback follows application locale changes without restarting identity
checks or replacing retained business state. The page entry is unavailable while
the blocking modal is active; account retry remains available in the active
language. Other modal entries remain governed by their own delivery scope.
