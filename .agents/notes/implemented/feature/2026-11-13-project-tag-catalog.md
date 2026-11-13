# Agent Note: Project Tag Catalog

Status: implemented

## Problem

Project members need stable tag identities and a shared catalog that can be managed without losing associations or exposing resources after project access is revoked. Concurrent deletion and association writes must not leave dangling references, and a catalog may be too large to read in one response.

## Decision

The tag service uses the project write lock for authorization, original version checks, catalog changes and association cleanup. Rename and deletion touch associated Task and Goal versions as a set; deletion removes all associations, including retained deleted resources. Reads authorize and obtain the catalog and visible usage in one snapshot. Catalog pages bind their cursor to the principal, project, query, limit and catalog epoch. Batch resolution refuses invalid identities and oversized encoded results instead of returning a partial set. MCP catalog tools call the same service with exact decimal version strings, explicit delete confirmation and bounded Control permits. They preserve transaction completion facts instead of retrying an unknown write. The [server design](../../../../docs/design/daynight-server.md#领域模型与存储结构) owns the implementation structure.

## Alternatives

**Store names on each association.** Rewriting copies on rename would increase write cost and permit identity and display names to diverge.

**Return only tag IDs on resource reads.** Consumers would need another lookup to display names and the existing Task version would no longer signal changed display content. Set-based touch preserves that signal without reading every Task body.

**Implement catalog rules in the MCP adapter.** Duplicating authorization, name validation and transaction rules would let the protocol disagree with REST and the shared service.

## Consequences

Catalog writes serialize with project association writes. Rename and deletion cost grows with the number of associated entries, but do not invalidate the project Task cache. Usage counts are snapshot hints rather than a deletion precondition; confirmation covers every association at commit. Tag version tracks identity and name, while catalog epoch tracks membership and ordering.
