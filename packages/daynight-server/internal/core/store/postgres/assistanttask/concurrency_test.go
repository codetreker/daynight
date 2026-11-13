package assistanttask_test

import (
	"context"
	"crypto/sha256"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	"github.com/google/uuid"
)

func (f fixture) bot(t *testing.T) (string, model.Principal) {
	t.Helper()
	ctx := t.Context()
	worker, id, credential := uuid.NewString(), uuid.NewString(), uuid.NewString()
	hash := sha256.Sum256([]byte(credential))
	for _, stmt := range []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO users(id,uniauth_id,created_at,updated_at) VALUES($1,$2,clock_timestamp(),clock_timestamp()) ON CONFLICT DO NOTHING`, []any{f.owner, "github:" + f.owner}},
		{`INSERT INTO workers(user_id,worker_id,created_at,last_seen_at,telemetry,task_snapshot) VALUES($1,$2,clock_timestamp(),clock_timestamp(),'{}','{"state":"unavailable","items":[]}')`, []any{f.owner, worker}},
		{`INSERT INTO sessions(id,user_id,token_hash,created_at,expires_at) VALUES($1,$2,$3,clock_timestamp(),clock_timestamp()+interval '1 hour')`, []any{credential, f.owner, hash[:]}},
		{`INSERT INTO bots(id,owner_user_id,worker_id,name,request_fingerprint,requested_overrides,resolved_configuration,startup_result) VALUES($1,$2,$3,'Bot',repeat('a',64),'{}','{}','{"state":"pending"}')`, []any{id, f.owner, worker}},
	} {
		if _, err := f.db.Pool.Exec(ctx, stmt.sql, stmt.args...); err != nil {
			t.Fatal(err)
		}
	}
	return id, model.Principal{UserID: f.owner, CredentialID: credential, Kind: model.SessionCredential}
}

func awaitDatabaseTime(t *testing.T, f fixture, at time.Time) {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	tick := time.NewTicker(5 * time.Millisecond)
	defer tick.Stop()
	for {
		var ready bool
		if err := f.db.Pool.QueryRow(ctx, `SELECT clock_timestamp()>=$1`, at).Scan(&ready); err != nil {
			t.Fatal(err)
		}
		if ready {
			return
		}
		select {
		case <-tick.C:
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
	}
}

func TestLeasePredicateRechecksAfterRowLockWait(t *testing.T) {
	f := setup(t)
	bot, _ := f.bot(t)
	hash := "hash"
	expiry := time.Now().UTC().Add(300 * time.Millisecond)
	f.task.HolderBotID = &bot
	f.task.ClaimTokenHash = &hash
	f.task.ClaimGeneration = 1
	f.task.LeaseUntil = &expiry
	f.create(t)
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	blocker, err := f.db.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	rollbackDatabase(t, blocker)
	if _, err := blocker.Exec(ctx, `SELECT id FROM assistant_tasks WHERE id=$1 FOR UPDATE`, f.task.ID); err != nil {
		t.Fatal(err)
	}
	result := asyncDatabase(t, ctx, func(ctx context.Context) error {
		_, err := f.db.WriteAssistantTask(ctx, func(s store.AssistantTaskScope) error {
			candidate := f.task
			candidate.Version = 2
			candidate.Name = "late write"
			ok, err := s.AssistantTaskDAO().SaveTask(ctx, candidate, store.AssistantTaskCondition{Version: 1, CheckClaim: true, LiveClaim: true, Generation: 1, HolderBotID: &bot, TokenHash: &hash})
			if err != nil {
				return err
			}
			if ok {
				return errors.New("expired claim admitted after lock wait")
			}
			return nil
		})
		return err
	})
	testutil.WaitForQueryLock(t, f.db.Pool, "SELECT id::text FROM assistant_tasks WHERE owner_user_id")
	awaitDatabaseTime(t, f, expiry)
	if err := blocker.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if err := testutil.ReceiveQueryResult(t, ctx, result); err != nil {
		t.Fatal(err)
	}
	f.write(t, func(d store.AssistantTaskDAO) error {
		got, err := d.Task(ctx, f.owner, f.task.ID, false)
		if err == nil && got.Version != 1 {
			t.Fatal("expired write persisted")
		}
		return err
	})
}

func TestOnlyOneConcurrentClaimCASCommits(t *testing.T) {
	f := setup(t)
	firstBot, _ := f.bot(t)
	secondBot, _ := f.bot(t)
	f.create(t)
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	firstSaved, release := make(chan struct{}), make(chan struct{})
	claim := func(holder string, hold bool) error {
		_, err := f.db.WriteAssistantTask(ctx, func(s store.AssistantTaskScope) error {
			candidate := f.task
			candidate.Version = 2
			candidate.ClaimGeneration = 1
			candidate.HolderBotID = &holder
			ok, err := s.AssistantTaskDAO().SaveTask(ctx, candidate, store.AssistantTaskCondition{Version: 1, CheckClaim: true, Generation: 0})
			if err != nil {
				return err
			}
			if hold {
				if !ok {
					return errors.New("first CAS failed")
				}
				close(firstSaved)
				select {
				case <-release:
				case <-ctx.Done():
					return ctx.Err()
				}
			} else if ok {
				return errors.New("second claim also succeeded")
			}
			return nil
		})
		return err
	}
	firstResult := asyncDatabase(t, ctx, func(context.Context) error { return claim(firstBot, true) })
	select {
	case <-firstSaved:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	secondResult := asyncDatabase(t, ctx, func(context.Context) error { return claim(secondBot, false) })
	testutil.WaitForQueryLock(t, f.db.Pool, "SELECT id::text FROM assistant_tasks WHERE owner_user_id")
	close(release)
	for _, result := range []<-chan error{firstResult, secondResult} {
		if err := testutil.ReceiveQueryResult(t, ctx, result); err != nil {
			t.Fatal(err)
		}
	}
	f.write(t, func(d store.AssistantTaskDAO) error {
		got, err := d.Task(ctx, f.owner, f.task.ID, false)
		if err == nil && (got.HolderBotID == nil || *got.HolderBotID != firstBot || got.ClaimGeneration != 1) {
			t.Fatalf("wrong durable winner: %#v", got)
		}
		return err
	})
}

func TestCredentialExpiryRechecksAfterShareLockWait(t *testing.T) {
	f := setup(t)
	_, principal := f.bot(t)
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	var expiry time.Time
	if err := f.db.Pool.QueryRow(ctx, `UPDATE sessions SET expires_at=clock_timestamp()+interval '300 milliseconds' WHERE id=$1 RETURNING expires_at`, principal.CredentialID).Scan(&expiry); err != nil {
		t.Fatal(err)
	}
	blocker, err := f.db.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	rollbackDatabase(t, blocker)
	if _, err := blocker.Exec(ctx, `SELECT id FROM sessions WHERE id=$1 FOR UPDATE`, principal.CredentialID); err != nil {
		t.Fatal(err)
	}
	result := asyncDatabase(t, ctx, func(ctx context.Context) error {
		_, err := f.db.WriteAssistantTask(ctx, func(s store.AssistantTaskScope) error { return s.AssistantTaskDAO().Credential(ctx, principal) })
		return err
	})
	testutil.WaitForQueryLock(t, f.db.Pool, "SELECT expires_at FROM sessions")
	awaitDatabaseTime(t, f, expiry)
	if err := blocker.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if err := testutil.ReceiveQueryResult(t, ctx, result); !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("expired credential admitted after waiting: %v", err)
	}
}
