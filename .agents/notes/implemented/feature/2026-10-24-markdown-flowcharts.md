# Agent Note: Shared Markdown flowcharts use static SVG images

Status: implemented

## Problem

Task descriptions and Markdown attachments contain process diagrams whose nodes,
arrows and branches are difficult to follow as source alone. The same document
can appear in Overview, an embedded attachment preview or an independent reader.
Rendering must preserve those readers' resource ownership and content safety,
keep malformed diagrams local, and remain readable in narrow panels. A diagram
that waits indefinitely on a resource must not prevent later diagrams from
rendering after a document or task switch.

## Decision

The existing `MarkdownContent` renderer recognizes `mermaid` fenced blocks at its
`pre` renderer and delegates them to a shared asynchronous flowchart component.
Other fenced blocks retain normal code rendering. Descriptions and attachment
readers keep their existing URL bases, link activation and raw HTML escaping.
The [Markdown reading decision](../architecture/2026-10-22-task-description-markdown.md)
continues to own that composition.

Mermaid 12.2.0 loads only when a diagram is encountered. `flowchart` and `graph`
use strict security, text labels and the explicitly selected Dagre layout.
A version-scoped pnpm `packageExtensions` entry supplies `type-fest` 4.41.0:
Mermaid's shipped declarations import it, while its
[pinned package manifest](https://github.com/mermaid-js/mermaid/blob/1fb7869866dd619168d840291c9c54b4f129758b/packages/mermaid/package.json)
places it only in development dependencies. Declaring the missing dependency
keeps normal library type checking enabled. Reconsider this extension when a
Mermaid release declares the dependency correctly.

Source configuration directives and frontmatter are rejected so document text
cannot replace application security or palette settings. Application-owned
configuration initialization, semantic preflight and rendering share one
serialized operation; Mermaid's global configuration cannot race between
concurrently mounted blocks. Blocks are limited to 50,000 UTF-16 code units and
500 edges, with visible per-block errors and retained source on refusal.

Before drawing, `mermaid.mermaidAPI.getDiagramFromText` parses the source and
`FlowDB.getVertices()` exposes the actual vertices. A vertex with an image
resource or `imageSquare` type causes an explicit localized refusal and visible
source. The
[pinned image-node renderer](https://github.com/mermaid-js/mermaid/blob/1fb7869866dd619168d840291c9c54b4f129758b/packages/mermaid/src/rendering-util/rendering-elements/shapes/imageSquare.ts)
awaits browser `Image.decode()`, which a reader's abort signal cannot interrupt.
Refusing that path before render preserves later diagrams' availability without
changing the node/edge/branch reading requirements. Semantic inspection retains
ordinary shape metadata and literal `@{` labels, and uses the parser's decoded
metadata keys rather than a second YAML interpretation.

The preflight uses an exported API marked `@internal`, without a deep runtime
import. The pinned version and actual-parser tests bind its vertex structure and
image-node refusal behavior. A dependency upgrade must revalidate that boundary;
this cost is explicit rather than hidden behind an untyped shape assumption.

Each draw has a unique ID and measurable temporary container independent of
hidden detail tabs, and releases its staging DOM on success or failure. The
generated SVG is displayed as an inert image. The application neither inserts
that SVG into the reading DOM nor registers Mermaid's returned `bindFunctions`.
This limits executable behavior in the displayed result while keeping the
renderer's layout and label support. Mermaid still creates staging DOM, and
custom style resources may produce network requests. This decision does not
provide network isolation; ordinary Markdown images retain normal browser
resource behavior.

Each block owns loading/error presentation, source inspection and its image
resource. Source changes and unmount invalidate pending results before they can
change the current block; replaced or discarded image resources are released.
Errors do not replace the surrounding document or prevent other diagrams from
rendering. The current light palette matches the reader, and a focusable local
scroll region preserves readable natural dimensions without widening a 320px
page. Overview and the attachment body retain their vertical scroll ownership.

The included guarantee is independent diagram failure and continued rendering
across document/task switches. Image-node support is deferred with an explicit
refusal. Supporting it requires an interruptible isolated rendering context and
new ownership of its build entry, message protocol, CSP and resource lifecycle;
it is a rendering redesign, not an additional accepted syntax case. Keeping
this preflight before drawing and keeping result adoption tied to source and
mount lifetime preserves those guarantees while that capability is absent.

The [requirements](../../../../docs/spec/daynight-task-inspection.md#markdown-流程图)
own observable behavior; the
[design](../../../../docs/design/daynight-task-inspection.md#mermaid-流程图)
owns the component and rendering responsibilities.

## Alternatives

**Insert Mermaid SVG directly into the reading DOM.** Direct insertion retains
selectable SVG content and interactive bindings, but gives diagram markup a live
place in the application DOM. Static images meet process-reading needs without
exposing those interactions. Source remains available as ordinary code text.

**Run the engine in an isolated iframe.** A separate engine context could be
destroyed to interrupt unresolved work and would create a stronger separation
from the reading DOM. It also needs a new build entry, message protocol, CSP
policy and lifecycle owner. The required process diagrams can be delivered with
semantic image-node refusal; image support would justify reconsidering this
larger rendering structure.

**Race rendering against a timeout.** `Promise.race` can stop the caller from
waiting, but does not interrupt `Image.decode()` or terminate Mermaid's internal
work and shared state. Releasing only the application's queue would leave the
engine occupied or permit conflicting work. It cannot provide continued
rendering after a hung image node.

**Reject all modern metadata or match image syntax with a broad regex.** Such a
filter rejects useful shapes and literal `@{` labels, while metadata keys can be
escaped according to YAML syntax. Using Mermaid's parsed vertices keeps the
source grammar and the image-node policy in agreement.

**Build a flowchart parser and renderer in the Markdown view.** A custom renderer
would need its own grammar, branch labels, Chinese text measurement, routing and
error behavior. Mermaid already owns the syntax used by stored documents and
provides those layout mechanisms. Loading it on demand avoids requiring the
engine for ordinary Markdown.

**Render within the visible diagram element.** The detail composition retains
both tabs while hiding the inactive panel. Measuring a diagram there can yield
zero dimensions before that tab is selected. A separate measurable staging
container makes the result independent of its reader's current visibility.

## Consequences

The three reading entries share syntax, image presentation, errors and source
access without changing task or attachment storage. Static image output costs
SVG text selection and interactive diagram callbacks; source inspection remains
available, and task navigation stays with ordinary Markdown links. Image nodes
are visibly unsupported so their resource decoding cannot block later diagrams.
Ordinary shape metadata, nodes, arrows, branches and Chinese labels remain
available.

Lazy engine loading, serialized operations and semantic preflight add
asynchronous and dependency-version responsibilities. Blocks must handle
import/parser/render failures, stale results and image lifetime explicitly.
Large diagrams scroll locally rather than shrinking every label to fit the
panel. The full Mermaid dependency and its transitive packages must be kept
current; choosing Dagre avoids accidentally changing layout through the v12 ELK
default. Unit lifecycle checks, actual-parser policy checks and real browser
drawing/narrow-layout checks cover different parts of this mechanism. Adding
image nodes requires the isolated rendering redesign described above while
preserving the existing per-block availability and cleanup guarantees.
