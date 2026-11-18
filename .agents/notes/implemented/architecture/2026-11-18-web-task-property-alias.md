# Agent Note: Normalize task pause property aliases in Web

Status: implemented

## Problem

Task responses can represent the same execution pause with `paused`, `blocked`,
or both. Browser caches may retain any of these representations across a service
upgrade without a task version change. Comparing their raw properties would
mistake equivalent tasks or write receipts for conflicting data.

## Decision

Web validates both names as booleans and rejects conflicting values, then uses
the existing private `paused` representation for task details and summaries.
Other properties and the absence of the pause property remain intact. Detail
cache records are measured in their stored representation before decoding;
an access-time touch retains the original body and byte count together.
Web continues to send `paused` for the existing unpause action.

## Alternatives

**Compare both wire names throughout Web.** Carrying both representations into
every cache and receipt comparison would spread alias handling across consumers
and make same-version equality depend on which server produced a record.

## Consequences

Existing cache schema and epoch remain usable across the representation change.
Malformed or contradictory properties remain protocol errors. The service and
the later UI and write-key transition have their own delivery boundaries.
