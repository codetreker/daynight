# Agent Note: Ordinary subtask version compatibility

Status: implemented

## Problem

The ordinary subtask protocol crosses independently upgraded Server, Web, CLI,
MCP and Worker clients. A same-revision product journey cannot establish whether
an older client retains its existing behavior or whether a newer client makes a
recognizable, non-destructive request to an older service. Migration and recovery
also need the real previous ledger and its associated attachment storage.

## Decision

The separate subtask compatibility entry binds its runs to full source revisions
and the integrity of the historical CLI package. It builds and records the
selected Server and Web artifacts, then uses isolated product environments and a
same-origin TLS gateway to exercise the client and Server combinations. The
gateway allows the old and new Web bundles to share an origin without replacing
the product API. The recovery case retains the database and attachment storage
across the old and candidate services and records its own resource ownership and
cleanup outcome. Its host control client opens the private run directory and
connects through its short `/proc/self/fd` path, retaining that descriptor until
the exchange finishes. The socket remains in the same private directory used
by the container. Compatibility Workers use the dedicated container boundary in
the [Worker fixture decision](2026-11-24-compat-worker-container.md).

The [product E2E decision](2026-11-08-self-contained-product-e2e.md) owns the
normal same-revision runtime and authentication fixture. Version compatibility
uses the same product and authentication boundaries while keeping the additional
matrix and recovery work in its explicit entry.

## Alternatives

**Use only the normal product journey.** Building all components from one source
revision would not exercise the independent client and Server combinations.

**Use controlled API responses as the compatibility result.** Module fixtures
can test protocol boundaries but cannot establish the interaction between the
actual historical artifacts, authentication, browser cache and persistent data.

**Connect to the control socket by its absolute checkout path.** Linux limits
Unix socket address length, so a valid private directory under a long checkout
path cannot be addressed that way even though the container can bind it.

## Consequences

The matrix requires multiple builds and isolated runtime resources. A result is
bound to its recorded sources and artifacts; it does not establish support for
unexamined historical versions. Failed or interrupted runs retain any
unconfirmed ownership evidence instead of treating absent observations as a
confirmed cleanup. An unconfirmed cleanup stops the matrix before another
combination starts, preserving the original run for reconciliation.

The recovery manifest probe compiles the source revision's production checksum
registry. Sources with the 099 baseline include the frozen historical checksums;
older sources calculate checksums from their executable migrations. The receipt
binds each generated probe and ordered manifest to the source fingerprint. A
baseline predating 099 is rejected because the current Server requires the 099
upgrade bridge. Historical numbering gaps are retained rather than filled.
