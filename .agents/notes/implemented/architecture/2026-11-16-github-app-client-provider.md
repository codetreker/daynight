# Agent Note: GitHub App Client Resource Ownership

Status: implemented

## Problem

Independent GitHub Apps require isolated credentials and installation token caches. Replacing credentials or shutting down must not close a transport still used by an operation, while retaining every idle client would make resource use grow with the App population.

## Decision

The provider reads the current live credential snapshot for each borrow and shares a client only for the same local App and credential version. It tracks active borrows, retains at most 64 idle clients by least recent use, and closes retired transports after the last release. Shutdown stops new borrows, cancels pending reads, and drains active borrows within the caller's deadline; resources still in use remain owned until released. The [remote design](../../../../docs/design/github-app-remote.md) describes the caller's authorization and shutdown responsibilities.

## Alternatives

**Trust a cache hit without reading current credentials.** Another instance can change credentials or delete an App without notifying this process, so a cached version alone cannot establish that a new borrow uses the current snapshot.

**Close the transport immediately on replacement or timeout.** An existing borrower can still be using it. Waiting for release preserves resource ownership even when cleanup cannot finish before its deadline.

## Consequences

Teams using the same App can share its token source; different Apps and credential versions do not. Snapshot reads add a database operation per borrow and do not replace execution authorization or its database fence. The production runtime drains work before closing the provider.
