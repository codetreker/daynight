package webhook

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	wm "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
	"github.com/google/uuid"
)

// afterWriteGate delays delivery of the completed write transaction to the
// service while retaining the real PostgreSQL transaction and fence behavior.
type afterWriteGate struct {
	store.WebhookTransactions
	completed chan struct{}
	resume    chan struct{}
}

func (g *afterWriteGate) WriteWebhook(ctx context.Context, o wm.Owner, id string, fn func(store.WebhookWriteScope) error) (store.Completion, error) {
	c, err := g.WebhookTransactions.WriteWebhook(ctx, o, id, fn)
	close(g.completed)
	select {
	case <-g.resume:
	case <-ctx.Done():
		return c, ctx.Err()
	}
	return c, err
}

func TestPostgresOtherActorConflictAfterDemotion(t *testing.T) {
	f := newFixture(t, true)
	originalActor, probe := f.principal(t), f.principal(t)
	team := uuid.NewString()
	owner := Owner{Kind: "team", ID: team}
	if _, err := f.db.Pool.Exec(f.ctx, `INSERT INTO teams(id,name) VALUES($1,'shared')`, team); err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.Pool.Exec(f.ctx, `INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'admin'),($1,$3,'admin')`, team, originalActor.UserID, probe.UserID); err != nil {
		t.Fatal(err)
	}
	original := createMutation(originalActor, "original", "https://receiver.example/path")
	if _, err := f.svc.Mutate(f.ctx, originalActor, owner, original); err != nil {
		t.Fatal(err)
	}
	contender := createMutation(probe, "different", "https://receiver.example/other")
	contender.OperationID = original.OperationID
	aux := f.auxiliaryPool(t)
	lock, err := aux.Begin(f.ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Rollback(f.ctx)
	var pid int32
	if err = lock.QueryRow(f.ctx, `SELECT pg_backend_pid()`).Scan(&pid); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256([]byte("daynight-webhook-operation\x00" + owner.Kind + "\x00" + owner.ID + "\x00" + original.OperationID))
	if _, err = lock.Exec(f.ctx, `SELECT pg_advisory_xact_lock($1)`, int64(binary.BigEndian.Uint64(sum[:8]))); err != nil {
		t.Fatal(err)
	}
	gate := &afterWriteGate{WebhookTransactions: f.db, completed: make(chan struct{}), resume: make(chan struct{})}
	svc := &Service{DB: gate, Keys: f.svc.Keys}
	out := make(chan mutationOutcome, 1)
	go func() { r, e := svc.Mutate(f.ctx, probe, owner, contender); out <- mutationOutcome{r, e} }()
	waitBlocked(t, f.ctx, aux, pid)
	if err = lock.Commit(f.ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case <-gate.completed:
	case <-f.ctx.Done():
		t.Fatal(f.ctx.Err())
	}
	if _, err = aux.Exec(f.ctx, `UPDATE team_members SET role='member' WHERE team_id=$1 AND user_id=$2`, team, probe.UserID); err != nil {
		t.Fatal(err)
	}
	close(gate.resume)
	result := waitOutcome(t, f.ctx, out)
	expectFault(t, result.err, "forbidden")
	var endpoints, receipts int
	if err = aux.QueryRow(f.ctx, `SELECT (SELECT count(*) FROM webhook_endpoints WHERE owner_id=$1),(SELECT count(*) FROM webhook_operations WHERE owner_id=$1)`, team).Scan(&endpoints, &receipts); err != nil || endpoints != 1 || receipts != 1 {
		t.Fatalf("unexpected effects endpoints=%d receipts=%d err=%v", endpoints, receipts, err)
	}
}

func TestPostgresCredentialRevokedWhileEndpointVersionChanges(t *testing.T) {
	f := newFixture(t, true)
	p := f.principal(t)
	owner := Owner{Kind: "user", ID: p.UserID}
	created, err := f.svc.Mutate(f.ctx, p, owner, createMutation(p, "original", "https://receiver.example/path"))
	if err != nil {
		t.Fatal(err)
	}
	_, ep := body(t, created)
	id := ep["id"].(string)
	before := f.quotaFacts(t, owner)
	aux := f.auxiliaryPool(t)
	lock, err := aux.Begin(f.ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Rollback(f.ctx)
	var pid int32
	if err = lock.QueryRow(f.ctx, `SELECT pg_backend_pid()`).Scan(&pid); err != nil {
		t.Fatal(err)
	}
	if _, err = lock.Exec(f.ctx, `SELECT id FROM webhook_endpoints WHERE id=$1 FOR UPDATE`, id); err != nil {
		t.Fatal(err)
	}
	change := mutation(p, "endpoint.update", id, 1)
	name := "denied"
	change.Name = &name
	out := make(chan mutationOutcome, 1)
	go func() { r, e := f.svc.Mutate(f.ctx, p, owner, change); out <- mutationOutcome{r, e} }()
	waitBlocked(t, f.ctx, aux, pid)
	if _, err = aux.Exec(f.ctx, `DELETE FROM sessions WHERE id=$1`, p.CredentialID); err != nil {
		t.Fatal(err)
	}
	if _, err = lock.Exec(f.ctx, `UPDATE webhook_endpoints SET config_version=2 WHERE id=$1`, id); err != nil {
		t.Fatal(err)
	}
	if err = lock.Commit(f.ctx); err != nil {
		t.Fatal(err)
	}
	result := waitOutcome(t, f.ctx, out)
	expectFault(t, result.err, "unauthenticated")
	var version int64
	var actualName string
	var receipts int
	if err = aux.QueryRow(f.ctx, `SELECT config_version,name,(SELECT count(*) FROM webhook_operations WHERE owner_id=$2) FROM webhook_endpoints WHERE id=$1`, id, p.UserID).Scan(&version, &actualName, &receipts); err != nil || version != 2 || actualName != "original" || receipts != 1 || f.quotaFacts(t, owner) != before {
		t.Fatalf("unexpected effect version=%d name=%s receipts=%d err=%v", version, actualName, receipts, err)
	}
}

func TestPostgresExpiredWhileQuotaWaitAndCapacityRejects(t *testing.T) {
	for _, scenario := range []string{"credential", "operation"} {
		t.Run(scenario, func(t *testing.T) {
			f := newFixture(t, true)
			p := f.principal(t)
			owner := Owner{Kind: "user", ID: p.UserID}
			created, err := f.svc.Mutate(f.ctx, p, owner, createMutation(p, "original", "https://receiver.example/path"))
			if err != nil {
				t.Fatal(err)
			}
			_, ep := body(t, created)
			id := ep["id"].(string)
			aux := f.auxiliaryPool(t)
			lock, err := aux.Begin(f.ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer lock.Rollback(f.ctx)
			var pid int32
			var bucket int16
			if err = lock.QueryRow(f.ctx, `SELECT pg_backend_pid()`).Scan(&pid); err != nil {
				t.Fatal(err)
			}
			if err = lock.QueryRow(f.ctx, `SELECT bucket FROM webhook_quota_owners WHERE owner_kind='user' AND owner_id=$1`, p.UserID).Scan(&bucket); err != nil {
				t.Fatal(err)
			}
			if _, err = lock.Exec(f.ctx, `UPDATE webhook_quota_buckets SET operations=8192 WHERE bucket=$1`, bucket); err != nil {
				t.Fatal(err)
			}
			change := mutation(p, "endpoint.update", id, 1)
			name := "denied"
			change.Name = &name
			if scenario == "credential" {
				if _, err = aux.Exec(f.ctx, `UPDATE sessions SET expires_at=clock_timestamp()+interval '3 seconds' WHERE id=$1`, p.CredentialID); err != nil {
					t.Fatal(err)
				}
			} else {
				change.IssuedAt = time.Now().UTC().Add(-299 * time.Second).Format(time.RFC3339Nano)
			}
			out := make(chan mutationOutcome, 1)
			go func() { r, e := f.svc.Mutate(f.ctx, p, owner, change); out <- mutationOutcome{r, e} }()
			waitBlocked(t, f.ctx, aux, pid)
			deadline := time.Now().Add(5 * time.Second)
			for {
				var expired bool
				if scenario == "credential" {
					err = aux.QueryRow(f.ctx, `SELECT expires_at<=clock_timestamp() FROM sessions WHERE id=$1`, p.CredentialID).Scan(&expired)
				} else {
					err = aux.QueryRow(f.ctx, `SELECT $1::timestamptz < clock_timestamp()-interval '300 seconds'`, change.IssuedAt).Scan(&expired)
				}
				if err != nil {
					t.Fatal(err)
				}
				if expired {
					break
				}
				if time.Now().After(deadline) {
					t.Fatal("expiration was not observed")
				}
				time.Sleep(20 * time.Millisecond)
			}
			if err = lock.Commit(f.ctx); err != nil {
				t.Fatal(err)
			}
			result := waitOutcome(t, f.ctx, out)
			want := "unauthenticated"
			if scenario == "operation" {
				want = "operation_expired"
			}
			expectFault(t, result.err, want)
			var version int64
			var actualName string
			var receipts, ownerOps, bucketOps int
			err = aux.QueryRow(f.ctx, `SELECT e.config_version,e.name,(SELECT count(*) FROM webhook_operations WHERE owner_id=$2),o.operations,b.operations FROM webhook_endpoints e JOIN webhook_quota_owners o ON o.owner_kind=e.owner_kind AND o.owner_id=e.owner_id JOIN webhook_quota_buckets b ON b.bucket=o.bucket WHERE e.id=$1`, id, p.UserID).Scan(&version, &actualName, &receipts, &ownerOps, &bucketOps)
			if err != nil || version != 1 || actualName != "original" || receipts != 1 || ownerOps != 1 || bucketOps != 8192 {
				t.Fatalf("unexpected effect version=%d name=%s receipts=%d ownerOps=%d bucketOps=%d err=%v", version, actualName, receipts, ownerOps, bucketOps, err)
			}
		})
	}
}

func TestPostgresRemovedTeamMemberWhileLockedAndOperationExpires(t *testing.T) {
	f := newFixture(t, true)
	p := f.principal(t)
	team := uuid.NewString()
	owner := Owner{Kind: "team", ID: team}
	if _, err := f.db.Pool.Exec(f.ctx, `INSERT INTO teams(id,name) VALUES($1,'shared')`, team); err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.Pool.Exec(f.ctx, `INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'admin')`, team, p.UserID); err != nil {
		t.Fatal(err)
	}
	aux := f.auxiliaryPool(t)
	lock, err := aux.Begin(f.ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Rollback(f.ctx)
	var pid int32
	if err = lock.QueryRow(f.ctx, `SELECT pg_backend_pid()`).Scan(&pid); err != nil {
		t.Fatal(err)
	}
	if _, err = lock.Exec(f.ctx, `SELECT id FROM teams WHERE id=$1 FOR UPDATE`, team); err != nil {
		t.Fatal(err)
	}
	intent := createMutation(p, "denied", "https://receiver.example/path")
	intent.IssuedAt = time.Now().UTC().Add(-299 * time.Second).Format(time.RFC3339Nano)
	out := make(chan mutationOutcome, 1)
	go func() { r, e := f.svc.Mutate(f.ctx, p, owner, intent); out <- mutationOutcome{r, e} }()
	waitBlocked(t, f.ctx, aux, pid)
	if _, err = lock.Exec(f.ctx, `DELETE FROM team_members WHERE team_id=$1 AND user_id=$2`, team, p.UserID); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		var expired bool
		if err = aux.QueryRow(f.ctx, `SELECT $1::timestamptz < clock_timestamp()-interval '300 seconds'`, intent.IssuedAt).Scan(&expired); err != nil {
			t.Fatal(err)
		}
		if expired {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("expiration was not observed")
		}
		time.Sleep(20 * time.Millisecond)
	}
	if err = lock.Commit(f.ctx); err != nil {
		t.Fatal(err)
	}
	result := waitOutcome(t, f.ctx, out)
	expectFault(t, result.err, "forbidden")
	var endpoints, receipts, accounts int
	if err = aux.QueryRow(f.ctx, `SELECT (SELECT count(*) FROM webhook_endpoints WHERE owner_id=$1),(SELECT count(*) FROM webhook_operations WHERE owner_id=$1),(SELECT count(*) FROM webhook_quota_owners WHERE owner_id=$1)`, team).Scan(&endpoints, &receipts, &accounts); err != nil || endpoints != 0 || receipts != 0 || accounts != 0 {
		t.Fatalf("unexpected effect endpoints=%d receipts=%d accounts=%d err=%v", endpoints, receipts, accounts, err)
	}
}
