# Agent Note: Localhost runtime system CA certificates

Status: implemented

## Problem

The localhost runtime image lacked a system CA bundle, so the Go service could
not verify public HTTPS certificates when contacting the identity gateway.
Transport failures surfaced as unavailable identity providers even when the
gateway was reachable.

## Decision

The final Node 24 Bookworm slim stage installs Debian `ca-certificates` during
the image build and removes the package index. Build failures propagate. Go's
default transport uses the resulting system trust store for outbound HTTPS.
The image retains its nonroot identity and the Node and sharp helper required by
the [Session media decision](../architecture/2026-11-09-unified-session-media-core.md).

## Alternatives

**Mount the host CA bundle.** This makes trust depend on the host and deployment
mount configuration instead of delivering the required trust store in the image.

**Change the Go TLS configuration.** Disabling verification would remove the
server authentication guarantee; a custom root pool would add application-owned
trust configuration for certificates already covered by the system store.

## Consequences

The build requires access to Debian package repositories, and rebuilding updates
the trust store according to the package available at build time. Certificate
verification remains enabled. Identity application and callback configuration
remain separate requirements for successful login.
