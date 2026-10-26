# Agent Note: Authenticated daily setup guide

Status: implemented

## Problem

People opening the Web workspace need a discoverable path from browsing the
product to connecting their local CLI and Agent to a repository. The steps span
terminal commands, browser authorization and Agent instructions, so their
execution location, prerequisites and observable success need to remain clear.
The same material must remain useful for later reference.

## Decision

A book icon and visible Setup guide link before the header language selector open
an authenticated `/setup` page. Five expanded steps cover CLI installation,
device login, repository project discovery or creation, Agent skill installation
and registering and viewing a first task. The existing shell owns identity,
login return, navigation, history, title and breadcrumb. Typed English and
Simplified Chinese catalogs own the guide's text.

The guide is static content shipped with the Web build. It displays the current
origin as information and uses the published CLI's normal production-default
login flow. It reads no credentials, projects, tasks, tokens or completion state.
Normal shell identity verification remains active. CLI, project discovery and
skill installation keep their existing owners and are not reimplemented in the
page.

Command blocks render and copy the same complete strings, including real
newlines. A synchronous guard permits one current copy operation, disables the
copy controls while it is pending and reports success or manual-copy recovery in
a floating status message without moving content. Locale changes and unmount
invalidate stale clipboard results. Commands remain selectable when clipboard
access fails.

The Go page allowlist includes exact `/setup` GET/HEAD with the existing HTML
cache policy, method rejection and logs. Callback validation reserves `/setup`
and descendants before route registration. A conflicting existing deployment
must choose a different callback and update its exact UniAuth registration; an
invalid configuration cannot reach a duplicate ServeMux registration.

The [Web requirements](../../../../docs/spec/daynight-web.md#日常使用引导) own
user-visible outcomes and verification. The
[Web design](../../../../docs/design/daynight-web.md#日常使用引导页) owns component
and request lifecycles. The [CLI device login decision](../architecture/2026-10-25-cli-device-login.md)
continues to own authorization and credential persistence.

## Alternatives

**A stateful onboarding wizard.** Saving progress and detecting completed steps
would require additional state and observations of local tools or account data.
The guide must remain available for repeated reference, and there is no
requirement to hide completed steps. Expanded static instructions provide that
behavior without coupling the page to completion detection.

**Personal-token setup instructions.** The original interaction prototype used
manual token creation because that matched the published CLI at the time.
Published device authorization supplies the daily login flow now. Keeping both
flows would expose unnecessary credential handling and competing instructions.
The page teaches the current published command and leaves token management with
its existing account owner.

## Consequences

The guide introduces no business API, database format or completion record. It
continues to render during the shell's normal identity lifecycle and supports
direct links, refresh, history and narrow screens. CLI instruction changes must
be checked against the actually published version and synchronized with both
catalogs; the page does not probe a local CLI version at runtime.

Live completion tracking would require a separately designed observation and
privacy model. The current guide keeps instruction data separate from shell
identity and copy state so that such a change would not redefine authentication
or command semantics. Callback namespace reservation makes the new direct route
safe, with an explicit configuration change for deployments that previously
used that path.
