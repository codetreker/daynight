# Agent Note: Server Web Resource Ownership

Status: implemented

## Problem

Embedded frontend resources and HTTP response policy shared a package, coupling
file access to routing and making independent application assembly harder. The
build publisher and container also need to agree with the Go embed location.

## Decision

`service/webui` owns the embedded filesystem and resource reads, including
missing files, directories and I/O errors. `server/webui` registers the exact
page and asset routes and owns HTTP headers, cancellation and response errors.
The root server assembles these instances and applies the guard owned by
`server/attachment` before the mux.
The publisher and container place real Web output in `service/webui/dist`.

## Alternatives

**Keep resource reads and HTTP together.** This avoids a package boundary but
continues to tie resource preparation to the HTTP adapter and its assembly.

## Consequences

The adapter can be assembled with an independently created resource reader while
preserving the existing route and response behavior. The generated tree remains
ignored and must be prepared before compiling the Go service. Application-wide
resource lifecycle assembly remains outside this decision.
