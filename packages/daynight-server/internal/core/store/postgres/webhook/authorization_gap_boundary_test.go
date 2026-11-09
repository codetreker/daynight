package webhook

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/eligibility"
	wm "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
	"github.com/jackc/pgx/v5"
)

func TestEligibilityUnionAndCommittedAuthorizationGap(t *testing.T) {
	for _, first := range []string{"grant", "membership"} {
		t.Run(first, func(t *testing.T) {
			f := newDeliveryFailureFixture(t)
			ctx := t.Context()
			owner := wm.Owner{Kind: "personal", ID: f.user}
			write := func(work func(pgx.Tx) error) {
				t.Helper()
				tx, err := f.conn.Begin(ctx)
				if err != nil {
					t.Fatal(err)
				}
				defer tx.Rollback(context.Background())
				if err = work(tx); err != nil {
					t.Fatal(err)
				}
				if err = tx.Commit(ctx); err != nil {
					t.Fatal(err)
				}
			}
			assertCurrent := func(status, state string, epoch int64) {
				t.Helper()
				tx, err := f.conn.Begin(ctx)
				if err != nil {
					t.Fatal(err)
				}
				defer tx.Rollback(context.Background())
				current, err := eligibility.New(tx).ReadEligibility(ctx, owner, f.project, f.user)
				if err != nil || current.Status != status {
					t.Fatalf("current eligibility: %+v %v", current, err)
				}
				var gotState string
				var gotEpoch int64
				if err = tx.QueryRow(ctx, `SELECT authorization_state,authorization_epoch FROM webhook_subscriptions WHERE endpoint_id=$1`, f.endpoint).Scan(&gotState, &gotEpoch); err != nil || gotState != state || gotEpoch != epoch {
					t.Fatalf("subscription after source commit: %s %d %v", gotState, gotEpoch, err)
				}
			}
			write(func(tx pgx.Tx) error {
				_, err := tx.Exec(ctx, `INSERT INTO project_grants(project_id,user_id,role) VALUES($1,$2,'member')`, f.project, f.user)
				return err
			})
			// Remove one source while the other remains. A fresh committed
			// observation must keep the union eligible and preserve epoch one.
			write(func(tx pgx.Tx) error {
				var err error
				if first == "grant" {
					_, err = tx.Exec(ctx, `DELETE FROM team_members WHERE team_id=$1 AND user_id=$2`, f.team, f.user)
				} else {
					_, err = tx.Exec(ctx, `DELETE FROM project_grants WHERE project_id=$1 AND user_id=$2`, f.project, f.user)
				}
				return err
			})
			assertCurrent("eligible", "active", 1)
			write(func(tx pgx.Tx) error {
				var err error
				if first == "grant" {
					_, err = tx.Exec(ctx, `DELETE FROM project_grants WHERE project_id=$1 AND user_id=$2`, f.project, f.user)
				} else {
					_, err = tx.Exec(ctx, `DELETE FROM team_members WHERE team_id=$1 AND user_id=$2`, f.team, f.user)
				}
				if err != nil {
					return err
				}
				dao := eligibility.New(tx)
				rows, err := dao.LockAffected(ctx, store.WebhookEligibilityFilter{ProjectID: f.project, UserID: f.user})
				if err != nil {
					return err
				}
				current, err := dao.ReadEligibility(ctx, owner, f.project, f.user)
				if err != nil {
					return err
				}
				if current.Status != "access_revoked" || len(rows) != 1 || rows[0].Epoch != 1 {
					return fmt.Errorf("committed gap input was not observed")
				}
				return dao.Revoke(ctx, rows[0].ID, rows[0].Epoch)
			})
			assertCurrent("access_revoked", "confirmation_required", 2)
			write(func(tx pgx.Tx) error {
				var err error
				if first == "grant" {
					_, err = tx.Exec(ctx, `INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'member')`, f.team, f.user)
				} else {
					_, err = tx.Exec(ctx, `INSERT INTO project_grants(project_id,user_id,role) VALUES($1,$2,'member')`, f.project, f.user)
				}
				return err
			})
			assertCurrent("eligible", "confirmation_required", 2)
		})
	}
}

func TestEligibilityUnionRechecksAfterSubscriptionLockWait(t *testing.T) {
	f := newDeliveryFailureFixture(t)
	ctx, cancel := context.WithTimeout(t.Context(), 8*time.Second)
	defer cancel()
	if _, err := f.conn.Exec(ctx, `INSERT INTO project_grants(project_id,user_id,role) VALUES($1,$2,'member')`, f.project, f.user); err != nil {
		t.Fatal(err)
	}
	if _, err := f.conn.Exec(ctx, `DELETE FROM team_members WHERE team_id=$1 AND user_id=$2`, f.team, f.user); err != nil {
		t.Fatal(err)
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
	membership, err := writer.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		t.Fatal(err)
	}
	defer membership.Rollback(context.Background())
	if _, err = membership.Exec(ctx, `INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'member')`, f.team, f.user); err != nil {
		t.Fatal(err)
	}
	owner := wm.Owner{Kind: "personal", ID: f.user}
	locked, err := eligibility.New(membership).LockAffected(ctx, store.WebhookEligibilityFilter{TeamID: f.team, UserID: f.user})
	if err != nil || len(locked) != 1 {
		t.Fatalf("membership subscription fence: %v %v", locked, err)
	}
	readerPID := reader.PgConn().PID()
	result, done := startWebhookBoundaryTransaction(ctx, reader, func(tx pgx.Tx) (err error) {
		if _, err = tx.Exec(ctx, `DELETE FROM project_grants WHERE project_id=$1 AND user_id=$2`, f.project, f.user); err == nil {
			dao := eligibility.New(tx)
			var rows []store.WebhookAuthorization
			rows, err = dao.LockAffected(ctx, store.WebhookEligibilityFilter{ProjectID: f.project, UserID: f.user})
			if err == nil && (len(rows) != 1 || rows[0].State != "active" || rows[0].Epoch != 1) {
				err = fmt.Errorf("subscription changed during source handoff")
			}
			if err == nil {
				current, readErr := dao.ReadEligibility(ctx, owner, f.project, f.user)
				err = readErr
				if err == nil && current.Status != "eligible" {
					err = fmt.Errorf("fresh read missed committed membership after subscription wait")
				}
			}
		}
		if err == nil {
			err = tx.Commit(ctx)
		}
		return err
	})
	readerTransferred = true
	defer drainWebhookBoundaryTransaction(t, cancel, membership, reader, done)
	awaitWebhookRowBlock(t, ctx, f.conn, writer.PgConn().PID(), readerPID, result)
	current, err := eligibility.New(membership).ReadEligibility(ctx, owner, f.project, f.user)
	if err != nil || current.Status != "eligible" {
		t.Fatalf("uncommitted membership and committed grant union: %+v %v", current, err)
	}
	if err = membership.Commit(ctx); err != nil {
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
	var state string
	var epoch int64
	if err = f.conn.QueryRow(ctx, `SELECT authorization_state,authorization_epoch FROM webhook_subscriptions WHERE endpoint_id=$1`, f.endpoint).Scan(&state, &epoch); err != nil || state != "active" || epoch != 1 {
		t.Fatalf("continuous source handoff changed authorization: %s %d %v", state, epoch, err)
	}
}
