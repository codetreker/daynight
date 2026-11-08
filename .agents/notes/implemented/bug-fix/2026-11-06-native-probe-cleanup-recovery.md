# Agent Note: Native Probe Recovery After Original Cleanup Confirmation

Status: implemented

## Problem

A bounded native metadata probe can exhaust its cleanup wait before the original
child and its output streams close. Treating that historical timeout as permanent
uncertainty leaves a long-running Worker reporting the provider unavailable even
after cleanup finishes. Conversely, retrying without confirmation can create
another process tree while the first remains owned and unconfirmed.

The [archived assistant observation decision](../../archived/architecture/2026-11-04-worker-assistant-host-observations.md)
retained cleanup responsibility to prevent replacement after uncertain termination.
The original runner did not expose late confirmation to its consumers, so retaining
the failure protected that guarantee but could not distinguish later closure from
ongoing uncertainty. That safety rationale remains valid; permanent blocking after
reliable confirmation does not. This decision replaces that recovery limitation
without changing the archive or its other observation and admission decisions.

## Decision

The runner keeps historical cleanup classification separate from current cleanup
responsibility. Its private WeakMap associates each eligible cleanup error with
the original ChildProcess's existing close observation, including output-stream
closure. Only a close-wait timeout with no termination-call failure can later be
acknowledged. Exit alone, leader disappearance, termination failure followed by
close, and errors without the runner's confirmation handle remain insufficient.
Queries traverse cause and aggregate members without clearing another owner's
unconfirmed responsibility.

Each assistantHost provider retains its own failed command; versions independently
retains its own per-tool error and cache. On a normal collection after confirmation,
the owner removes only the corresponding barrier and stale failure cache, then
probes again within the existing budget. Confirmation restores eligibility, never
availability. A new failure remains observable and a new cleanup error has its own
confirmation identity. Reporter shutdown joins collection and evaluates remaining
responsibility, preserving mixed independent failures and diagnostic failures while
allowing acknowledged historical cleanup timeouts and its own cancellation wrappers
to stop blocking shutdown.

The [collection design](../../../../docs/design/daynight-worker-reporting.md#纯版本探测与环境)
owns the mechanism and lifecycle. The [reporting specification](../../../../docs/spec/daynight-worker-reporting.md)
owns observable recovery requirements; the [assistant design](../../../../docs/design/assistant.md#默认解析与偏好事务)
owns consumer admission. The
[runner implementation](https://github.com/codetreker/daynight/blob/cdb8f56a788aeb216f057255761df07983b103d9/packages/daynight/src/commands/worker/herdr/command.ts)
binds acknowledgement to the original command rather than a reusable PID or a
provider-wide flag.

## Alternatives

**Keep cleanup failures latched for the process lifetime.** This preserves safety
without a confirmation handle, but an acknowledged late close would still suppress
all later probes and misrepresent a recoverable environment as permanently unavailable.
It remains the conservative outcome when confirmation is absent or termination failed.

**Clear the cache or retry after elapsed time.** Neither cache expiry nor a delay
proves the original process and streams closed. Recreating the collector would
discard responsibility instead of resolving it. The original confirmation must
precede removal of the corresponding failure cache.

**Use another provider, a fresh collector, or an existing Bot's ready state.**
These observations concern other operations. They cannot acknowledge the blocked
command or establish that the selected provider can create a new assistant; automatic
provider substitution would also change the user's selection semantics.

**Suppress all historical cleanup errors during reporter shutdown.** This would
hide unconfirmed aggregate members, termination failures, errors from other cleanup
owners and independent failures. Shutdown evaluates the remaining responsibility
instead of dropping an entire error tree by its outer category.

## Consequences

Late reliable closure permits recovery without extending command deadlines,
adding polling processes or close listeners, changing single-flight scheduling,
or reviving cancelled work. Original errors remain private and diagnostics retain
their existing sanitization. Confirmation does not bypass current configuration,
directory, freshness or provider checks, and it does not replay input, replace
Sessions, change defaults or alter public DTOs and creation admission.

The state is process-local and tied to the original objects. A browser refresh
cannot update an already-running Worker or supply missing confirmation handles.
Upgrading and validating a running installation require separate evidence of the
actual runtime version, current Worker reports and successful assistant creation.
Controlled child events establish recovery transitions; successful read-only
commands establish only that those probes succeeded. Neither proves that an old
Worker recovered or establishes the original incident's timeout cause or exit time.
