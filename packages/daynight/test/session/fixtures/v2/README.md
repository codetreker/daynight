# Session v2 wire fixtures

`manifest.json` lists raw byte inputs and their required acceptance result.
`type: message` selects the v2 message decoder; `type: archive` selects the
terminal archive decoder. Both TypeScript and Go read these files directly.
Do not parse and reserialize inputs before validation: duplicate keys, invalid
UTF-8, surrogate escapes, original frame bytes and receipt digests are part of
the test subject. Negative JSON files may deliberately be invalid JSON.

`limits.json` binds both implementations to the same byte, count and timing
constants. All 129 raw manifest cases remain ordinary protocol tests, alongside
the real single-frame 256 KiB boundary. Test suites construct large exact/+1
cases in memory instead of committing multi-megabyte payloads; Go stress tags
and the CLI .stress.ts configuration select those cases only for explicit local
scale validation. The [development guide](../../../../../../docs/development.md#validation)
owns the commands and CI/local evidence distinction.

Valid examples include opaque `term_...` terminal IDs, nullable provider session
identity, native numeric pane IDs, full styled frames, manual control, stopped
generation ledgers, complete and partial archives, restart boundaries, explicit
unavailable runs and both terminal receipt dispositions. These are controlled
contract examples, not evidence of live Herdr input, process stopping or remote
archival. Existing v1 fixtures remain in the parent directory and continue to
exercise the unchanged v1 parsers.

The [contract design](../../../../../../docs/design/session-v2-contract.md)
defines the format and the difference between content hashes and the terminal
disposition digest. Changes to a positive frame body require its byte length and
SHA-256 to be recomputed; changes to a positive receipt require its disposition
digest to be recomputed. Keep intentionally inconsistent negative cases intact.
