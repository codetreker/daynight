# Agent Note: GitHub App Remote Reads

Status: implemented

## Problem

Project PR synchronization needs to verify actual repository access and read current GitHub facts without depending on an operator's GitHub identity or exposing service credentials. Repository names can change, remote pagination is not a snapshot, and upstream permission and rate-limit failures require different recovery.

## Decision

A server-configured GitHub App signs short-lived JWTs and obtains installation tokens scoped to pull request reads. The remote component caches tokens in memory per installation, follows same-origin pagination, and converts responses to shared observation models. Stable repository IDs identify renamed repositories; callers receive each page and retain responsibility for synchronization, state normalization, and persistence. The [remote design](../../../../docs/design/github-app-remote.md) owns the protocol and configuration contract.

## Alternatives

**Use each operator's OAuth identity.** This would add a user identity and role requirement to Project connection and couple ongoing synchronization to the operator's authorization lifecycle.

**Share a repository mirror across Projects.** A shared mirror introduces authorization and retention relationships between independently managed Projects. Separate synchronization may repeat remote reads but preserves Project isolation, as also recorded in the [storage decision](2026-11-13-project-github-pr-storage.md).

## Consequences

The component can verify App access without starting a runner or exposing a connection route. Tokens and remote bodies are not persisted by it. Callers must observe rate-limit recovery times, retain existing data on failure, and complete pagination before treating a traversal as successful; GitHub pages do not form an atomic snapshot.
