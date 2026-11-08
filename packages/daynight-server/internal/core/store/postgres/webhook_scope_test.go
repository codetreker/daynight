package postgres

import (
	"bytes"
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	webhook "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
	"github.com/google/uuid"
)

func webhookStoredFixture(t *testing.T) (webhook.Owner, webhook.Endpoint, webhook.SigningKey, webhook.Operation) {
	t.Helper()
	owner := webhook.Owner{Kind: "personal", ID: uuid.NewString()}
	id, keyID := uuid.NewString(), uuid.NewString()
	now := time.Now().UTC().Truncate(time.Microsecond)
	configuration := []byte(`{"kind":"http","adapterVersion":"1","configuration":{"url":"https://example.org/hook"}}`)
	endpoint := webhook.Endpoint{ID: id, Owner: owner, Name: "sample", Enabled: true, ConfigVersion: 1, DestinationRevision: 1, DestinationKind: "http", AdapterVersion: "1", Origin: "https://example.org", DestinationConfiguration: configuration, ActiveKeyID: keyID, CreatedAt: now, UpdatedAt: now}
	key := webhook.SigningKey{EndpointID: id, ID: keyID, Slot: "current", Secret: bytes.Repeat([]byte{2}, 32), CreatedAt: now}
	receipt := webhook.Operation{Owner: owner, ID: uuid.NewString(), ActorID: owner.ID, Kind: "endpoint.create", TargetID: id, IssuedAt: now.Format(time.RFC3339Nano), RequestSHA256: strings.Repeat("a", 64), Fingerprint: strings.Repeat("b", 64), Effect: "applied", ConfigVersion: 1, DestinationRevisionAfter: 1, RecordedAt: now, ExpiresAt: now.Add(30 * 24 * time.Hour)}
	return owner, endpoint, key, receipt
}

func TestWebhookPersistenceAndSnapshot(t *testing.T) {
	s := isolatedStore(t)
	ctx := context.Background()
	owner, endpoint, key, receipt := webhookStoredFixture(t)
	completion, err := s.WriteWebhook(ctx, owner, receipt.ID, func(sc store.WebhookWriteScope) error {
		dao := sc.WebhookWriter()
		if err := dao.PutEndpoint(ctx, endpoint); err != nil {
			return err
		}
		if err := dao.PutSigningKey(ctx, key); err != nil {
			return err
		}
		return dao.PutOperation(ctx, receipt)
	})
	if err != nil || completion.Outcome != store.TransactionCommitted {
		t.Fatalf("write %v %v", completion, err)
	}
	err = s.ReadWebhookSnapshot(ctx, func(sc store.WebhookReadScope) error {
		dao := sc.WebhookDAO()
		got, err := dao.Endpoint(ctx, owner, endpoint.ID)
		if err != nil {
			return err
		}
		if got.Name != endpoint.Name || !bytes.Equal(got.DestinationConfiguration, endpoint.DestinationConfiguration) {
			t.Fatalf("endpoint %#v", got)
		}
		keys, err := dao.SigningKeys(ctx, endpoint.ID)
		if err != nil {
			return err
		}
		if len(keys) != 1 || keys[0].ID != key.ID || !bytes.Equal(keys[0].Secret, key.Secret) {
			t.Fatalf("keys %#v", keys)
		}
		saved, err := dao.Operation(ctx, owner, receipt.ID)
		if err != nil {
			return err
		}
		if saved.RequestSHA256 != receipt.RequestSHA256 || saved.Fingerprint != receipt.Fingerprint || saved.IssuedAt != receipt.IssuedAt {
			t.Fatalf("receipt %#v", saved)
		}
		endpoints, err := dao.Endpoints(ctx, owner)
		if err != nil {
			return err
		}
		if len(endpoints) != 1 {
			t.Fatalf("endpoints %#v", endpoints)
		}
		policy, err := dao.Policy(ctx, 1)
		if err != nil {
			return err
		}
		if policy.OperationMaxAgeSeconds != 300 || policy.KeyOverlapMaxSeconds != 604800 {
			t.Fatalf("policy %#v", policy)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestWebhookReceiptInsertFailureRollsBackEffects(t *testing.T) {
	s := isolatedStore(t)
	ctx := context.Background()
	owner, endpoint, key, initial := webhookStoredFixture(t)
	completion, err := s.WriteWebhook(ctx, owner, initial.ID, func(sc store.WebhookWriteScope) error {
		dao := sc.WebhookWriter()
		if err := dao.PutEndpoint(ctx, endpoint); err != nil {
			return err
		}
		if err := dao.PutSigningKey(ctx, key); err != nil {
			return err
		}
		return dao.PutOperation(ctx, initial)
	})
	if err != nil || completion.Outcome != store.TransactionCommitted {
		t.Fatalf("setup: %v %v", completion, err)
	}
	mustQueryExec(t, s, `CREATE FUNCTION reject_webhook_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION USING ERRCODE='P1901', MESSAGE='receipt storage failure'; END $$; CREATE TRIGGER reject_webhook_receipt BEFORE INSERT ON webhook_operations FOR EACH ROW EXECUTE FUNCTION reject_webhook_receipt()`)
	originalSecret := bytes.Clone(key.Secret)
	endpoint.Name, endpoint.ConfigVersion = "changed", 2
	key.Secret = bytes.Clone(key.Secret)
	key.Secret[len(key.Secret)-1] ^= 1
	receipt := initial
	receipt.ID, receipt.Kind, receipt.ConfigVersion = uuid.NewString(), "endpoint.update", 2
	completion, err = s.WriteWebhook(ctx, owner, receipt.ID, func(sc store.WebhookWriteScope) error {
		dao := sc.WebhookWriter()
		if err := dao.PutEndpoint(ctx, endpoint); err != nil {
			return err
		}
		if err := dao.PutSigningKey(ctx, key); err != nil {
			return err
		}
		return dao.PutOperation(ctx, receipt)
	})
	failed, code := store.DatabaseErrorFacts(err)
	if completion.Outcome != store.TransactionNotCommitted || !failed || code != "P1901" {
		t.Fatalf("completion=%v database=%v code=%s error=%v", completion, failed, code, err)
	}
	if err := s.ReadWebhookSnapshot(ctx, func(sc store.WebhookReadScope) error {
		got, err := sc.WebhookDAO().Endpoint(ctx, owner, endpoint.ID)
		if err != nil {
			return err
		}
		keys, err := sc.WebhookDAO().SigningKeys(ctx, endpoint.ID)
		if err != nil {
			return err
		}
		if got.Name != "sample" || got.ConfigVersion != 1 || len(keys) != 1 || !bytes.Equal(keys[0].Secret, originalSecret) {
			t.Fatalf("partial effects: endpoint=%#v keys=%#v", got, keys)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	var receipts int
	if err := s.Pool.QueryRow(ctx, `SELECT count(*) FROM webhook_operations`).Scan(&receipts); err != nil {
		t.Fatal(err)
	}
	if receipts != 1 {
		t.Fatalf("receipt count=%d", receipts)
	}
}

func TestWebhookOperationFenceCanonicalUUID(t *testing.T) {
	s := isolatedStore(t)
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	o := webhook.Owner{Kind: "personal", ID: uuid.NewString()}
	id := uuid.NewString()
	locked := make(chan struct{})
	release := make(chan struct{})
	entered := make(chan struct{})
	result := make(chan error, 2)
	go func() {
		_, err := s.WriteWebhook(ctx, o, id, func(store.WebhookWriteScope) error { close(locked); <-release; return nil })
		result <- err
	}()
	<-locked
	go func() {
		upper := o
		upper.ID = strings.ToUpper(o.ID)
		_, err := s.WriteWebhook(ctx, upper, strings.ToUpper(id), func(store.WebhookWriteScope) error { close(entered); return nil })
		result <- err
	}()
	blocked := false
	for i := 0; i < 100; i++ {
		var count int
		if err := s.Pool.QueryRow(ctx, `SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND cardinality(pg_blocking_pids(pid))>0`).Scan(&count); err != nil {
			t.Fatal(err)
		}
		if count > 0 {
			blocked = true
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	select {
	case <-entered:
		t.Fatal("same operation passed fence")
	default:
	}
	close(release)
	if !blocked {
		t.Fatal("same operation did not block on fence")
	}
	for i := 0; i < 2; i++ {
		if err := <-result; err != nil {
			t.Fatal(err)
		}
	}
}

func TestWebhookAuthorityRecheckedAfterTeamLockWait(t *testing.T) {
	s, actor, team := storeTeamFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	if _, err := tx.Exec(ctx, `SELECT id FROM teams WHERE id=$1 FOR UPDATE`, team.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `UPDATE team_members SET role='member' WHERE team_id=$1 AND user_id=$2`, team.ID, actor.UserID); err != nil {
		t.Fatal(err)
	}
	result := make(chan error, 1)
	go func() {
		_, err := s.WriteWebhook(ctx, webhook.Owner{Kind: "team", ID: team.ID}, uuid.NewString(), func(sc store.WebhookWriteScope) error {
			if err := sc.LockAuthority(ctx, webhook.Owner{Kind: "team", ID: team.ID}, actor.UserID); err != nil {
				return err
			}
			current, err := sc.TeamDAO().Team(ctx, actor.UserID, team.ID)
			if err != nil {
				return err
			}
			if string(current.Membership.Role) != "member" {
				return errors.New("stale team membership")
			}
			_, err = sc.LockCredential(ctx, actor)
			return err
		})
		result <- err
	}()
	blocked := false
	for i := 0; i < 100; i++ {
		var count int
		if err := s.Pool.QueryRow(ctx, `SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND cardinality(pg_blocking_pids(pid))>0`).Scan(&count); err != nil {
			t.Fatal(err)
		}
		if count > 0 {
			blocked = true
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if !blocked {
		t.Fatal("authority lock did not wait")
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if err := <-result; err != nil {
		t.Fatal(err)
	}
}
