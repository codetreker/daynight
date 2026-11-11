# Webhooks

Use this to configure outbound Webhooks, inspect delivery history or recover an
original configuration operation. For writes, also read
[write safety](write-safety.md).

## Owners and versions

```bash
daynight webhook catalog --json
daynight webhook list --personal --json
daynight webhook show <endpoint-id> --personal --json
daynight webhook create --personal --file ./endpoint.json --confirm --json
daynight webhook update <endpoint-id> --team <team-id> --if-version <version> --file ./patch.json --confirm --json
daynight webhook subscription reconfirm <endpoint-id> --personal --if-version <version> --project <project-id> --confirm
```

Every leaf except catalog requires exactly one explicit owner: `--personal` for
the authenticated User or `--team <team-id>` for a Team UUID. Git and the default
Team do not select an owner; `--team personal` is not a personal Webhook owner.
Use each leaf's `--help` for complete options. Catalog supplies registered events
and service limits.

IDs are canonical UUIDs. Except create, writes require the endpoint configuration
version through [`--if-version`](write-safety.md#decisions-and-versions);
redelivery also requires its delivery generation through `--if-generation`.
The CLI has no implicit latest-version read.

## JSON input

Create, update and subscription replacement take exactly one `--file` or
`--stdin`. Input must be strict UTF-8 JSON with no duplicate/unknown keys, no more
than 32 nesting levels and at most 256 KiB; the final request also has a 256 KiB
limit. Supply URLs and adapter configuration in this input. Use `--confirm` for
noninteractive and stdin writes; interactive confirmation shows safe scope and
version details without printing the input or secrets.

For `endpoint.json`, replace the example Project UUID and receiver URL with the
intended authorized targets:

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

Create requires all four top-level fields. The supported destination is HTTP
adapter version `"1"` with an HTTPS URL; kind is `"http"`, and configuration
contains only url. Subscriptions explicitly choose Projects and events. Allowed
events are task.created, task.status_changed, task.paused, task.deleted,
task.step_updated and task.thread_posted; each subscription needs a nonempty
array without duplicates. Do not infer an all-Projects subscription.

Update accepts a nonempty partial object using the same top-level keys; omitted
fields stay unchanged. For example, `{"enabled":false}` disables the endpoint.
If destination is supplied, provide its complete kind/adapterVersion/configuration
object. A supplied subscriptions value replaces the entire array.

`webhook subscription replace` reads the subscription array itself, not an object
wrapping it. Each item requires id, projectId and eventTypes. Use id:null for a
new subscription. To retain a subscription, read its real ID and keep that ID
with the same Project; IDs must be unique. Changing Project requires a new
id:null item. Omitted subscriptions are removed; deletion followed by re-addition
creates a new identity. An empty array removes all subscriptions. Read and keep
every entry that should survive replacement. Use explicit subscription reconfirm
for renewed Project eligibility; restored access alone does not reconfirm scope.

## Operation identity and recovery

```bash
daynight webhook operation show <operation-id> --personal --json
```

Writes use one operation ID and original issued time. Supply both
`--operation-id` and `--issued-at`, or let the CLI generate them after confirmation.
`--operation-out <path>` exclusively creates a private prepared record before
sending. It holds identity, scope, versions and request hash, without body or
secrets. Private prepared-file creation is unavailable on Windows and fails
before sending. Retain the original identity for an unknown result and inspect
it with operation show; missing receipts or matching current values do not
establish rollback or success.

Explicitly resume with `--resume-operation <path>` on the original write leaf,
retaining owner, targets, versions, mode and input. This conflicts with explicit
operation-id/issued-at and operation-out. The CLI verifies the record and exact
request hash before reading the receipt. A receipt at or past its expiry by the
local clock cannot confirm the operation. A matching receipt confirms the
original operation without another write.

If the receipt is missing, complete original input, explicit `--confirm` and an
issued time within the admission window (five minutes past, sixty seconds future)
permit at most one identical submission. Inaccessible receipts or an expired
window leave the result unknown. The prepared record cannot reconstruct the
body. A confirmed operation remains confirmed across local render/output/cleanup
failure. This explicit resume procedure is separate from automatic retry.

## Read deliveries and payloads

```bash
daynight webhook secret show <endpoint-id> --personal --reveal
daynight webhook delivery list <endpoint-id> --personal --json
daynight webhook delivery payload <endpoint-id> <delivery-id> --personal --output ./payload.json
daynight webhook delivery redeliver <endpoint-id> <delivery-id> --personal --if-version <version> --if-generation <generation> --confirm
```

Endpoint list validates all pages before output. Delivery and attempt history
return one page, with `--limit` 1–100 (default 50); pass returned cursors explicitly
with `--cursor`. Retention can leave history incomplete. Secret show returns
metadata unless `--reveal` is explicit; rotation does not reveal the new secret.
Successful redelivery confirms registration, not completed delivery.

Payload output defaults to exact original bytes without an added LF. `--json`
returns the validated Base64 wrapper; `--output` publishes a private new file
without overwriting an existing target. Those options conflict. File publication
requires Linux with procfs and glibc. The service independently enforces payload
authorization and retention.
