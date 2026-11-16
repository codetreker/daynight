# Agent Note: Task Preview Host

Status: implemented

## Problem

Executable attachment HTML needs a Task-scoped browser origin while retaining its
relative resources and the existing project authorization rules. A direct link
must recover from an expired preview credential without passing a long attachment
URL through every authentication redirect or treating subresource failures as
browser navigation.

## Decision

The preview namespace dispatches canonical single-label Task and Goal UUID hosts
to an attachment-only GET/HEAD mux. Host and path IDs must match, and the original
path guard runs before mux normalization. The handler authenticates the preview
Cookie and uses the existing attachment Open operation. Document responses carry
`Origin-Agent-Cluster: ?1`; bytes, MIME, inline disposition, no-store and relative
paths retain their attachment semantics.

For an unauthenticated document or iframe navigation, the server saves the
validated original URL in a short-lived SSO record and redirects with its short ID.
Completion confirms the Cookie before returning the original GET. Subresources,
fetch and HEAD retain non-HTML errors, while document errors preserve HTTP status
and provide visible retry. Error pages permit the configured preview subdomains as
frame ancestors so nested Task documents retain recovery actions. The [SSO HTTP decision](2026-11-16-preview-sso-http.md)
owns the credential exchange, and the [attachment design](../../../../docs/design/daynight-task-attachments.md#独立-task-预览-host)
owns dispatch and error behavior.

When a failed exchange still has a recoverable record, an explicit main-site
retry validates the current main-site session and the record's binding, then
atomically replaces the old record with a fresh short-lived record for the same
target. Unverifiable or expired records
do not expose the target and fall back to the main entry. No retry is automatic.

The main HTML shell publishes the configured preview origin as metadata. Existing
Web URLs and the main-site preview GET remain unchanged and continue to execute
trusted HTML on the main origin.

## Alternatives

**Put the complete target into each SSO redirect.** Nested encoding can exceed
the established query and request-target limits. Saving it once and transporting a
short record ID preserves the raw target and the existing admission boundaries.

**Prepare a preview through a frontend provider or synchronization API.** That
adds a separate readiness state and request to ordinary reads, and cannot recover
a direct browser navigation on its own. Standard navigation and the existing
session exchange cover both direct links and normal resource requests.

## Consequences

Distinct Task hosts provide browser origin separation for direct preview reads;
files of the same Task remain same-origin. Each request retains the existing
membership, resource and deletion checks. SSO failure can be retried without
revoking the main session; blocked Cookies stop at the completion error rather
than redirecting indefinitely. Concurrent SSO and account changes retain the
accepted possibility of different valid sessions across origins.

Deployment must provide bare and wildcard DNS, TLS/SNI and Host forwarding;
startup validates configuration but does not prove external reachability. Existing
main-site inline previews remain same-origin until their consumers and old entry
are switched, so this direct entry alone does not establish complete isolation.
