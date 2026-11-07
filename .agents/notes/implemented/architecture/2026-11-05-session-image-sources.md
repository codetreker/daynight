# Agent Note: Image sources become authorized immutable snapshots

Status: implemented

## Problem

A path or URL in message text neither proves an image occurrence nor grants
access to its target. Loading it again can reveal another account's data or
silently replace historical content. Streaming Markdown can also change an
apparent image into code, and path or DNS checks can race the eventual read.

## Decision

The adopted [source design](../../../../docs/design/session-image-sources.md)
publishes AST-based source discovery, durable original-position registration,
platform handle-based local reads, a credential-free public-network transport,
and immutable first-success snapshots. This implemented note records the
published design decision, not completed runtime implementation or security
acceptance.

The Controller waits for trusted completed Markdown before first source IO,
then registers the original occurrence with the service before reading. Full
text and version-bound UTF-16 bindings preserve Markdown context. Removed or
rewritten images remain in the original entry's retained-image container,
including late committed captures.

Local sources use a verified document directory or Session cwd without expanding
the export roots. The opener retains authorized directory/file handles instead
of reopening a checked pathname. External HTTP(S) uses a separate HTTP/1.1
transport, validates every DNS answer and redirect, connects only to an approved
IP, and sends no account credentials. Successful bytes are saved in the service;
all later reads use that immutable resource.

Source retry is one operation on an already-registered occurrence. Unknown
captures are observed under their original identity. Only a confirmed failed,
never-committed local/external source with released reservation may be prepared
again; saved resources are never refreshed through retry.

## Alternatives

**Scan paths or image-looking strings with regular expressions.** Such scans
read code and ordinary links while missing reference definitions and Markdown
escaping. A shared AST with exact text offsets preserves syntax and authorization.

**Let the browser load file, relative or external src values.** Browser paths do
not identify Controller files, and direct external loads introduce credentials,
CORS, mixed-content and historical-content dependencies. Only verified saved
bytes enter the browser image element.

**Split Markdown into text and image fragments.** Fragmentation loses shared
definitions, list/table context and linked-image semantics. Full text plus exact
bindings keeps the document intact while the image reader remains controlled.

**Read as soon as streaming syntax appears closed.** A later fence or definition
can change its meaning. Waiting for trusted completion delays initial display
but avoids irreversible IO for text that ultimately is not an image.

**Check realpath and then call ordinary open.** The final path or an intermediate
directory can change between operations. Handle-relative traversal costs native
platform code and race tests but preserves the checked object boundary.

**Use a general service URL proxy or fetch only at archive time.** A proxy adds
a second network execution and authorization surface. Delayed fetching cannot
recover an earlier version after a source changes or disappears. Controller
capture reuses the existing trusted occurrence and bounded byte pipeline.

**Refresh a saved image when a read fails.** This can replace historical bytes
without a new occurrence and conceal storage damage. A new source version needs
an explicit new occurrence; corruption remains a visible read failure.

## Consequences

The design adds platform opener, parser-version, network-policy and retained
metadata maintenance. Network address checks need deployment egress guarantees
where transparent routing could map public destinations into private networks.
Without equivalent isolation, external capture stays disabled.

Permission is checked throughout preparation and exported-block delivery, but
already-lawfully-delivered bytes cannot be remotely erased. Local file checks
detect ordinary concurrent modification without claiming transactional snapshots
or isolation from malicious processes sharing the same OS identity.

Completed snapshots survive source changes and Controller shutdown. Unknown
commits retain pins and original identity; they cannot be turned into archive
partial success. Retained bindings and withdrawn containers consume admission
budgets and stay part of authorization, deletion and archive closure.

Private-network sources, authenticated fetching, arbitrary files and refreshing
existing history remain separate capabilities. Future extensions must retain
opaque authority, immutable resource identity and explicit source operations
rather than treating a path, URL or digest as permission.
