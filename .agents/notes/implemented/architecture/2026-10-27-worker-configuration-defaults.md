# Agent Note: Worker Configuration Defaults

Status: implemented

## Problem

The worker has defaults for its scheduling and native-agent settings, but
requiring a worker mapping and repository list prevents an authenticated user
from reaching startup without repeating otherwise optional configuration. A
missing worker section should not be confused with a malformed explicit value
or an unreadable configuration file.

## Decision

A genuinely missing shared configuration file, an omitted worker mapping or an
empty worker mapping selects the existing runtime defaults. An omitted
repository list means an empty list. Explicit configuration continues through
the same strict type, argument, path and repository checks. The reader handles
only MissingConfigurationFileError as absence and preserves other failures and
cancellation; defaults do not rewrite configuration or create resources.

This partially supersedes the mandatory configuration-presence rule of the
[foreground runtime](2026-10-27-foreground-worker-runtime.md). Its original
configuration model selected acquisition repositories and native-agent overrides
explicitly; those populated values remain meaningful. Defaults now allow the
existing retained-claim reconciliation path without a new acquisition list.
They do not discover repositories or replace an original execution's frozen
configuration. Authentication, claim ownership and native preflight remain
independent startup requirements.

## Alternatives

**Require an empty worker section and repository list.** This avoids changing
parsing but makes users spell out values whose default meaning is already
known, and fails before the normal authentication diagnostic when the file is
absent.

**Default every invalid or unreadable configuration to an empty mapping.** That
would conceal malformed settings, filesystem faults and cancelled reads. Only
omission has default-value semantics; explicit invalid input remains visible.

**Couple startup defaults to automatic repository discovery.** Discovery changes
repository ownership and selection, while this defect concerns configuration
presence. Keeping those responsibilities separate avoids adding network reads
or changing which tasks can be acquired merely to accept omitted settings.

## Consequences

Users can omit worker settings and still reach authentication and normal worker
startup. Without configured acquisition repositories, retained claims continue
to reconcile but no new repository candidates are selected. Parser and public
startup regressions distinguish omission from invalid input and verify that
reading defaults leaves the user's files unchanged.
