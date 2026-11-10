package webhook

import (
	"context"
	"errors"
	"fmt"
	"net"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	wm "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// The worker owns its connection after launch. Publishing its result happens
// after rollback and connection close, so observation cannot race cleanup.
func startWebhookBoundaryTransaction(ctx context.Context, conn *pgx.Conn, work func(pgx.Tx) error) (<-chan error, <-chan struct{}) {
	result, done := make(chan error, 1), make(chan struct{})
	go func() {
		defer close(done)
		result <- func() (err error) {
			defer func() {
				cleanup, cancel := context.WithTimeout(context.Background(), 2*time.Second)
				defer cancel()
				if closeErr := conn.Close(cleanup); closeErr != nil {
					err = errors.Join(err, closeErr)
				}
			}()
			tx, err := conn.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
			if err != nil {
				return err
			}
			defer func() {
				cleanup, cancel := context.WithTimeout(context.Background(), 2*time.Second)
				defer cancel()
				if rollbackErr := tx.Rollback(cleanup); rollbackErr != nil && rollbackErr != pgx.ErrTxClosed {
					err = errors.Join(err, rollbackErr)
				}
			}()
			return work(tx)
		}()
	}()
	return result, done
}

func drainWebhookBoundaryTransaction(t *testing.T, cancel context.CancelFunc, blocker pgx.Tx, conn *pgx.Conn, done <-chan struct{}) {
	t.Helper()
	cancel()
	cleanup, stop := context.WithTimeout(context.Background(), 6*time.Second)
	defer stop()
	if err := blocker.Rollback(cleanup); err != nil && err != pgx.ErrTxClosed {
		t.Errorf("release boundary blocker: %v", err)
	}
	select {
	case <-done:
		return
	case <-cleanup.Done():
		t.Error("boundary transaction worker did not drain after cancellation")
	}
	// net.Conn.Close is safe during a blocked read; pgx.Conn.Close is not.
	if err := conn.PgConn().Conn().Close(); err != nil && !errors.Is(err, net.ErrClosed) {
		t.Errorf("interrupt boundary socket: %v", err)
	}
	forced, stopForced := context.WithTimeout(context.Background(), 3*time.Second)
	defer stopForced()
	select {
	case <-done:
	case <-forced.Done():
		t.Error("boundary transaction worker remained active after socket close")
	}
}

func awaitWebhookRowBlock(t *testing.T, ctx context.Context, observer *pgx.Conn, blocker, reader uint32, result <-chan error) {
	t.Helper()
	for {
		var blocked bool
		if err := observer.QueryRow(ctx, `SELECT $1::integer = ANY(pg_blocking_pids($2))`, blocker, reader).Scan(&blocked); err != nil {
			t.Fatal(err)
		}
		if blocked {
			return
		}
		select {
		case err := <-result:
			t.Fatalf("operation returned before row lock wait: %v", err)
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		case <-time.After(5 * time.Millisecond):
		}
	}
}

func testActorAdmissionChecksAnchorsBeforeSourceLocks(t *testing.T, conn *pgx.Conn) {
	f := newDeliveryFailureFixture(t, conn)
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	locker, err := pgx.Connect(ctx, f.conn.Config().ConnString())
	if err != nil {
		t.Fatal(err)
	}
	defer locker.Close(context.Background())
	locked, err := locker.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer locked.Rollback(context.Background())
	if _, err = locked.Exec(ctx, `SELECT id FROM tasks WHERE project_id=$1 FOR UPDATE`, f.project); err != nil {
		t.Fatal(err)
	}
	for _, mismatch := range []struct {
		name, endpoint string
		owner          wm.Owner
	}{
		{"endpoint", uuid.NewString(), wm.Owner{Kind: "personal", ID: f.user}},
		{"owner", f.endpoint, wm.Owner{Kind: "personal", ID: uuid.NewString()}},
	} {
		t.Run(mismatch.name, func(t *testing.T) {
			tx, err := f.conn.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer tx.Rollback(context.Background())
			_, err = New(tx).AdmissionSourcesForActor(ctx, f.delivery, mismatch.endpoint, mismatch.owner, f.user, time.Now())
			if !errors.Is(err, model.ErrNotFound) {
				t.Fatalf("mismatched anchor crossed source lock: %v", err)
			}
		})
	}
}

func testActorAdmissionWaitsForCurrentTeamMembership(t *testing.T, conn *pgx.Conn) {
	f := newDeliveryFailureFixture(t, conn)
	ctx, cancel := context.WithTimeout(t.Context(), 8*time.Second)
	defer cancel()
	for _, table := range []string{"webhook_endpoints", "webhook_subscriptions", "webhook_deliveries"} {
		if _, err := f.conn.Exec(ctx, `UPDATE `+table+` SET owner_kind='team',owner_id=$1`, f.team); err != nil {
			t.Fatal(err)
		}
	}
	writer, err := pgx.Connect(ctx, f.conn.Config().ConnString())
	if err != nil {
		t.Fatal(err)
	}
	defer writer.Close(context.Background())
	reader, err := pgx.Connect(ctx, f.conn.Config().ConnString())
	if err != nil {
		t.Fatal(err)
	}
	readerTransferred := false
	defer func() {
		if !readerTransferred {
			if err := reader.Close(context.Background()); err != nil {
				t.Error(err)
			}
		}
	}()
	locked, err := writer.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer locked.Rollback(context.Background())
	if _, err = locked.Exec(ctx, `DELETE FROM team_members WHERE team_id=$1 AND user_id=$2`, f.team, f.user); err != nil {
		t.Fatal(err)
	}
	readerPID := reader.PgConn().PID()
	result, done := startWebhookBoundaryTransaction(ctx, reader, func(tx pgx.Tx) error {
		sources, err := New(tx).AdmissionSourcesForActor(ctx, f.delivery, f.endpoint, wm.Owner{Kind: "team", ID: f.team}, f.user, time.Now())
		if err == nil && (!sources.ProjectEligible || !sources.TaskPresent || !sources.EndpointPresent) {
			err = fmt.Errorf("valid owner anchors lost after membership wait")
		}
		if err == nil {
			var present bool
			err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM team_members WHERE team_id=$1 AND user_id=$2)`, f.team, f.user).Scan(&present)
			if err == nil && present {
				err = fmt.Errorf("actor membership did not reflect committed revocation")
			}
		}
		return err
	})
	readerTransferred = true
	defer drainWebhookBoundaryTransaction(t, cancel, locked, reader, done)
	awaitWebhookRowBlock(t, ctx, f.conn, writer.PgConn().PID(), readerPID, result)
	if err = locked.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case err = <-result:
		if err != nil {
			t.Fatal(err)
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
}

func testRetentionCandidateDeadlineAndActivityPredicates(t *testing.T, conn *pgx.Conn) {
	f := newDeliveryFailureFixture(t, conn)
	ctx := t.Context()
	now := time.Now().UTC().Add(31 * 24 * time.Hour).Truncate(time.Microsecond)
	for _, c := range []struct {
		name, phase, state                string
		metadata, payload, expires, lease time.Time
		closed, found                     bool
	}{
		{"close before metadata", "close", "failed", now.Add(time.Microsecond), now, now, time.Time{}, false, false},
		{"close at metadata", "close", "failed", now, now, now, time.Time{}, false, true},
		{"close live pending", "close", "pending", now, now, now.Add(time.Second), time.Time{}, false, false},
		{"close live lease", "close", "leased", now, now, now, now.Add(time.Second), false, false},
		{"close lease at deadline", "close", "leased", now, now, now, now, false, true},
		{"payload before expiry", "payload", "failed", now, now.Add(time.Microsecond), now, time.Time{}, false, false},
		{"payload at expiry", "payload", "failed", now, now, now, time.Time{}, false, true},
		{"payload live pending", "payload", "pending", now, now, now.Add(time.Second), time.Time{}, false, false},
		{"payload live lease", "payload", "leased", now, now, now, now.Add(time.Second), false, false},
		{"payload lease at deadline", "payload", "leased", now, now, now, now, false, true},
		{"payload already closed", "payload", "failed", now, now, now, time.Time{}, true, false},
		{"purge closed", "purge", "failed", now, now, now, time.Time{}, true, true},
		{"purge open", "purge", "failed", now, now, now, time.Time{}, false, false},
	} {
		t.Run(c.name, func(t *testing.T) {
			tx, err := f.conn.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer tx.Rollback(context.Background())
			var purging, token, claimed, until, generation any
			if c.closed {
				purging = now
			}
			if c.state == "leased" {
				token = uuid.NewString()
				claimed = now.Add(-time.Second)
				until = c.lease
				generation = int64(1)
			}
			// Shift the immutable source time and schedule together so policy
			// retention identities remain valid at the exact payload boundary.
			occurred := c.payload.Add(-168 * time.Hour)
			_, err = tx.Exec(ctx, `UPDATE webhook_deliveries SET state=$2,metadata_expires_at=$3,occurred_at=$4,automatic_schedule_at=ARRAY(SELECT x+($4::timestamptz-occurred_at) FROM unnest(automatic_schedule_at) x),automatic_expires_at=$4::timestamptz+interval '72 hours',payload_expires_at=$5,expires_at=$6,purging_at=$7,lease_token=$8,lease_claimed_at=$9,lease_until=$10,lease_generation=$11 WHERE id=$1`, f.delivery, c.state, c.metadata, occurred, c.payload, c.expires, purging, token, claimed, until, generation)
			if err != nil {
				t.Fatal(err)
			}
			got, found, err := New(tx).LockRetentionCandidate(ctx, c.phase, now)
			if err != nil || found != c.found || (found && got.ID != f.delivery) {
				t.Fatalf("candidate found=%v id=%s err=%v", found, got.ID, err)
			}
		})
	}
}

func testRetentionCandidateSkipsLockedDelivery(t *testing.T, conn *pgx.Conn) {
	f := newDeliveryFailureFixture(t, conn)
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	now := time.Now().UTC().Add(31 * 24 * time.Hour)
	locker, err := pgx.Connect(ctx, f.conn.Config().ConnString())
	if err != nil {
		t.Fatal(err)
	}
	defer locker.Close(context.Background())
	locked, err := locker.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer locked.Rollback(context.Background())
	if _, err = New(locked).LockDelivery(ctx, f.delivery); err != nil {
		t.Fatal(err)
	}
	tx, err := f.conn.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	if _, found, err := New(tx).LockRetentionCandidate(ctx, "close", now); err != nil || found {
		t.Fatalf("locked retention row was not skipped: found=%v err=%v", found, err)
	}
	if err = tx.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	if err = locked.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	tx, err = f.conn.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	if row, found, err := New(tx).LockRetentionCandidate(ctx, "close", now); err != nil || !found || row.ID != f.delivery {
		t.Fatalf("released retention row unavailable: found=%v err=%v", found, err)
	}
}

func testHistoryMetadataExpiresUsingFreshTransactionClock(t *testing.T, conn *pgx.Conn) {
	f := newDeliveryFailureFixture(t, conn)
	ctx, cancel := context.WithTimeout(t.Context(), 8*time.Second)
	defer cancel()
	var expiry time.Time
	if err := f.conn.QueryRow(ctx, `UPDATE webhook_deliveries SET state='failed',metadata_expires_at=clock_timestamp()+interval '1 second' WHERE id=$1 RETURNING metadata_expires_at`, f.delivery).Scan(&expiry); err != nil {
		t.Fatal(err)
	}
	read := func() ([]store.WebhookDelivery, error) {
		tx, err := f.conn.Begin(ctx)
		if err != nil {
			return nil, err
		}
		defer tx.Rollback(context.Background())
		return New(tx).HistoryDeliveries(ctx, wm.Owner{Kind: "personal", ID: f.user}, f.endpoint, time.Time{}, "", 1)
	}
	first, err := read()
	if err != nil || len(first) != 1 || first[0].ID != f.delivery {
		t.Fatalf("history before expiry: %+v %v", first, err)
	}
	for {
		var expired bool
		if err = f.conn.QueryRow(ctx, `SELECT clock_timestamp() >= $1`, expiry).Scan(&expired); err != nil {
			t.Fatal(err)
		}
		if expired {
			break
		}
		select {
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		case <-time.After(5 * time.Millisecond):
		}
	}
	rows, err := read()
	if err != nil || len(rows) != 0 {
		t.Fatalf("expired metadata remained in fresh history snapshot: %+v %v", rows, err)
	}
	var count int
	if err = f.conn.QueryRow(ctx, `SELECT count(*) FROM webhook_deliveries WHERE id=$1`, f.delivery).Scan(&count); err != nil || count != 1 {
		t.Fatalf("logical expiry deleted physical row: %d %v", count, err)
	}
}

func testRetentionClosureAndLateAttemptUseRealLockOrder(t *testing.T, conn *pgx.Conn, first string) {
	f := newDeliveryFailureFixture(t, conn)
	ctx, cancel := context.WithTimeout(t.Context(), 8*time.Second)
	defer cancel()
	setup, err := f.conn.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	slot := int16(1)
	now := time.Now().UTC().Truncate(time.Microsecond)
	attempt := store.WebhookAttempt{ID: uuid.NewString(), DeliveryID: f.delivery, EndpointID: f.endpoint, Trigger: "automatic", LeaseToken: uuid.NewString(), Generation: 1, DestinationRevision: 1, Sequence: 1, SigningKeyIDs: []string{uuid.NewString()}, AutomaticPlanSlot: &slot, ClaimedAt: now, AdmittedAt: now}
	if err = New(setup).InsertAttempt(ctx, attempt); err != nil {
		t.Fatal(err)
	}
	unknown := "unknown"
	attempt.FinishedAt, attempt.RecoveredUnknownAt, attempt.Outcome = &now, &now, &unknown
	if err = New(setup).UpdateAttempt(ctx, attempt); err != nil {
		t.Fatal(err)
	}
	if err = setup.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	one, err := pgx.Connect(ctx, f.conn.Config().ConnString())
	if err != nil {
		t.Fatal(err)
	}
	defer one.Close(context.Background())
	two, err := pgx.Connect(ctx, f.conn.Config().ConnString())
	if err != nil {
		t.Fatal(err)
	}
	readerTransferred := false
	defer func() {
		if !readerTransferred {
			if err := two.Close(context.Background()); err != nil {
				t.Error(err)
			}
		}
	}()
	locked, err := one.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer locked.Rollback(context.Background())
	if first == "late" {
		row, err := New(locked).LockOwnAttempt(ctx, attempt.ID)
		if err != nil {
			t.Fatal(err)
		}
		ack := "acknowledged"
		row.LateObservedAt, row.LateOutcome = &now, &ack
		if err = New(locked).UpdateAttempt(ctx, row); err != nil {
			t.Fatal(err)
		}
	} else {
		if _, err = New(locked).LockDelivery(ctx, f.delivery); err != nil {
			t.Fatal(err)
		}
		if _, err = New(locked).LockAttempts(ctx, f.delivery); err != nil {
			t.Fatal(err)
		}
		if _, err = New(locked).CloseRetention(ctx, f.delivery, now); err != nil {
			t.Fatal(err)
		}
	}
	readerPID := two.PgConn().PID()
	result, done := startWebhookBoundaryTransaction(ctx, two, func(tx pgx.Tx) (err error) {
		if first == "late" {
			if _, err = New(tx).LockDelivery(ctx, f.delivery); err == nil {
				if _, err = New(tx).LockAttempts(ctx, f.delivery); err == nil {
					_, err = New(tx).CloseRetention(ctx, f.delivery, now)
				}
			}
			if err == nil {
				err = tx.Commit(ctx)
			}
		} else {
			var row store.WebhookAttempt
			row, err = New(tx).LockOwnAttempt(ctx, attempt.ID)
			if err == nil && row.RetentionClosedAt == nil {
				err = fmt.Errorf("late writer did not reread closed attempt")
			}
			if err == nil {
				ack := "acknowledged"
				row.LateObservedAt, row.LateOutcome = &now, &ack
				if update := New(tx).UpdateAttempt(ctx, row); update == nil {
					err = fmt.Errorf("late update accepted closed attempt")
				}
			}
		}
		return err
	})
	readerTransferred = true
	defer drainWebhookBoundaryTransaction(t, cancel, locked, two, done)
	awaitWebhookRowBlock(t, ctx, f.conn, one.PgConn().PID(), readerPID, result)
	if err = locked.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case err = <-result:
		if err != nil {
			t.Fatal(err)
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	tx, err := f.conn.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	closed, err := New(tx).LockOwnAttempt(ctx, attempt.ID)
	if err != nil || closed.RetentionClosedAt == nil || ((closed.LateObservedAt != nil) != (first == "late")) {
		t.Fatalf("late/close result: %+v %v", closed, err)
	}
	if _, err = New(tx).HistoryDelivery(ctx, wm.Owner{Kind: "personal", ID: f.user}, f.endpoint, f.delivery); !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("late observation reopened closed history: %v", err)
	}
}
