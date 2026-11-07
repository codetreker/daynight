# Webhook management

Use `daynight webhook --help` and each leaf's help for command syntax. Both
`daynight` and `dn` expose catalog, endpoint, subscription, secret, delivery,
attempt and operation commands. Every leaf except `catalog` requires exactly
one explicit owner: `--personal` is the authenticated User; `--team <team-id>`
is a canonical Team UUID. Neither Git context nor the default Team selects an
owner. `--team personal` is not a personal Webhook owner.

Read the current endpoint before deciding a versioned change. Except for create,
writes require the exact positive decimal int64 `--if-version`; redelivery also
requires `--if-generation`. Do not round versions, infer a latest version or
blindly retry conflicts. Create, update and subscription replace require exactly
one `--file` or `--stdin`; input is strict UTF-8 JSON, without duplicate or
unknown keys, up to 32 levels and 256 KiB. The final request is also limited to
256 KiB. Supply URL and adapter configuration in the input, never in arguments.
Use `--confirm` for noninteractive and stdin writes; interactive confirmation
shows only safe scope and version details.

Supply `--operation-id` and `--issued-at` together or let the CLI generate them
after confirmation. `--operation-out <path>` creates a private, exclusive
prepared record before submission. It stores identity, scope, versions and the
request hash, not the body or secrets. Ordinary writes are not automatically
replayed. Unknown outcomes retain the original identity; use `webhook operation
show` to inspect its receipt. A missing receipt or matching current resource
does not prove rollback or success.

To resume, use `--resume-operation <path>` on the original write leaf and supply
the same owner, targets, versions, mode and original input. The CLI checks the
record and exact request hash before reading the receipt. A matching receipt
confirms the original operation without writing again. A missing receipt allows
at most one identical submission only with complete input, `--confirm` and an
issued time within the original admission window: five minutes in the past or
sixty seconds in the future. Inaccessible receipts and expired windows leave the
outcome unknown. The record alone cannot reconstruct a request body. A confirmed
write remains confirmed if local rendering, output or cleanup fails.

Endpoint list validates all pages before output. Delivery and attempt history
return one page, with `--limit` 1–100 (default 50) and explicit `--cursor`
continuation; retention can leave history incomplete. Secret show returns
metadata unless `--reveal` is explicit; rotation does not reveal the new secret.
Redelivery success confirms registration, not delivery. Payload defaults to the
exact bytes without LF; `--json` returns the validated Base64 wrapper, while
`--output` publishes a private file without overwriting an existing target. File
publication requires Linux with procfs. The two options are mutually exclusive. Payload authorization and retention are
enforced separately by the service.
