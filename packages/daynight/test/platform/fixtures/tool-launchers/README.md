# Tool launcher fixtures

The three `copilot` shims are unmodified output from npm's `cmd-shim` 8.0.0,
generated for a `#!/usr/bin/env node` entry at
`node_modules/@github/copilot/npm-loader.js`. Their target is extracted from the
bounded byte snapshot also used for its digest. Filename suffix selection is
case-insensitive, including Windows `PATHEXT` results such as `.CMD`.

The parser adapts the target extraction rules of `read-cmd-shim` 6.0.0 without
using its pathname-based API, which would reopen the file without the adapter's
file-type and byte limits and uses case-sensitive suffixes. The local attributes
preserve the official line endings and template whitespace on every checkout
platform. The generated shims originate from npm's
[ISC-licensed cmd-shim](cmd-shim-LICENSE.txt).

Sources: [cmd-shim 8.0.0](https://www.npmjs.com/package/cmd-shim/v/8.0.0),
[read-cmd-shim 6.0.0](https://www.npmjs.com/package/read-cmd-shim/v/6.0.0).
