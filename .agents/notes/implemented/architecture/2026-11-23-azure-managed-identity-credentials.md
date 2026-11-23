# Agent Note: Shared Azure Managed Identity Credentials

Status: implemented

## Problem

Azure services need a reusable managed identity credential without coupling
identity selection and token handling to a particular service's configuration,
endpoint, scope, or connection lifecycle.

## Decision

The Go Server's `internal/utils/azureidentity` constructs an Azure SDK
`azcore.TokenCredential` using `azidentity.NewManagedIdentityCredential`.
An empty client ID selects the host's system-assigned identity; a supplied
client ID selects that user-assigned identity. Construction and token errors
remain SDK errors. The SDK owns token acquisition and refresh, while callers
own service scopes, client assembly and credential reuse.

## Alternatives

**Build credentials separately in each integration.** This would duplicate identity
selection and its error handling across Blob and future Azure service clients.

**Implement token requests and refresh ourselves.** Managed identity endpoints
differ across hosting environments; the SDK already handles those differences
and token lifecycle behavior.

## Consequences

Callers depend on the pinned Azure Go SDK and must pass their own service scope.
Controlled endpoint tests cover selection and failure propagation; an authorized
Azure host and resource are still needed to verify deployment permissions.
