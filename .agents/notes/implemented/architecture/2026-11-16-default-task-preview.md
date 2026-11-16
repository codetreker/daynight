# Agent Note: Default Task-Origin Attachment Preview

Status: implemented

## Problem

Attachment HTML and scripts served from the application origin can access its DOM
and browser storage. A separate direct preview endpoint alone does not protect
users while Web and old links still open executable content on the main origin.
The switch must preserve relative resources, existing authorization and recovery
for sessions established before a preview credential exists.

## Decision

Web constructs preview URLs from the published preview origin and the Task or
Goal ID. Main-site preview GET redirects to that Task host on every main mux;
HEAD remains an authenticated main-site file check and downloads retain attachment
and nosniff. HTML, PDF, images and attachment-relative Markdown resources use the
Task origin. Files of one Task share an origin; different Tasks and the main
application do not. The [Task host decision](2026-11-16-task-preview-host.md)
owns host dispatch, credential checks and document error recovery.

After the ordinary login callback sets the main session Cookie, it saves the
existing completion target and starts the standard [preview SSO](2026-11-16-preview-sso-http.md).
The two credentials refer to the same session. Document navigation can recover
an absent preview Cookie through SSO; image failures offer explicit SSO in a new
tab and ordinary retry without replacing the reader. The [Markdown image
retry decision](../feature/2026-11-16-markdown-attachment-image-retry.md) owns
per-image state. Cross-origin frames do not bridge keyboard events; their identity
and established document lifecycle remain independent of that bridge. The ordinary
Vite development server injects its explicitly configured preview origin; missing
or unusable configuration fails at startup. Production builds leave metadata
injection to the Go shell.

## Alternatives

**Keep main-origin preview as a fallback.** An old link or old replica would still
execute uploaded scripts with application authority and defeat isolation. Redirect
all main mux GETs and coordinate rollout instead.

**Synchronize preview credentials in a frontend provider.** It adds state and a
request to normal reading and does not cover direct navigation. Standard browser
SSO and explicit image recovery cover these cases without a new synchronization API.

## Consequences

Relative resources and scripts continue to work within the Task origin, but
cross-origin frame keyboard shortcuts no longer control the parent. Concurrent
SSO and account switching can leave the two Cookies inconsistent; users can
recover with SSO, and this risk is accepted. DNS, TLS/SNI, Host forwarding and
SSO return must be verified before switching traffic. All replicas must be ready;
rollback retains an isolated build or first disables old main-site preview GET.
Startup does not prove external DNS or certificates.
