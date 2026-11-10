# Tool launcher fixtures

The three `copilot` shims are unmodified output from npm's `cmd-shim` 8.0.0,
generated for a `#!/usr/bin/env node` entry at
`node_modules/@github/copilot/npm-loader.js`. Their complete text, including
all branches, establishes the accepted npm template. The adapter extracts the
target from the registered template's prefix and validates the complete rendered
template against the same bounded byte snapshot used for its digest. Filename
suffix selection is case-insensitive, including Windows `PATHEXT` results such
as `.CMD`.

The parser does not call `read-cmd-shim`: version 6.0.0 exposes only pathname-based
reads and selects its parser with case-sensitive suffixes. Using that API would
reopen the file without the adapter's file-type and byte limits, and reject
uppercase suffixes. No extraction code from that dependency is copied. The local
attributes preserve the official line endings and template whitespace on every
checkout platform.

The `codex-*.js` files are complete loaders from the official `@openai/codex`
npm releases 0.142.5, 0.145.0 and 0.156.1. All three choose a platform package's
`vendor/<target-triple>/bin/codex[.exe]`; only failure to resolve its manifest
uses the root package's `vendor` directory. The platform package directories
are npm aliases whose manifest name is `@openai/codex`. The fixtures remain
byte-for-byte copies so a different loader cannot silently inherit assumptions
about which native executable it launches. These OpenAI loaders use the
[Apache 2.0 license](APACHE-2.0.txt), with the original
[attribution notice](codex-NOTICE.txt). Both files are unchanged copies of
the upstream release files, which are identical in all three releases:

| Release | Source commit |
|---|---|
| 0.142.5 | [26de830](https://github.com/openai/codex/tree/26de83050b20f7e0ee211b9739e52ae00ce8032a) |
| 0.145.0 | [25af12f](https://github.com/openai/codex/tree/25af12f7e61572b0bc18ddb1008be543b91519b0) |
| 0.156.1 | [b412ff3](https://github.com/openai/codex/tree/b412ff32c417f855c2b2d1581b77058eed87c84b) |

The generated shim templates originate from npm's
[ISC-licensed cmd-shim](cmd-shim-LICENSE.txt).

Sources: [cmd-shim 8.0.0](https://www.npmjs.com/package/cmd-shim/v/8.0.0),
[read-cmd-shim 6.0.0](https://www.npmjs.com/package/read-cmd-shim/v/6.0.0),
[Codex 0.142.5](https://www.npmjs.com/package/@openai/codex/v/0.142.5),
[Codex 0.145.0](https://www.npmjs.com/package/@openai/codex/v/0.145.0),
[Codex 0.156.1](https://www.npmjs.com/package/@openai/codex/v/0.156.1).
