# Session v2 archive fixtures

`manifest.json` lists raw terminal archive inputs and their required acceptance
result. TypeScript and Go read the bytes directly to verify duplicate keys,
invalid encoding, frame bytes and archive integrity. Negative files may be
invalid JSON. The `valid-status*.json` files exercise the historical archive
status response.

`limits.json` binds both implementations to the same constants. Large exact-limit
and one-over-limit cases are constructed in memory. Changes to a positive frame
body require its byte length and SHA-256 to be recomputed. Keep intentionally
inconsistent negative cases intact.
