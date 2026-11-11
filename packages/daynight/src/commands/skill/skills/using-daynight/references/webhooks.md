# Webhooks

Configure outbound Webhooks, inspect delivery history or recover an original
configuration operation. Writes also require [write safety](write-safety.md).

## Owners and versions

```bash
daynight webhook catalog --json
daynight webhook list --personal --json
daynight webhook show <endpoint-id> --personal --json
daynight webhook create --personal --file ./endpoint.json --confirm --json
daynight webhook update <endpoint-id> --team <team-id> --if-version <version> --file ./patch.json --confirm --json
daynight webhook subscription reconfirm <endpoint-id> --personal --if-version <version> --project <project-id> --confirm
```

Except catalog, every leaf requires exactly one explicit owner: `--personal`
for the authenticated User or `--team <team-id>` for a Team UUID. Neither Git nor
the default Team selects it; `--team personal` is invalid here. Catalog supplies
registered events/service limits; leaf help lists complete options.

IDs are canonical UUIDs. All writes except create require the endpoint
configuration version through [`--if-version`](write-safety.md#decisions-and-versions);
redelivery also requires its delivery generation through `--if-generation`.
There is no implicit latest-version read.

## JSON input

Create/update/subscription replacement require exactly one `--file` or `--stdin`.
Use strict UTF-8 JSON with no duplicate/unknown keys, at most 32 nesting levels
and 256 KiB; the final request also has a 256 KiB limit. Put URLs and adapter
configuration in JSON. Noninteractive/stdin writes require `--confirm`;
interactive confirmation shows safe scope/version details, never input/secrets.

For `endpoint.json`, replace the Project UUID and receiver URL with authorized
targets:

```json
{
  "name": "Task notifications",
  "enabled": true,
  "destination": {
    "kind": "http",
    "adapterVersion": "1",
    "configuration": {
      "url": "https://receiver.example/hook"
    }
  },
  "subscriptions": [
    {
      "id": null,
      "projectId": "11111111-1111-4111-8111-111111111111",
      "eventTypes": ["task.created", "task.status_changed"]
    }
  ]
}
```

| Input | Rules |
| --- | --- |
| Create | All four top-level fields are required. Destination requires kind `"http"`, adapterVersion `"1"`, and configuration with only an HTTPS `url`. |
| Events | Each subscription explicitly selects a Project and a nonempty, duplicate-free event array: task.created, task.status_changed, task.paused, task.deleted, task.step_updated or task.thread_posted. Never infer all-Projects scope. |
| Update | Nonempty partial object using the same top-level keys; omitted fields stay unchanged. `{"enabled":false}` disables the endpoint. Supplied destination must include complete kind/adapterVersion/configuration; supplied subscriptions replace the entire array. |
| Subscription replace | Reads the array directly, without an object wrapper. Each item requires id, projectId and eventTypes. |

New subscriptions use id:null. Retained IDs must be read, unique and kept with
the same Project; changing Project requires a new id:null item. Omitted entries
are removed; an empty array removes all. Deleting/re-adding creates a new
identity. Read and retain every intended entry. Renewed Project eligibility
requires explicit subscription reconfirm; restored access alone is insufficient.

## Operation identity and recovery

```bash
daynight webhook operation show <operation-id> --personal --json
```

A write uses one operation ID and original issued time: supply both
`--operation-id`/`--issued-at`, or let the CLI generate them after confirmation.
`--operation-out <path>` exclusively creates a private prepared record before
sending: identity, scope, versions and request hash, never body/secrets. This
private-file creation is unavailable on Windows and fails before sending.
Unknown outcomes retain the original identity for operation show; missing
receipts or matching current values prove neither rollback nor success.

Resume explicitly with `--resume-operation <path>` on the original write leaf,
keeping owner, targets, versions, mode and input. It conflicts with explicit
operation-id/issued-at and operation-out. The CLI verifies the record/exact
request hash before reading the receipt. A matching receipt confirms the
original operation without another write only while unexpired by the local clock.

A missing receipt permits at most one identical submission only with complete original
input, explicit `--confirm`, and issued time at most five minutes past or sixty
seconds future. Inaccessible receipts or expired admission windows remain
unknown. Prepared records cannot reconstruct the body. Confirmed operations
survive local rendering, output or cleanup failure; explicit resume is not
automatic retry.

## Read deliveries and payloads

```bash
daynight webhook secret show <endpoint-id> --personal --reveal
daynight webhook delivery list <endpoint-id> --personal --json
daynight webhook delivery payload <endpoint-id> <delivery-id> --personal --output ./payload.json
daynight webhook delivery redeliver <endpoint-id> <delivery-id> --personal --if-version <version> --if-generation <generation> --confirm
```

Endpoint list validates all pages before output. Delivery/attempt history returns
one page, `--limit` 1–100 (default 50); pass returned cursors explicitly with
`--cursor`. Retention can leave history incomplete. Secret show exposes metadata
unless `--reveal` is explicit; rotation never reveals the new secret. Redelivery
success confirms registration, not delivery.

Payload defaults to exact original bytes without added LF. `--json` returns the validated
Base64 wrapper; `--output` publishes a new private file without overwriting.
These options conflict. File publication requires Linux with procfs/glibc;
the service separately enforces payload authorization and retention.
