package postgres

import (
	"context"
	"errors"
	"math"
	"sync"
	"testing"
	"time"

	transfercore "github.com/codetreker/daynight/packages/daynight-server/internal/core/mcptransfer"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func transferRecord(user string, now time.Time) model.PrivateTransfer {
	return model.PrivateTransfer{ID: uuid.NewString(), UserID: user, AuthorityKind: "pat", AuthorityID: uuid.NewString(), Direction: "upload", ProjectID: uuid.NewString(), TaskID: uuid.NewString(), Path: "file", ContentType: "text/plain", Binding: []byte(`{}`), Data: []byte(`{}`), State: "receiving", CreatedAt: now, UpdatedAt: now, ExpiresAt: now.Add(time.Hour), HardExpiresAt: now.Add(24 * time.Hour)}
}
func TestPrivateTransferLedgerLifecycle(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	db := isolatedStore(t)
	now := time.Now().UTC().Truncate(time.Microsecond)
	user := uuid.NewString()
	var records []model.PrivateTransfer
	for i := 0; i < 4; i++ {
		input := transferRecord(user, now)
		c, e := db.WritePrivateTransfer(ctx, func(d store.PrivateTransferDAO) error {
			var created bool
			var err error
			input, created, err = transfercore.Create(ctx, d, input)
			if err != nil {
				return err
			}
			if !created {
				t.Fatal("first create not created")
			}
			records = append(records, input)
			return nil
		})
		if e != nil || c.Outcome != store.TransactionCommitted {
			t.Fatalf("create %v %v", c, e)
		}
	}
	c, e := db.WritePrivateTransfer(ctx, func(d store.PrivateTransferDAO) error {
		r, created, err := transfercore.Create(ctx, d, records[0])
		if err != nil {
			return err
		}
		if created || r.ID != records[0].ID {
			t.Fatal("retry consumed slot")
		}
		return nil
	})
	if e != nil || c.Outcome != store.TransactionCommitted {
		t.Fatal(c, e)
	}
	_, e = db.WritePrivateTransfer(ctx, func(d store.PrivateTransferDAO) error {
		_, _, err := transfercore.Create(ctx, d, transferRecord(user, now))
		return err
	})
	var fault *model.Fault
	if !errors.As(e, &fault) || fault.Code != "capacity_unavailable" {
		t.Fatalf("fifth slot %v", e)
	}
	var first model.PrivateTransfer
	_, e = db.WritePrivateTransfer(ctx, func(d store.PrivateTransferDAO) error {
		var err error
		first, err = transfercore.Reserve(ctx, d, records[0].ID, 60, 100)
		return err
	})
	if e != nil {
		t.Fatal(e)
	}
	_, e = db.WritePrivateTransfer(ctx, func(d store.PrivateTransferDAO) error {
		_, err := transfercore.Reserve(ctx, d, records[1].ID, 41, 100)
		return err
	})
	if !errors.As(e, &fault) || fault.Code != "capacity_unavailable" {
		t.Fatalf("budget %v", e)
	}
	_, e = db.WritePrivateTransfer(ctx, func(d store.PrivateTransferDAO) error {
		var err error
		first.State = "cleanup_pending"
		first, err = transfercore.Update(ctx, d, first, first.Version)
		return err
	})
	if e != nil {
		t.Fatal(e)
	}
	_, e = db.WritePrivateTransfer(ctx, func(d store.PrivateTransferDAO) error {
		total, err := d.ReservedTotal(ctx)
		if err != nil {
			return err
		}
		if total != 60 {
			t.Fatalf("pending bytes %d", total)
		}
		_, _, err = transfercore.Create(ctx, d, transferRecord(user, now))
		return err
	})
	if !errors.As(e, &fault) || fault.Code != "capacity_unavailable" {
		t.Fatalf("pending slot %v", e)
	}
	_, e = db.WritePrivateTransfer(ctx, func(d store.PrivateTransferDAO) error {
		var err error
		first, err = transfercore.Close(ctx, d, first.ID, first.Version, now.Add(24*time.Hour))
		return err
	})
	if e != nil || first.ReservedBytes != 0 || first.State != "closed" {
		t.Fatalf("close %+v %v", first, e)
	}
	_, e = db.WritePrivateTransfer(ctx, func(d store.PrivateTransferDAO) error {
		total, err := d.ReservedTotal(ctx)
		if err != nil {
			return err
		}
		if total != 0 {
			t.Fatalf("released bytes %d", total)
		}
		_, _, err = transfercore.Create(ctx, d, transferRecord(user, now))
		return err
	})
	if e != nil {
		t.Fatal(e)
	}
	_, e = db.WritePrivateTransfer(ctx, func(d store.PrivateTransferDAO) error {
		_, err := transfercore.Update(ctx, d, records[0], records[0].Version)
		return err
	})
	if !errors.Is(e, model.ErrNotFound) {
		t.Fatalf("stale update %v", e)
	}
	_, e = db.WritePrivateTransfer(ctx, func(d store.PrivateTransferDAO) error {
		n, err := transfercore.Prune(ctx, d, now.Add(23*time.Hour), 100)
		if err != nil {
			return err
		}
		if n != 0 {
			t.Fatal("pruned early")
		}
		n, err = transfercore.Prune(ctx, d, now.Add(25*time.Hour), 100)
		if n != 1 {
			t.Fatalf("prune %d", n)
		}
		return err
	})
	if e != nil {
		t.Fatal(e)
	}
}

func TestPrivateTransferConcurrentCapacity(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	db := isolatedStore(t)
	now := time.Now().UTC()
	var records []model.PrivateTransfer
	for i := 0; i < 2; i++ {
		r := transferRecord(uuid.NewString(), now)
		_, err := db.WritePrivateTransfer(ctx, func(d store.PrivateTransferDAO) error { _, _, err := transfercore.Create(ctx, d, r); return err })
		if err != nil {
			t.Fatal(err)
		}
		records = append(records, r)
	}
	var wg sync.WaitGroup
	results := make(chan error, 2)
	for _, r := range records {
		wg.Add(1)
		go func(id string) {
			defer wg.Done()
			_, err := db.WritePrivateTransfer(ctx, func(d store.PrivateTransferDAO) error { _, e := transfercore.Reserve(ctx, d, id, 70, 100); return e })
			results <- err
		}(r.ID)
	}
	wg.Wait()
	close(results)
	success := 0
	fail := 0
	for err := range results {
		if err == nil {
			success++
		} else {
			var fault *model.Fault
			if !errors.As(err, &fault) || fault.Code != "capacity_unavailable" {
				t.Fatal(err)
			}
			fail++
		}
	}
	if success != 1 || fail != 1 {
		t.Fatalf("success %d failure %d", success, fail)
	}
}

func TestPrivateTransferAuthorityAdmission(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	db := isolatedStore(t)
	now := time.Now().UTC().Truncate(time.Microsecond)
	projectID, taskID := uuid.NewString(), uuid.NewString()
	if _, err := db.CreateProject(ctx, projectID, "private transfer", "https://example.test/repo"); err != nil {
		t.Fatal(err)
	}
	var user string
	if err := db.Pool.QueryRow(ctx, `SELECT m.user_id::text FROM project_ownership o JOIN team_members m ON m.team_id=o.team_id WHERE o.project_id=$1`, projectID).Scan(&user); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Pool.Exec(ctx, `INSERT INTO tasks(id,project_id,title) VALUES($1,$2,'test')`, taskID, projectID); err != nil {
		t.Fatal(err)
	}
	grant, access, otherGrant, otherAccess := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	for _, x := range []struct {
		g, a string
		n    byte
	}{{grant, access, 1}, {otherGrant, otherAccess, 2}} {
		hash := make([]byte, 32)
		hash[0] = x.n
		if _, err := db.Pool.Exec(ctx, `INSERT INTO oauth_grants(id,user_id,client_id,client_snapshot,resource,scope,created_at,expires_at) VALUES($1,$2,'client','{}','https://example.test/mcp','daynight:mcp',$3,$4)`, x.g, user, now, now.Add(time.Hour)); err != nil {
			t.Fatal(err)
		}
		if _, err := db.Pool.Exec(ctx, `INSERT INTO oauth_access_tokens(id,grant_id,user_id,token_hash,created_at,expires_at) VALUES($1,$2,$3,$4,$5,$6)`, x.a, x.g, user, hash, now, now.Add(30*time.Minute)); err != nil {
			t.Fatal(err)
		}
	}
	principal := model.Principal{Kind: model.OAuthCredential, UserID: user, CredentialID: access}
	authorize := func(p model.Principal, kind, id string) error {
		_, err := db.WritePrivateTransfer(ctx, func(d store.PrivateTransferDAO) error { return d.Authorize(ctx, p, kind, id, projectID, taskID) })
		return err
	}
	if err := authorize(principal, "oauth", grant); err != nil {
		t.Fatal(err)
	}
	blocker, err := db.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer blocker.Rollback(ctx)
	var pid int32
	if err := blocker.QueryRow(ctx, `SELECT pg_backend_pid()`).Scan(&pid); err != nil {
		t.Fatal(err)
	}
	if _, err := blocker.Exec(ctx, `SELECT 1 FROM project_ownership WHERE project_id=$1 FOR UPDATE`, projectID); err != nil {
		t.Fatal(err)
	}
	newExpiringAccess := func(marker byte) (string, time.Time) {
		t.Helper()
		id := uuid.NewString()
		hash := make([]byte, 32)
		hash[0] = marker
		var expiry time.Time
		if err := db.Pool.QueryRow(ctx, `INSERT INTO oauth_access_tokens(id,grant_id,user_id,token_hash,created_at,expires_at)
			VALUES($1,$2,$3,$4,$5,clock_timestamp()+interval '500 milliseconds') RETURNING expires_at`, id, grant, user, hash, now).Scan(&expiry); err != nil {
			t.Fatal(err)
		}
		return id, expiry
	}
	waitForExpiry := func(expiry time.Time) {
		t.Helper()
		var live bool
		if err := db.Pool.QueryRow(ctx, `SELECT $1::timestamptz>clock_timestamp()`, expiry).Scan(&live); err != nil {
			t.Fatal(err)
		}
		if !live {
			t.Fatal("credential expired before its lock wait was observed")
		}
		if _, err := db.Pool.Exec(ctx, `SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM ($1::timestamptz-clock_timestamp())))+0.005)`, expiry); err != nil {
			t.Fatal(err)
		}
	}
	// The credential stays locked while real database time crosses its expiry.
	shortAccess, shortExpiry := newExpiringAccess(3)
	shortPrincipal := principal
	shortPrincipal.CredentialID = shortAccess
	result := make(chan error, 1)
	go func() { result <- authorize(shortPrincipal, "oauth", grant) }()
	for {
		var waiting bool
		if err := db.Pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)))`, pid).Scan(&waiting); err != nil {
			t.Fatal(err)
		}
		if waiting {
			break
		}
		select {
		case err := <-result:
			t.Fatalf("authorization finished without waiting: %v", err)
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		case <-time.After(10 * time.Millisecond):
		}
	}
	waitForExpiry(shortExpiry)
	if err := blocker.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if err := <-result; err == nil {
		t.Fatal("credential expired while waiting but was admitted")
	}
	// The ledger can be contended after authorization. Expiry while waiting
	// must roll back a reservation instead of accepting an expired credential.
	transfer := transferRecord(user, now)
	transfer.ProjectID = projectID
	transfer.TaskID = taskID
	transfer.AuthorityKind = "oauth"
	transfer.AuthorityID = grant
	if _, err := db.WritePrivateTransfer(ctx, func(d store.PrivateTransferDAO) error {
		var e error
		transfer, _, e = transfercore.Create(ctx, d, transfer)
		return e
	}); err != nil {
		t.Fatal(err)
	}
	ledgerBlocker, err := db.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer ledgerBlocker.Rollback(ctx)
	if err := ledgerBlocker.QueryRow(ctx, `SELECT pg_backend_pid()`).Scan(&pid); err != nil {
		t.Fatal(err)
	}
	if _, err := ledgerBlocker.Exec(ctx, `SELECT 1 FROM private_transfer_ledger WHERE singleton FOR UPDATE`); err != nil {
		t.Fatal(err)
	}
	ledgerAccess, ledgerExpiry := newExpiringAccess(4)
	ledgerPrincipal := principal
	ledgerPrincipal.CredentialID = ledgerAccess
	go func() {
		_, e := db.WritePrivateTransfer(ctx, func(d store.PrivateTransferDAO) error {
			if _, e := d.Get(ctx, transfer.ID); e != nil {
				return e
			}
			if e := d.Authorize(ctx, ledgerPrincipal, "oauth", grant, projectID, taskID); e != nil {
				return e
			}
			_, e := transfercore.Reserve(ctx, d, transfer.ID, 10, 100)
			return e
		})
		result <- e
	}()
	for {
		var waiting bool
		if err := db.Pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)))`, pid).Scan(&waiting); err != nil {
			t.Fatal(err)
		}
		if waiting {
			break
		}
		select {
		case e := <-result:
			t.Fatalf("reservation finished without waiting: %v", e)
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		case <-time.After(10 * time.Millisecond):
		}
	}
	waitForExpiry(ledgerExpiry)
	if err := ledgerBlocker.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if err := <-result; err == nil {
		t.Fatal("expired credential reserved after waiting for ledger")
	}
	if _, err := db.WritePrivateTransfer(ctx, func(d store.PrivateTransferDAO) error {
		r, e := d.Get(ctx, transfer.ID)
		if e != nil {
			return e
		}
		if r.ReservedBytes != 0 {
			t.Fatal("expired credential reservation committed")
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if err := authorize(principal, "oauth", otherGrant); err == nil {
		t.Fatal("wrong grant admitted")
	}
	swapped := principal
	swapped.UserID = uuid.NewString()
	if err := authorize(swapped, "oauth", grant); err == nil {
		t.Fatal("wrong user admitted")
	}
	if _, err := db.Pool.Exec(ctx, `UPDATE oauth_grants SET revoked_at=now() WHERE id=$1`, grant); err != nil {
		t.Fatal(err)
	}
	if err := authorize(principal, "oauth", grant); err == nil {
		t.Fatal("revoked grant admitted")
	}
	principal.CredentialID = otherAccess
	if err := authorize(principal, "oauth", otherGrant); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Pool.Exec(ctx, `UPDATE tasks SET deleted_at=now() WHERE id=$1`, taskID); err != nil {
		t.Fatal(err)
	}
	if err := authorize(principal, "oauth", otherGrant); !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("deleted task: %v", err)
	}
	if _, err := db.Pool.Exec(ctx, `UPDATE tasks SET deleted_at=NULL WHERE id=$1`, taskID); err != nil {
		t.Fatal(err)
	}
	if err := authorize(principal, "oauth", otherGrant); err != nil {
		t.Fatalf("restored task: %v", err)
	}
	if _, err := db.Pool.Exec(ctx, `UPDATE projects SET deleted_at=now() WHERE id=$1`, projectID); err != nil {
		t.Fatal(err)
	}
	if err := authorize(principal, "oauth", otherGrant); !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("deleted project: %v", err)
	}
}

func TestPrivateTransferMaterializationAndRollback(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	db := isolatedStore(t)
	now := time.Now().UTC()
	r := transferRecord(uuid.NewString(), now)
	_, err := db.WritePrivateTransfer(ctx, func(d store.PrivateTransferDAO) error {
		var e error
		r, _, e = transfercore.Create(ctx, d, r)
		if e != nil {
			return e
		}
		r, e = transfercore.Reserve(ctx, d, r.ID, 100, 100)
		return e
	})
	if err != nil {
		t.Fatal(err)
	}
	abort := errors.New("receipt did not commit")
	_, err = db.WritePrivateTransfer(ctx, func(d store.PrivateTransferDAO) error {
		_, e := transfercore.ConsumeReservation(ctx, d, r.ID, 60, r.Version)
		if e != nil {
			return e
		}
		return abort
	})
	if !errors.Is(err, abort) {
		t.Fatal(err)
	}
	_, err = db.WritePrivateTransfer(ctx, func(d store.PrivateTransferDAO) error {
		current, e := d.Get(ctx, r.ID)
		if e != nil {
			return e
		}
		total, e := d.OutstandingTotal(ctx)
		if e != nil {
			return e
		}
		if total != 100 || current.OutstandingBytes != 100 {
			t.Fatal("rollback lost unmaterialized reservation", total, current)
		}
		r, e = transfercore.ConsumeReservation(ctx, d, r.ID, 60, r.Version)
		return e
	})
	if err != nil {
		t.Fatal(err)
	}
	if r.OutstandingBytes != 40 || r.ReservedBytes != 100 {
		t.Fatalf("materialization %+v", r)
	}
	_, err = db.WritePrivateTransfer(ctx, func(d store.PrivateTransferDAO) error {
		_, e := transfercore.ConsumeReservation(ctx, d, r.ID, 41, r.Version)
		return e
	})
	if !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("overconsume %v", err)
	}
	_, err = db.WritePrivateTransfer(ctx, func(d store.PrivateTransferDAO) error {
		_, e := transfercore.ConsumeReservation(ctx, d, r.ID, 40, r.Version-1)
		return e
	})
	if !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("stale consumption %v", err)
	}
	_, err = db.WritePrivateTransfer(ctx, func(d store.PrivateTransferDAO) error {
		total, e := d.ReservedTotal(ctx)
		if e != nil {
			return e
		}
		outstanding, e := d.OutstandingTotal(ctx)
		if e != nil {
			return e
		}
		if total != 100 || outstanding != 40 {
			t.Fatalf("ledger %d/%d", total, outstanding)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestPrivateTransferDueFairnessAndLeases(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	db := isolatedStore(t)
	now := time.Now().UTC().Truncate(time.Microsecond)
	var ids []string
	_, err := db.WritePrivateTransfer(ctx, func(d store.PrivateTransferDAO) error {
		for i := 0; i < 101; i++ {
			r := transferRecord(uuid.NewString(), now.Add(-2*time.Hour))
			r.ExpiresAt = now.Add(-time.Hour)
			r.HardExpiresAt = now.Add(time.Hour)
			var e error
			r, _, e = transfercore.Create(ctx, d, r)
			if e != nil {
				return e
			}
			ids = append(ids, r.ID)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	seen := make(map[string]bool)
	_, err = db.WritePrivateTransfer(ctx, func(d store.PrivateTransferDAO) error {
		due, e := transfercore.Due(ctx, d, now, 100)
		if e != nil {
			return e
		}
		if len(due) != 100 {
			t.Fatalf("first batch %d", len(due))
		}
		for _, r := range due {
			seen[r.ID] = true
			if r.LastCleanupAttempt == nil || r.Version != 2 {
				t.Fatalf("attempt %+v", r)
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.WritePrivateTransfer(ctx, func(d store.PrivateTransferDAO) error {
		due, e := transfercore.Due(ctx, d, now.Add(time.Second), 1)
		if e != nil {
			return e
		}
		if len(due) != 1 || seen[due[0].ID] {
			t.Fatal("failed records starved later record", due)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	// In a fresh set, expired committing leases are due before idle expiry,
	// while a still valid lease protects even an idle-expired operation.
	_, err = db.WritePrivateTransfer(ctx, func(d store.PrivateTransferDAO) error {
		for _, active := range []bool{false, true} {
			r := transferRecord(uuid.NewString(), now)
			r.State = "committing"
			lease := now.Add(-time.Second)
			if active {
				lease = now.Add(time.Hour)
				r.ExpiresAt = now.Add(-time.Second)
			}
			r.LeaseUntil = &lease
			var e error
			r, _, e = transfercore.Create(ctx, d, r)
			if e != nil {
				return e
			}
			ids = append(ids, r.ID)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for round := 2; round <= 3; round++ {
		_, err = db.WritePrivateTransfer(ctx, func(d store.PrivateTransferDAO) error {
			due, e := transfercore.Due(ctx, d, now.Add(time.Duration(round)*time.Second), 100)
			if e != nil {
				return e
			}
			for _, r := range due {
				if r.ID == ids[101] {
					found = true
				}
				if r.ID == ids[102] {
					t.Fatal("unexpired lease included")
				}
			}
			return nil
		})
		if err != nil {
			t.Fatal(err)
		}
	}
	if !found {
		t.Fatal("expired commit lease not scheduled")
	}
}

func TestPrivateTransferReservationOverflow(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	db := isolatedStore(t)
	r := transferRecord(uuid.NewString(), time.Now().UTC())
	_, err := db.WritePrivateTransfer(ctx, func(d store.PrivateTransferDAO) error {
		var e error
		r, _, e = transfercore.Create(ctx, d, r)
		if e != nil {
			return e
		}
		r, e = transfercore.Reserve(ctx, d, r.ID, math.MaxInt64, math.MaxInt64)
		return e
	})
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.WritePrivateTransfer(ctx, func(d store.PrivateTransferDAO) error {
		_, e := transfercore.Reserve(ctx, d, r.ID, 1, math.MaxInt64)
		return e
	})
	var f *model.Fault
	if !errors.As(err, &f) || f.Code != "capacity_unavailable" {
		t.Fatalf("overflow %v", err)
	}
	_, err = db.WritePrivateTransfer(ctx, func(d store.PrivateTransferDAO) error {
		total, e := d.ReservedTotal(ctx)
		if e != nil {
			return e
		}
		outstanding, e := d.OutstandingTotal(ctx)
		if e != nil {
			return e
		}
		if total != math.MaxInt64 || outstanding != total {
			t.Fatalf("overflow mutated ledger %d %d", total, outstanding)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestPrivateTransferStats(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	db := isolatedStore(t)
	now := time.Now().UTC().Truncate(time.Microsecond)
	_, err := db.WritePrivateTransfer(ctx, func(d store.PrivateTransferDAO) error {
		stats, e := d.Stats(ctx)
		if e != nil {
			return e
		}
		if stats.ReservedBytes != 0 || stats.CleanupPending != 0 || stats.OldestPendingCreatedAt != nil {
			t.Fatalf("empty stats %+v", stats)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.WritePrivateTransfer(ctx, func(d store.PrivateTransferDAO) error {
		for i := 0; i < 2; i++ {
			r := transferRecord(uuid.NewString(), now.Add(time.Duration(i)*time.Minute))
			var e error
			r, _, e = transfercore.Create(ctx, d, r)
			if e != nil {
				return e
			}
			r, e = transfercore.Reserve(ctx, d, r.ID, int64((i+1)*5), 100)
			if e != nil {
				return e
			}
			r.State = "cleanup_pending"
			if _, e = transfercore.Update(ctx, d, r, r.Version); e != nil {
				return e
			}
		}
		stats, e := d.Stats(ctx)
		if e != nil {
			return e
		}
		if stats.ReservedBytes != 15 || stats.CleanupPending != 2 || stats.OldestPendingCreatedAt == nil || !stats.OldestPendingCreatedAt.Equal(now) {
			t.Fatalf("pending stats %+v", stats)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestPrivateTransferAuthorizationWaitDoesNotBlockOtherUsers(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	db := isolatedStore(t)
	now := time.Now().UTC()
	type fixture struct {
		r model.PrivateTransfer
		p model.Principal
	}
	makeFixture := func(n byte) fixture {
		project, task := uuid.NewString(), uuid.NewString()
		if _, err := db.CreateProject(ctx, project, "private transfer", "https://example.test/repo"); err != nil {
			t.Fatal(err)
		}
		var user string
		if err := db.Pool.QueryRow(ctx, `SELECT m.user_id::text FROM project_ownership o JOIN team_members m ON m.team_id=o.team_id WHERE o.project_id=$1`, project).Scan(&user); err != nil {
			t.Fatal(err)
		}
		if _, err := db.Pool.Exec(ctx, `INSERT INTO tasks(id,project_id,title) VALUES($1,$2,'test')`, task, project); err != nil {
			t.Fatal(err)
		}
		pat := uuid.NewString()
		hash := make([]byte, 32)
		hash[0] = n
		if _, err := db.Pool.Exec(ctx, `INSERT INTO personal_access_tokens(id,user_id,token_hash,name,created_at,expires_at) VALUES($1,$2,$3,'test',$4,$5)`, pat, user, hash, now, now.Add(time.Hour)); err != nil {
			t.Fatal(err)
		}
		r := transferRecord(user, now)
		r.ProjectID = project
		r.TaskID = task
		r.AuthorityID = pat
		_, err := db.WritePrivateTransfer(ctx, func(d store.PrivateTransferDAO) error {
			var e error
			r, _, e = transfercore.Create(ctx, d, r)
			return e
		})
		if err != nil {
			t.Fatal(err)
		}
		return fixture{r, model.Principal{Kind: model.PATCredential, UserID: user, CredentialID: pat}}
	}
	a, b := makeFixture(31), makeFixture(32)
	blocker, err := db.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer blocker.Rollback(ctx)
	var pid int32
	if err := blocker.QueryRow(ctx, `SELECT pg_backend_pid()`).Scan(&pid); err != nil {
		t.Fatal(err)
	}
	if _, err := blocker.Exec(ctx, `SELECT 1 FROM project_ownership WHERE project_id=$1 FOR UPDATE`, a.r.ProjectID); err != nil {
		t.Fatal(err)
	}
	result := make(chan error, 1)
	go func() {
		_, e := db.WritePrivateTransfer(ctx, func(d store.PrivateTransferDAO) error {
			if _, e := d.Get(ctx, a.r.ID); e != nil {
				return e
			}
			return d.Authorize(ctx, a.p, "pat", a.r.AuthorityID, a.r.ProjectID, a.r.TaskID)
		})
		result <- e
	}()
	for {
		var waiting bool
		if err := db.Pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)))`, pid).Scan(&waiting); err != nil {
			t.Fatal(err)
		}
		if waiting {
			break
		}
		select {
		case e := <-result:
			t.Fatalf("did not wait: %v", e)
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		case <-time.After(10 * time.Millisecond):
		}
	}
	quick, stop := context.WithTimeout(ctx, 2*time.Second)
	defer stop()
	_, err = db.WritePrivateTransfer(quick, func(d store.PrivateTransferDAO) error {
		r, e := d.Get(quick, b.r.ID)
		if e != nil {
			return e
		}
		if e = d.Authorize(quick, b.p, "pat", b.r.AuthorityID, b.r.ProjectID, b.r.TaskID); e != nil {
			return e
		}
		r.State = "cleanup_pending"
		_, e = transfercore.Update(quick, d, r, r.Version)
		return e
	})
	if err != nil {
		t.Fatalf("other user status/abort blocked: %v", err)
	}
	if err := blocker.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if err := <-result; err != nil {
		t.Fatal(err)
	}
}

func TestPrivateTransferConcurrentCreateSlots(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	db := isolatedStore(t)
	now := time.Now().UTC()
	user := uuid.NewString()
	var wg sync.WaitGroup
	results := make(chan error, 8)
	for i := 0; i < 8; i++ {
		r := transferRecord(user, now)
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := db.WritePrivateTransfer(ctx, func(d store.PrivateTransferDAO) error { _, _, e := transfercore.Create(ctx, d, r); return e })
			results <- err
		}()
	}
	wg.Wait()
	close(results)
	success := 0
	rejected := 0
	for e := range results {
		if e == nil {
			success++
			continue
		}
		var f *model.Fault
		if !errors.As(e, &f) || f.Code != "capacity_unavailable" {
			t.Fatal(e)
		}
		rejected++
	}
	if success != 4 || rejected != 4 {
		t.Fatalf("slot race successes=%d rejected=%d", success, rejected)
	}
}

func TestPrivateTransferConcurrentCreateReserveClose(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	db := isolatedStore(t)
	now := time.Now().UTC()
	user := uuid.NewString()
	pending := transferRecord(user, now)
	reserved := transferRecord(user, now)
	for _, r := range []*model.PrivateTransfer{&pending, &reserved} {
		_, err := db.WritePrivateTransfer(ctx, func(d store.PrivateTransferDAO) error {
			var e error
			*r, _, e = transfercore.Create(ctx, d, *r)
			return e
		})
		if err != nil {
			t.Fatal(err)
		}
	}
	_, err := db.WritePrivateTransfer(ctx, func(d store.PrivateTransferDAO) error {
		var e error
		pending, e = transfercore.Reserve(ctx, d, pending.ID, 20, 100)
		if e != nil {
			return e
		}
		pending.State = "cleanup_pending"
		pending, e = transfercore.Update(ctx, d, pending, pending.Version)
		return e
	})
	if err != nil {
		t.Fatal(err)
	}
	results := make(chan error, 3)
	var wg sync.WaitGroup
	for i := 0; i < 3; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			_, e := db.WritePrivateTransfer(ctx, func(d store.PrivateTransferDAO) error {
				switch i {
				case 0:
					_, _, e := transfercore.Create(ctx, d, transferRecord(user, now))
					return e
				case 1:
					_, e := transfercore.Reserve(ctx, d, reserved.ID, 30, 100)
					return e
				default:
					_, e := transfercore.Close(ctx, d, pending.ID, pending.Version, now.Add(24*time.Hour))
					return e
				}
			})
			results <- e
		}(i)
	}
	wg.Wait()
	close(results)
	for e := range results {
		if e != nil {
			t.Fatal(e)
		}
	}
}

func TestPrivateTransferRejectsInvalidStoredDirection(t *testing.T) {
	ctx := t.Context()
	db := isolatedStore(t)
	record := transferRecord(uuid.NewString(), time.Now().UTC())
	record.Direction = "invalid"
	completion, err := db.WritePrivateTransfer(ctx, func(d store.PrivateTransferDAO) error {
		_, _, err := d.Insert(ctx, record)
		return err
	})
	if err == nil || completion.Outcome != store.TransactionNotCommitted {
		t.Fatalf("invalid direction committed: %+v %v", completion, err)
	}
}

func TestPrivateTransferLateReceiptPersistsThroughClose(t *testing.T) {
	ctx := t.Context()
	db := isolatedStore(t)
	now := time.Now().UTC()
	record := transferRecord(uuid.NewString(), now)
	_, err := db.WritePrivateTransfer(ctx, func(d store.PrivateTransferDAO) error {
		var err error
		record, _, err = transfercore.Create(ctx, d, record)
		if err != nil {
			return err
		}
		record, err = transfercore.Reserve(ctx, d, record.ID, 10, 100)
		if err != nil {
			return err
		}
		record.State = "cleanup_pending"
		record, err = transfercore.Update(ctx, d, record, record.Version)
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	state := "committed"
	record.CleanupFromState = &state
	record.Data = []byte(`{"operationId":"result"}`)
	_, err = db.WritePrivateTransfer(ctx, func(d store.PrivateTransferDAO) error {
		var err error
		record, err = transfercore.UpdatePending(ctx, d, record, record.Version)
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	if record.State != "cleanup_pending" || record.CleanupFromState == nil || *record.CleanupFromState != "committed" || record.ReservedBytes != 10 {
		t.Fatalf("late result lost cleanup obligation: %+v", record)
	}
	_, err = db.WritePrivateTransfer(ctx, func(d store.PrivateTransferDAO) error {
		var err error
		record, err = transfercore.Close(ctx, d, record.ID, record.Version, now.Add(time.Hour))
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	if record.CleanupFromState == nil || *record.CleanupFromState != "committed" || string(record.Data) != `{"operationId": "result"}` {
		t.Fatalf("close lost receipt: %+v", record)
	}
}

func TestPrivateTransferDatabaseFailuresRollback(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	db := isolatedStore(t)
	now := time.Now().UTC()
	r := transferRecord(uuid.NewString(), now)
	_, err := db.WritePrivateTransfer(ctx, func(d store.PrivateTransferDAO) error {
		var e error
		r, _, e = transfercore.Create(ctx, d, r)
		if e != nil {
			return e
		}
		r, e = transfercore.Reserve(ctx, d, r.ID, 10, 100)
		return e
	})
	if err != nil {
		t.Fatal(err)
	}
	fail := func(op func(*privateTransferDAO) error) {
		t.Helper()
		completion, err := db.WritePrivateTransfer(ctx, func(d store.PrivateTransferDAO) error { return op(d.(*privateTransferDAO)) })
		if err == nil || completion.Outcome != store.TransactionNotCommitted {
			t.Fatalf("failure did not roll back: %+v %v", completion, err)
		}
	}
	deleteLedger := func(d *privateTransferDAO) error {
		_, e := d.tx.Exec(ctx, `DELETE FROM private_transfer_ledger`)
		return e
	}
	fail(func(d *privateTransferDAO) error {
		if _, e := d.tx.Exec(ctx, `UPDATE private_transfers SET path='uncommitted' WHERE id=$1`, r.ID); e != nil {
			return e
		}
		if _, e := d.tx.Exec(ctx, `ALTER TABLE private_transfers RENAME TO unavailable_private_transfers`); e != nil {
			return e
		}
		_, e := d.CountActive(ctx, r.UserID)
		if failed, state := store.DatabaseErrorFacts(e); !failed || state != "42P01" {
			t.Fatalf("count failure lost database cause: %v", e)
		}
		return e
	})
	fail(func(d *privateTransferDAO) error {
		if _, e := d.tx.Exec(ctx, `UPDATE private_transfers SET path='uncommitted' WHERE id=$1`, r.ID); e != nil {
			return e
		}
		if _, e := d.tx.Exec(ctx, `CREATE FUNCTION reject_transfer_reservation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected ledger failure'; END $$; CREATE TRIGGER reject_transfer_reservation BEFORE UPDATE ON private_transfer_ledger FOR EACH ROW EXECUTE FUNCTION reject_transfer_reservation()`); e != nil {
			return e
		}
		_, e := transfercore.Reserve(ctx, d, r.ID, 1, 100)
		if failed, state := store.DatabaseErrorFacts(e); !failed || state != "P0001" {
			t.Fatalf("reservation failure lost database cause: %v", e)
		}
		return e
	})
	for _, total := range []func(*privateTransferDAO) (int64, error){func(d *privateTransferDAO) (int64, error) { return d.ReservedTotal(ctx) }, func(d *privateTransferDAO) (int64, error) { return d.OutstandingTotal(ctx) }} {
		fail(func(d *privateTransferDAO) error {
			if e := deleteLedger(d); e != nil {
				return e
			}
			_, e := total(d)
			return e
		})
		fail(func(d *privateTransferDAO) error {
			if e := d.LockLedger(ctx); e != nil {
				return e
			}
			if e := deleteLedger(d); e != nil {
				return e
			}
			_, e := total(d)
			return e
		})
	}
	fail(func(d *privateTransferDAO) error {
		if e := deleteLedger(d); e != nil {
			return e
		}
		_, _, e := transfercore.Create(ctx, d, transferRecord(uuid.NewString(), now))
		return e
	})
	fail(func(d *privateTransferDAO) error {
		if e := deleteLedger(d); e != nil {
			return e
		}
		_, e := transfercore.Reserve(ctx, d, r.ID, 1, 100)
		return e
	})
	fail(func(d *privateTransferDAO) error {
		if e := d.LockLedger(ctx); e != nil {
			return e
		}
		if e := deleteLedger(d); e != nil {
			return e
		}
		_, e := transfercore.Reserve(ctx, d, r.ID, 1, 100)
		return e
	})
	fail(func(d *privateTransferDAO) error {
		if e := deleteLedger(d); e != nil {
			return e
		}
		_, e := transfercore.ConsumeReservation(ctx, d, r.ID, 1, r.Version)
		return e
	})
	fail(func(d *privateTransferDAO) error {
		if _, e := d.tx.Exec(ctx, `UPDATE private_transfer_ledger SET outstanding_bytes=0`); e != nil {
			return e
		}
		_, e := transfercore.ConsumeReservation(ctx, d, r.ID, 1, r.Version)
		return e
	})
	fail(func(d *privateTransferDAO) error {
		if e := d.LockLedger(ctx); e != nil {
			return e
		}
		if _, e := d.tx.Exec(ctx, `DROP TABLE private_transfer_ledger`); e != nil {
			return e
		}
		_, e := transfercore.ConsumeReservation(ctx, d, r.ID, 1, r.Version)
		return e
	})
	fail(func(d *privateTransferDAO) error {
		if _, e := d.tx.Exec(ctx, `DROP TABLE private_transfer_ledger`); e != nil {
			return e
		}
		_, e := d.Stats(ctx)
		return e
	})
	fail(func(d *privateTransferDAO) error {
		if _, e := d.tx.Exec(ctx, `DROP TABLE private_transfers`); e != nil {
			return e
		}
		_, e := transfercore.Due(ctx, d, now, 10)
		return e
	})
	fail(func(d *privateTransferDAO) error {
		if _, e := d.tx.Exec(ctx, `DROP TABLE private_transfers`); e != nil {
			return e
		}
		_, e := transfercore.Prune(ctx, d, now, 10)
		return e
	})
	_, err = db.WritePrivateTransfer(ctx, func(d store.PrivateTransferDAO) error {
		var e error
		r.State = "cleanup_pending"
		r, e = transfercore.Update(ctx, d, r, r.Version)
		return e
	})
	if err != nil {
		t.Fatal(err)
	}
	fail(func(d *privateTransferDAO) error {
		if e := deleteLedger(d); e != nil {
			return e
		}
		_, e := transfercore.Close(ctx, d, r.ID, r.Version, now)
		return e
	})
	fail(func(d *privateTransferDAO) error {
		if _, e := d.tx.Exec(ctx, `UPDATE private_transfer_ledger SET reserved_bytes=0,outstanding_bytes=0`); e != nil {
			return e
		}
		_, e := transfercore.Close(ctx, d, r.ID, r.Version, now)
		return e
	})
	fail(func(d *privateTransferDAO) error {
		if e := d.LockLedger(ctx); e != nil {
			return e
		}
		if _, e := d.tx.Exec(ctx, `DROP TABLE private_transfer_ledger`); e != nil {
			return e
		}
		_, e := transfercore.Close(ctx, d, r.ID, r.Version, now)
		return e
	})
	_, err = db.WritePrivateTransfer(ctx, func(d store.PrivateTransferDAO) error {
		got, e := d.Get(ctx, r.ID)
		if e != nil {
			return e
		}
		total, e := d.ReservedTotal(ctx)
		if e != nil {
			return e
		}
		if got.State != "cleanup_pending" || got.Path != r.Path || got.ReservedBytes != 10 || got.OutstandingBytes != 10 || total != 10 {
			t.Fatalf("failed operations altered record or ledger: %+v total=%d", got, total)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}
