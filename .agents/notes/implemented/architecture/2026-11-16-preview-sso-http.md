# Agent Note: Explicit Browser Preview SSO

Status: implemented

## Problem

A separate preview credential needs a browser flow that establishes its Cookie,
proves the browser retained it, and returns to a validated target. A failed
exchange must remain recoverable without discarding the main-site session or
causing a redirect loop.

## Decision

Four explicit GET navigation endpoints implement the normal exchange using the
[identity operations](2026-11-16-preview-sso-identity.md). Preview start sets a
state-bound host-only Cookie; the main site authorizes its session Cookie; the
preview callback exchanges code/state for a Domain Cookie; completion requires
the browser to present that credential before returning the saved URL. The
[authentication design](../../../../docs/design/daynight-auth.md#显式浏览器预览-sso)
owns the protocol and configuration contract.
An explicit session-checked retry can replace a recoverable failed record; the
[Task preview decision](2026-11-16-task-preview-host.md) owns that recovery.

Host dispatch reserves the entire preview namespace before the main mux and
CORS policy. The exact bare preview host serves SSO. The [Task preview Host
decision](2026-11-16-task-preview-host.md) owns direct attachment reads on
canonical Task subdomains. The [default preview decision](2026-11-16-default-task-preview.md)
connects ordinary login to SSO and switches Web attachment readers.

Production uses separate same-site HTTPS hostnames. Explicit local HTTP fixtures
may use same-site DNS names or the same numeric loopback address on different
ports. Separate DNS browser checks own production Cookie semantics.

Container readiness probes connect to numeric loopback listener URLs and send
`Host: localhost` to select the main namespace. The public origin can therefore
use a different published port, even when an internal probe port equals the
preview origin port. The bare preview namespace still serves only SSO.

## Alternatives

**Use general API authentication.** It also accepts bearer credentials; granting
a browser credential requires the main-site session Cookie explicitly.

**Rewrite every socket fixture to DNS hosts.** Existing process, integration and
E2E clients would require shared resolver or proxy infrastructure. Distinct
loopback ports already provide distinct same-site HTTP origins for those tests.

**Serve health paths on a numeric preview origin.** That mixes internal probe
traffic with the preview namespace when their ports coincide. An explicit
loopback Host keeps the same namespace rule for DNS and numeric origins.

**Fall back to the main mux for unknown loopback ports.** That would also expose
main API routing through authorities reserved for preview. Probe authority is
selected by its actual caller without widening runtime dispatch.

**Return immediately after setting the Cookie.** The browser may reject it.
Completion detects this and displays an actionable error without restarting.

## Consequences

Preview origin configuration is required before deployment. Startup does not
probe external DNS/TLS. Deployment preserves Host and omits code/state queries
and credentials from access logs. Request IDs, phases and result categories
correlate safe diagnostics.

A rejected Cookie or consumed exchange can require new explicit SSO. A target
that can no longer be recovered falls back to the main projects entry.
Concurrent SSO and account switching retain the accepted possibility of
mismatched Cookies; no independent session or background synchronization exists.
