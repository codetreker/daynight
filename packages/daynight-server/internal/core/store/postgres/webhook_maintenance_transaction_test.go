package postgres

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type maintenanceReplyFault struct {
	command  string
	armed    atomic.Bool
	observed atomic.Bool
	once     sync.Once
	reached  chan struct{}
}

func (f *maintenanceReplyFault) TraceQueryStart(ctx context.Context, _ *pgx.Conn, q pgx.TraceQueryStartData) context.Context {
	if strings.EqualFold(strings.TrimSpace(q.SQL), f.command) && !f.observed.Load() {
		f.armed.Store(true)
	}
	return ctx
}
func (*maintenanceReplyFault) TraceQueryEnd(context.Context, *pgx.Conn, pgx.TraceQueryEndData) {}

type maintenanceFaultConn struct {
	net.Conn
	fault *maintenanceReplyFault
}

func (c *maintenanceFaultConn) Read(p []byte) (int, error) {
	if !c.fault.armed.Load() {
		return c.Conn.Read(p)
	}
	var observed []byte
	for len(observed) < 4096 {
		n, err := c.Conn.Read(p)
		observed = append(observed, p[:n]...)
		if bytes.Contains(observed, []byte(strings.ToUpper(c.fault.command)+"\x00")) {
			c.fault.observed.Store(true)
			c.fault.armed.Store(false)
			c.fault.once.Do(func() { close(c.fault.reached) })
			if c.fault.command == "commit" {
				return 0, io.ErrUnexpectedEOF
			}
			// ROLLBACK really completed, but its acknowledgement never reaches
			// the client. A subsequent read waits until its context expires.
			return c.Conn.Read(p)
		}
		if err != nil {
			return 0, err
		}
	}
	return 0, errors.New("missing transaction acknowledgement")
}

func maintenanceFaultPool(t *testing.T, base *Store, fault *maintenanceReplyFault) *pgxpool.Pool {
	t.Helper()
	config := base.Pool.Config().Copy()
	config.MaxConns = 1
	config.ConnConfig.Tracer = fault
	config.ConnConfig.DialFunc = func(ctx context.Context, network, address string) (net.Conn, error) {
		conn, err := (&net.Dialer{}).DialContext(ctx, network, address)
		if err != nil {
			return nil, err
		}
		return &maintenanceFaultConn{conn, fault}, nil
	}
	pool, err := pgxpool.NewWithConfig(context.Background(), config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func TestWebhookMaintenanceRollbackDeadlineAndCancellation(t *testing.T) {
	for _, mode := range []string{"deadline", "cancel"} {
		t.Run(mode, func(t *testing.T) {
			base := isolatedStore(t)
			if _, err := base.Pool.Exec(context.Background(), `CREATE TABLE maintenance_rollback_probe(id integer)`); err != nil {
				t.Fatal(err)
			}
			fault := &maintenanceReplyFault{command: "rollback", reached: make(chan struct{})}
			pool := maintenanceFaultPool(t, base, fault)
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			if mode == "cancel" {
				cancel()
				ctx, cancel = context.WithTimeout(context.Background(), 5*time.Second)
			}
			defer cancel()
			tx, err := pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			pid := tx.Conn().PgConn().PID()
			cause := errors.New("forced maintenance operation failure")
			if mode == "cancel" {
				go func() {
					select {
					case <-fault.reached:
						cancel()
					case <-ctx.Done():
					}
				}()
			}
			start := time.Now()
			err = transactWebhookMaintenance(ctx, tx, func(tx pgx.Tx) error {
				if _, e := tx.Exec(ctx, `INSERT INTO maintenance_rollback_probe VALUES(1)`); e != nil {
					return e
				}
				return cause
			})
			elapsed := time.Since(start)
			var result *store.TransactionError
			if !errors.As(err, &result) || result.Outcome != store.TransactionUnknown || !result.CleanupFailed || result.CommitAttempted || !errors.Is(err, cause) || !fault.observed.Load() {
				t.Fatalf("rollback result %#v: %v", result, err)
			}
			if elapsed > 1900*time.Millisecond {
				t.Fatalf("rollback exceeded activation budget: %s", elapsed)
			}
			var count int
			if err = base.Pool.QueryRow(context.Background(), `SELECT count(*) FROM maintenance_rollback_probe`).Scan(&count); err != nil || count != 0 {
				t.Fatalf("independent observation %d: %v", count, err)
			}
			var replacement uint32
			observe, stop := context.WithTimeout(context.Background(), 3*time.Second)
			defer stop()
			if err = pool.QueryRow(observe, `SELECT pg_backend_pid()`).Scan(&replacement); err != nil || replacement == pid {
				t.Fatalf("uncertain connection reused: old=%d new=%d err=%v", pid, replacement, err)
			}
		})
	}
}

func TestWebhookMaintenanceCommitReplyUnknown(t *testing.T) {
	base := isolatedStore(t)
	if _, err := base.Pool.Exec(context.Background(), `CREATE TABLE maintenance_commit_probe(id integer)`); err != nil {
		t.Fatal(err)
	}
	fault := &maintenanceReplyFault{command: "commit", reached: make(chan struct{})}
	pool := maintenanceFaultPool(t, base, fault)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	pid := tx.Conn().PgConn().PID()
	err = transactWebhookMaintenance(ctx, tx, func(tx pgx.Tx) error {
		_, e := tx.Exec(ctx, `INSERT INTO maintenance_commit_probe VALUES(1)`)
		return e
	})
	var result *store.TransactionError
	if !errors.As(err, &result) || result.Outcome != store.TransactionUnknown || !result.CommitAttempted || !fault.observed.Load() {
		t.Fatalf("commit result %#v: %v", result, err)
	}
	var count int
	if err = base.Pool.QueryRow(context.Background(), `SELECT count(*) FROM maintenance_commit_probe`).Scan(&count); err != nil || count != 1 {
		t.Fatalf("independent commit observation %d: %v", count, err)
	}
	var replacement uint32
	observe, stop := context.WithTimeout(context.Background(), 3*time.Second)
	defer stop()
	if err = pool.QueryRow(observe, `SELECT pg_backend_pid()`).Scan(&replacement); err != nil || replacement == pid {
		t.Fatalf("uncertain connection reused: old=%d new=%d err=%v", pid, replacement, err)
	}
}
