package webhook_test

import (
	"context"
	"errors"
	"net"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/webhook"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestRetentionReceiptRealCommitLoss(t *testing.T) {
	f := newCaptureFixture(t, 1)
	var id string
	if err := f.db.Pool.QueryRow(f.ctx, `UPDATE webhook_operations SET recorded_at=clock_timestamp()-interval '31 days',expires_at=clock_timestamp()-interval '1 day' RETURNING operation_id::text`).Scan(&id); err != nil {
		t.Fatal(err)
	}
	loss := &deliveryCommitLoss{target: "delete from webhook_operations"}
	cfg := f.db.Pool.Config().Copy()
	cfg.MaxConns = 1
	cfg.ConnConfig.Tracer = loss
	cfg.ConnConfig.DialFunc = func(ctx context.Context, network, address string) (net.Conn, error) {
		c, err := (&net.Dialer{}).DialContext(ctx, network, address)
		if err != nil {
			return nil, err
		}
		return &deliveryDropConn{Conn: c, loss: loss}, nil
	}
	pool, err := pgxpool.NewWithConfig(f.ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	gc := webhook.NewRetention(&postgres.Store{Pool: pool})
	count, _, err := gc.Pass(f.ctx)
	var unknown *core.ReceiptGCUnknownError
	if !errors.As(err, &unknown) || count != 0 || !loss.observed.Load() || unknown.Identity.OperationID != id {
		t.Fatalf("missing uncertain receipt result: count=%d err=%v observed=%v", count, err, loss.observed.Load())
	}
	var present bool
	if err = f.db.Pool.QueryRow(f.ctx, `SELECT EXISTS(SELECT 1 FROM webhook_operations WHERE operation_id=$1)`, id).Scan(&present); err != nil || present {
		t.Fatalf("real commit not visible: present=%v err=%v", present, err)
	}
	if _, _, err = gc.Pass(f.ctx); err != nil {
		t.Fatalf("reconcile and rescan: %v", err)
	}
	if err = f.db.Pool.QueryRow(f.ctx, `SELECT EXISTS(SELECT 1 FROM webhook_operations WHERE operation_id=$1)`, id).Scan(&present); err != nil || present {
		t.Fatalf("receipt reappeared: %v", err)
	}
}
