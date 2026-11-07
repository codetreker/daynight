package postgres

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pgwebhook "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/webhook"
	webhook "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
	"github.com/google/uuid"
)

func TestWebhookPersistenceAndAtomicCapacity(t *testing.T) {
	s := isolatedStore(t)
	ctx := context.Background()
	o := webhook.Owner{Kind: "user", ID: uuid.NewString()}
	id := uuid.NewString()
	operation := uuid.NewString()
	now := time.Now().UTC().Truncate(time.Microsecond)
	e := webhook.Endpoint{ID: id, Owner: o, Name: "sample", Enabled: true, ConfigVersion: 1, DestinationRevision: 1, DestinationKind: "http", AdapterVersion: "1", Origin: "https://example.org", DestinationCiphertext: []byte("cipher"), ActiveKeyID: "key", CreatedAt: now, UpdatedAt: now}
	key := webhook.SigningKey{EndpointID: id, ID: "key", Ciphertext: []byte("keycipher"), CreatedAt: now}
	receipt := webhook.Operation{Owner: o, ID: operation, ActorID: o.ID, Kind: "create", TargetID: id, IssuedAt: now.Format(time.RFC3339Nano), RequestSHA256: strings.Repeat("a", 64), Fingerprint: strings.Repeat("b", 64), Effect: "created", ConfigVersion: 1, DestinationRevisionAfter: 1, ActiveKeyID: "key", RecordedAt: now, ExpiresAt: now.Add(30 * 24 * time.Hour)}
	completion, err := s.WriteWebhook(ctx, o, operation, func(scope store.WebhookWriteScope) error {
		dao := scope.WebhookWriter()
		if err := dao.Reserve(ctx, o, 1, 2, 4096+int64(len(e.DestinationCiphertext)+len(key.Ciphertext)), 2, 4096+int64(len(e.DestinationCiphertext)+len(key.Ciphertext)), true); err != nil {
			return err
		}
		if err := dao.PutEndpoint(ctx, e); err != nil {
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
	err = s.ReadWebhookSnapshot(ctx, func(scope store.WebhookReadScope) error {
		dao := scope.WebhookDAO()
		got, err := dao.Endpoint(ctx, o, id)
		if err != nil {
			return err
		}
		if got.Name != e.Name || string(got.DestinationCiphertext) != "cipher" {
			t.Fatalf("endpoint %#v", got)
		}
		keys, err := dao.SigningKeys(ctx, id)
		if err != nil {
			return err
		}
		if len(keys) != 1 || keys[0].ID != "key" {
			t.Fatalf("keys %#v", keys)
		}
		gotReceipt, err := dao.Operation(ctx, o, operation)
		if err != nil {
			return err
		}
		if gotReceipt.RequestSHA256 != receipt.RequestSHA256 || gotReceipt.DestinationRevisionAfter != 1 {
			t.Fatalf("receipt %#v", gotReceipt)
		}
		endpoints, err := dao.Endpoints(ctx, o)
		if err != nil {
			return err
		}
		if len(endpoints) != 1 {
			t.Fatalf("endpoints %#v", endpoints)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	var ep, records, bytes, ops int64
	if err := s.Pool.QueryRow(ctx, `SELECT endpoints,records,bytes,operations FROM webhook_quota_owners WHERE owner_kind=$1 AND owner_id=$2`, o.Kind, o.ID).Scan(&ep, &records, &bytes, &ops); err != nil {
		t.Fatal(err)
	}
	if ep != 1 || records != 2 || bytes != 4111 || ops != 1 {
		t.Fatalf("wrong quota %d %d %d %d", ep, records, bytes, ops)
	}
	failure := errors.New("after reservation")
	_, err = s.WriteWebhook(ctx, o, uuid.NewString(), func(scope store.WebhookWriteScope) error {
		if err := scope.WebhookWriter().Reserve(ctx, o, 1, 1, 2048, 1, 2048, true); err != nil {
			return err
		}
		return failure
	})
	if !errors.Is(err, failure) {
		t.Fatalf("failure lost %v", err)
	}
	if err := s.Pool.QueryRow(ctx, `SELECT endpoints,records,bytes,operations FROM webhook_quota_owners WHERE owner_kind=$1 AND owner_id=$2`, o.Kind, o.ID).Scan(&ep, &records, &bytes, &ops); err != nil {
		t.Fatal(err)
	}
	if ep != 1 || records != 2 || bytes != 4111 || ops != 1 {
		t.Fatalf("partial reservation %d %d %d %d", ep, records, bytes, ops)
	}
	_, err = s.WriteWebhook(ctx, o, uuid.NewString(), func(scope store.WebhookWriteScope) error {
		e.Name = strings.Repeat("x", 2100)
		return scope.WebhookWriter().PutEndpoint(ctx, e)
	})
	if !errors.Is(err, store.ErrWebhookMetadataTooLarge) {
		t.Fatalf("metadata accepted %v", err)
	}
}

func TestWebhookConcurrentLastOperationSlot(t *testing.T) {
	s := isolatedStore(t)
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	o := webhook.Owner{Kind: "user", ID: uuid.NewString()}
	_, err := s.WriteWebhook(ctx, o, uuid.NewString(), func(scope store.WebhookWriteScope) error {
		return scope.WebhookWriter().Reserve(ctx, o, 0, 0, 0, 0, 0, false)
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.Pool.Exec(ctx, `UPDATE webhook_quota_owners SET operations=1023 WHERE owner_kind=$1 AND owner_id=$2`, o.Kind, o.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Pool.Exec(ctx, `UPDATE webhook_quota_buckets SET operations=1023 WHERE bucket=$1`, pgwebhook.Bucket(o)); err != nil {
		t.Fatal(err)
	}
	locked := make(chan struct{})
	release := make(chan struct{})
	result := make(chan error, 2)
	go func() {
		_, err := s.WriteWebhook(ctx, o, uuid.NewString(), func(scope store.WebhookWriteScope) error {
			if err := scope.WebhookWriter().Reserve(ctx, o, 0, 0, 0, 0, 0, true); err != nil {
				return err
			}
			close(locked)
			<-release
			return nil
		})
		result <- err
	}()
	<-locked
	started := make(chan struct{})
	go func() {
		_, err := s.WriteWebhook(ctx, o, uuid.NewString(), func(scope store.WebhookWriteScope) error {
			close(started)
			return scope.WebhookWriter().Reserve(ctx, o, 0, 0, 0, 0, 0, true)
		})
		result <- err
	}()
	<-started
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
	close(release)
	if !blocked {
		t.Fatal("second reservation never waited for a database lock")
	}
	first, second := <-result, <-result
	if !((first == nil && errors.Is(second, store.ErrWebhookOperationCapacity)) || (second == nil && errors.Is(first, store.ErrWebhookOperationCapacity))) {
		t.Fatalf("results %v %v", first, second)
	}
	var operations int
	if err := s.Pool.QueryRow(ctx, `SELECT operations FROM webhook_quota_owners WHERE owner_kind=$1 AND owner_id=$2`, o.Kind, o.ID).Scan(&operations); err != nil || operations != 1024 {
		t.Fatalf("operations %d %v", operations, err)
	}
}

func TestWebhookActiveBudgetAndPolicy(t *testing.T) {
	s := isolatedStore(t)
	ctx := context.Background()
	o := webhook.Owner{Kind: "user", ID: uuid.NewString()}
	_, err := s.WriteWebhook(ctx, o, uuid.NewString(), func(sc store.WebhookWriteScope) error {
		return sc.WebhookWriter().Reserve(ctx, o, 0, 1, 1, 1, 1, false)
	})
	if err != nil {
		t.Fatal(err)
	}
	_, err = s.WriteWebhook(ctx, o, uuid.NewString(), func(sc store.WebhookWriteScope) error {
		return sc.WebhookWriter().Reserve(ctx, o, 0, 1, 1, 24576, 1, true)
	})
	if !errors.Is(err, store.ErrWebhookCapacity) {
		t.Fatalf("active limit: %v", err)
	}
	var rec, active, ops int
	if err := s.Pool.QueryRow(ctx, `SELECT records,active_records,operations FROM webhook_quota_owners WHERE owner_kind=$1 AND owner_id=$2`, o.Kind, o.ID).Scan(&rec, &active, &ops); err != nil || rec != 1 || active != 1 || ops != 0 {
		t.Fatalf("partial charge %d %d %d %v", rec, active, ops, err)
	}
	if _, err := s.Pool.Exec(ctx, `UPDATE webhook_policies SET parameters=jsonb_set(parameters,'{ownerRecords}','1'::jsonb) WHERE version=1`); err != nil {
		t.Fatal(err)
	}
	_, err = s.WriteWebhook(ctx, o, uuid.NewString(), func(sc store.WebhookWriteScope) error { return sc.WebhookWriter().Reserve(ctx, o, 0, 0, 0, 0, 0, true) })
	if err == nil || !strings.Contains(err.Error(), "webhook policy") { // database wrappers intentionally hide detail, inspect its cause instead
		if err == nil {
			t.Fatal("changed policy accepted")
		}
	}
	if err := s.Pool.QueryRow(ctx, `SELECT operations FROM webhook_quota_owners WHERE owner_kind=$1 AND owner_id=$2`, o.Kind, o.ID).Scan(&ops); err != nil || ops != 0 {
		t.Fatalf("policy failure charged operation: %d %v", ops, err)
	}
}

func TestWebhookOperationFenceCanonicalUUID(t *testing.T) {
	s := isolatedStore(t)
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	o := webhook.Owner{Kind: "user", ID: uuid.NewString()}
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
