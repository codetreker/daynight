package postgres

import (
	"context"
	"errors"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	webhook "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
	"github.com/google/uuid"
)

func TestWebhookDatabaseFailures(t *testing.T) {
	for _, kind := range []string{"missing endpoint", "endpoint read", "key read", "key insert", "key delete", "missing policy"} {
		t.Run(kind, func(t *testing.T) {
			s := isolatedStore(t)
			ctx := context.Background()
			owner, endpoint, key, _ := webhookStoredFixture(t)
			var operation func(store.WebhookWriteScope) error
			switch kind {
			case "missing endpoint":
				operation = func(sc store.WebhookWriteScope) error {
					_, err := sc.WebhookWriter().LockEndpoint(ctx, owner, endpoint.ID)
					return err
				}
			case "endpoint read":
				mustQueryExec(t, s, `DROP TABLE webhook_endpoints`)
				operation = func(sc store.WebhookWriteScope) error { _, err := sc.WebhookWriter().Endpoints(ctx, owner); return err }
			case "key read", "key delete":
				mustQueryExec(t, s, `DROP TABLE webhook_signing_keys`)
				if kind == "key read" {
					operation = func(sc store.WebhookWriteScope) error {
						_, err := sc.WebhookWriter().SigningKeys(ctx, endpoint.ID)
						return err
					}
				} else {
					operation = func(sc store.WebhookWriteScope) error { return sc.WebhookWriter().DeleteSigningKeys(ctx, endpoint.ID) }
				}
			case "key insert":
				mustQueryExec(t, s, `CREATE FUNCTION reject_key() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION USING ERRCODE='P1902', MESSAGE='key storage failure'; END $$; CREATE TRIGGER reject_key BEFORE INSERT ON webhook_signing_keys FOR EACH ROW EXECUTE FUNCTION reject_key()`)
				operation = func(sc store.WebhookWriteScope) error { return sc.WebhookWriter().PutSigningKey(ctx, key) }
			case "missing policy":
				mustQueryExec(t, s, `DELETE FROM webhook_policies WHERE version=1`)
				operation = func(sc store.WebhookWriteScope) error { _, err := sc.WebhookWriter().Policy(ctx, 1); return err }
			}
			completion, err := s.WriteWebhook(ctx, owner, uuid.NewString(), operation)
			if completion.Outcome != store.TransactionNotCommitted || err == nil {
				t.Fatalf("unexpected result %v %v", completion, err)
			}
			if kind == "missing endpoint" || kind == "missing policy" {
				if !errors.Is(err, model.ErrNotFound) {
					t.Fatalf("missing record cause: %v", err)
				}
				return
			}
			failed, code := store.DatabaseErrorFacts(err)
			if !failed || (kind == "key insert" && code != "P1902") {
				t.Fatalf("database failure cause lost: %v %q %v", failed, code, err)
			}
		})
	}
}

func TestWebhookAuthorityRejectsMissingContainers(t *testing.T) {
	s := isolatedStore(t)
	ctx := context.Background()
	user := uuid.NewString()
	base := webhook.Owner{Kind: "personal", ID: user}
	team := uuid.NewString()
	mustQueryExec(t, s, `INSERT INTO teams(id,name) VALUES($1,'Team')`, team)
	for _, target := range []webhook.Owner{{Kind: "personal", ID: uuid.NewString()}, {Kind: "invalid", ID: user}, {Kind: "team", ID: uuid.NewString()}, {Kind: "team", ID: team}} {
		completion, err := s.WriteWebhook(ctx, base, uuid.NewString(), func(sc store.WebhookWriteScope) error { return sc.LockAuthority(ctx, target, user) })
		if completion.Outcome != store.TransactionNotCommitted || !errors.Is(err, model.ErrNotFound) {
			t.Fatalf("owner %#v: %v %v", target, completion, err)
		}
	}
}
