package postgres

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pgwebhook "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/webhook"
	webhook "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
	"github.com/google/uuid"
)

func TestWebhookDatabaseReadAndKeyFailures(t *testing.T) {
	for _, kind := range []string{"missing endpoint", "endpoint scan", "key scan", "key insert", "key delete", "key metadata"} {
		t.Run(kind, func(t *testing.T) {
			s := isolatedStore(t)
			ctx := context.Background()
			o := webhook.Owner{Kind: "user", ID: uuid.NewString()}
			endpoint := uuid.NewString()
			var operation func(store.WebhookWriteScope) error
			switch kind {
			case "missing endpoint":
				operation = func(sc store.WebhookWriteScope) error {
					_, err := sc.WebhookWriter().LockEndpoint(ctx, o, endpoint)
					return err
				}
			case "endpoint scan":
				mustQueryExec(t, s, `ALTER TABLE webhook_endpoints DROP CONSTRAINT webhook_endpoints_config_version_check; ALTER TABLE webhook_endpoints ALTER COLUMN config_version TYPE text USING config_version::text`)
				mustQueryExec(t, s, `INSERT INTO webhook_endpoints(id,owner_kind,owner_id,name,enabled,config_version,destination_revision,destination_kind,adapter_version,origin,destination_ciphertext,active_key_id,created_at,updated_at) VALUES($1,'user',$2,'name',true,'corrupt',1,'http','1','https://example.test','x','key',now(),now())`, endpoint, o.ID)
				operation = func(sc store.WebhookWriteScope) error { _, err := sc.WebhookWriter().Endpoints(ctx, o); return err }
			case "key scan":
				mustQueryExec(t, s, `ALTER TABLE webhook_signing_keys ALTER COLUMN created_at TYPE text USING created_at::text`)
				mustQueryExec(t, s, `INSERT INTO webhook_signing_keys(endpoint_id,id,ciphertext,created_at) VALUES($1,'key','x','corrupt')`, endpoint)
				operation = func(sc store.WebhookWriteScope) error {
					_, err := sc.WebhookWriter().SigningKeys(ctx, endpoint)
					return err
				}
			case "key insert":
				// NOT NULL violation models a storage failure, preserving the database cause.
				operation = func(sc store.WebhookWriteScope) error {
					return sc.WebhookWriter().PutSigningKey(ctx, webhook.SigningKey{EndpointID: endpoint, ID: "key", CreatedAt: time.Now()})
				}
			case "key delete":
				mustQueryExec(t, s, `DROP TABLE webhook_signing_keys`)
				operation = func(sc store.WebhookWriteScope) error { return sc.WebhookWriter().DeleteSigningKeys(ctx, endpoint) }
			case "key metadata":
				operation = func(sc store.WebhookWriteScope) error {
					return sc.WebhookWriter().PutSigningKey(ctx, webhook.SigningKey{EndpointID: endpoint, ID: strings.Repeat("x", 2100), Ciphertext: []byte("x"), CreatedAt: time.Now()})
				}
			}
			completion, err := s.WriteWebhook(ctx, o, uuid.NewString(), operation)
			if completion.Outcome != store.TransactionNotCommitted || err == nil {
				t.Fatalf("unexpected result %v %v", completion, err)
			}
			if kind == "missing endpoint" {
				if !errors.Is(err, model.ErrNotFound) {
					t.Fatalf("missing endpoint cause: %v", err)
				}
				return
			}
			if kind == "key metadata" {
				if !errors.Is(err, store.ErrWebhookMetadataTooLarge) {
					t.Fatalf("metadata cause: %v", err)
				}
				return
			}
			if failed, _ := store.DatabaseErrorFacts(err); !failed {
				t.Fatalf("database failure cause lost: %v", err)
			}
		})
	}
}

func TestWebhookQuotaStorageFailuresRollback(t *testing.T) {
	for _, kind := range []string{"missing policy", "missing bucket", "invalid account", "wrong bucket", "active exceeds retained", "bucket update", "account update"} {
		t.Run(kind, func(t *testing.T) {
			s := isolatedStore(t)
			ctx := context.Background()
			o := webhook.Owner{Kind: "user", ID: uuid.NewString()}
			bucket := pgwebhook.Bucket(o)
			switch kind {
			case "missing policy":
				mustQueryExec(t, s, `DELETE FROM webhook_policies WHERE version=1`)
			case "missing bucket":
				mustQueryExec(t, s, `DELETE FROM webhook_quota_buckets WHERE bucket=$1`, bucket)
			case "invalid account":
				// The writer accepts only a valid owner, while the DAO must reject a bad
				// account kind instead of inserting a malformed quota row.
			case "wrong bucket":
				mustQueryExec(t, s, `INSERT INTO webhook_quota_owners(owner_kind,owner_id,bucket) VALUES('user',$1,$2)`, o.ID, (bucket+1)%16)
			case "bucket update", "account update":
				table := "webhook_quota_buckets"
				if kind == "account update" {
					table = "webhook_quota_owners"
				}
				mustQueryExec(t, s, `CREATE FUNCTION reject_quota_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION USING ERRCODE='P1901', MESSAGE='quota unavailable'; END $$; CREATE TRIGGER reject_quota_update BEFORE UPDATE ON `+table+` FOR EACH ROW EXECUTE FUNCTION reject_quota_update()`)
			}
			completion, err := s.WriteWebhook(ctx, o, uuid.NewString(), func(sc store.WebhookWriteScope) error {
				target := o
				if kind == "invalid account" {
					target.Kind = "invalid"
				}
				if kind == "active exceeds retained" {
					return sc.WebhookWriter().Reserve(ctx, target, 0, 0, 0, 1, 1, true)
				}
				return sc.WebhookWriter().Reserve(ctx, target, 1, 2, 4096, 2, 4096, true)
			})
			if err == nil || completion.Outcome != store.TransactionNotCommitted {
				t.Fatalf("expected rollback: %v %v", completion, err)
			}
			if kind == "invalid account" || kind == "bucket update" || kind == "account update" {
				if failed, _ := store.DatabaseErrorFacts(err); !failed {
					t.Fatalf("database error lost: %v", err)
				}
			}
			var records, used, ops int64
			queryErr := s.Pool.QueryRow(ctx, `SELECT records,bytes,operations FROM webhook_quota_buckets WHERE bucket=$1`, bucket).Scan(&records, &used, &ops)
			if kind == "missing bucket" {
				if queryErr == nil {
					t.Fatal("bucket was recreated")
				}
				return
			}
			if queryErr != nil || records != 0 || used != 0 || ops != 0 {
				t.Fatalf("bucket partially charged: %d %d %d %v", records, used, ops, queryErr)
			}
			var accounts int
			if err := s.Pool.QueryRow(ctx, `SELECT count(*) FROM webhook_quota_owners WHERE owner_kind='user' AND owner_id=$1`, o.ID).Scan(&accounts); err != nil {
				t.Fatal(err)
			}
			if kind != "wrong bucket" && accounts != 0 {
				t.Fatalf("failed reservation created account: %d", accounts)
			}
		})
	}
}

func TestWebhookAuthorityRejectsMissingContainers(t *testing.T) {
	s := isolatedStore(t)
	ctx := context.Background()
	user := uuid.NewString()
	base := webhook.Owner{Kind: "user", ID: user}
	team := uuid.NewString()
	mustQueryExec(t, s, `INSERT INTO teams(id,name) VALUES($1,'Team')`, team)
	for _, target := range []webhook.Owner{{Kind: "user", ID: uuid.NewString()}, {Kind: "invalid", ID: user}, {Kind: "team", ID: uuid.NewString()}, {Kind: "team", ID: team}} {
		completion, err := s.WriteWebhook(ctx, base, uuid.NewString(), func(sc store.WebhookWriteScope) error { return sc.LockAuthority(ctx, target, user) })
		if completion.Outcome != store.TransactionNotCommitted || !errors.Is(err, model.ErrNotFound) {
			t.Fatalf("owner %#v: %v %v", target, completion, err)
		}
	}
}
