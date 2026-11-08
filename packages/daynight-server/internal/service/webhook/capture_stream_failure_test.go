package webhook_test

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"net/url"
	"os"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var errCaptureStreamInterrupted = errors.New("injected interruption after frozen audience row")

type captureStreamControl struct {
	armed         atomic.Bool
	rowsDelivered atomic.Int32
	interrupted   atomic.Bool
}

func (c *captureStreamControl) TraceQueryStart(ctx context.Context, _ *pgx.Conn, q pgx.TraceQueryStartData) context.Context {
	if strings.Contains(q.SQL, "WITH facts AS MATERIALIZED") {
		c.armed.Store(true)
	}
	return ctx
}
func (*captureStreamControl) TraceQueryEnd(context.Context, *pgx.Conn, pgx.TraceQueryEndData) {}

// captureStreamConn forwards one complete PostgreSQL message at a time after the
// freeze query starts. It lets the first DataRow reach the driver and fails on
// the next, even when both were received in the same underlying TCP read.
type captureStreamConn struct {
	net.Conn
	control *captureStreamControl
	pending []byte
	row     bool
}

func (c *captureStreamConn) Read(p []byte) (int, error) {
	if !c.control.armed.Load() {
		return c.Conn.Read(p)
	}
	if len(c.pending) == 0 {
		var header [5]byte
		if _, err := io.ReadFull(c.Conn, header[:]); err != nil {
			return 0, err
		}
		length := binary.BigEndian.Uint32(header[1:])
		if length < 4 || length > 1<<20 {
			return 0, fmt.Errorf("invalid PostgreSQL message length %d", length)
		}
		if header[0] == 'D' && c.control.rowsDelivered.Load() > 0 {
			c.control.interrupted.Store(true)
			return 0, errCaptureStreamInterrupted
		}
		c.pending = make([]byte, int(length)+1)
		copy(c.pending, header[:])
		c.row = header[0] == 'D'
		if _, err := io.ReadFull(c.Conn, c.pending[5:]); err != nil {
			return 0, err
		}
	}
	n := copy(p, c.pending)
	c.pending = c.pending[n:]
	if len(c.pending) == 0 && c.row {
		c.control.rowsDelivered.Add(1)
		c.row = false
	}
	return n, nil
}

func TestCaptureAudienceStreamFailureAfterFirstDatabaseRowRollsBack(t *testing.T) {
	rawURL := os.Getenv("DAYNIGHT_TEST_DATABASE_URL")
	if rawURL == "" {
		t.Fatal("DAYNIGHT_TEST_DATABASE_URL is required for PostgreSQL tests")
	}
	parsed, err := url.Parse(rawURL)
	if err != nil {
		t.Fatalf("invalid test database URL: %v", err)
	}
	if parsed.Query().Get("sslmode") != "disable" {
		t.Skip("PostgreSQL frame proxy requires an explicitly non-TLS test database connection")
	}
	f := newCaptureFixture(t, 2)
	before := captureDatabaseFacts(t, f)
	var expected int
	if err := f.db.Pool.QueryRow(f.ctx, `SELECT count(*) FROM webhook_subscriptions s JOIN webhook_bindings b ON b.subscription_id=s.id WHERE s.project_id=$1 AND s.deleted_at IS NULL AND s.authorization_state='active' AND b.deleted_at IS NULL AND b.event_type='task.created'`, f.project).Scan(&expected); err != nil || expected != 2 {
		t.Fatalf("fixture matches=%d err=%v", expected, err)
	}
	control := &captureStreamControl{}
	config := f.db.Pool.Config().Copy()
	config.ConnConfig.Tracer = control
	// The explicit sslmode=disable admission above permits inspecting raw
	// PostgreSQL frames without changing the configured connection security.
	config.ConnConfig.DialFunc = func(ctx context.Context, network, address string) (net.Conn, error) {
		c, err := (&net.Dialer{}).DialContext(ctx, network, address)
		if err != nil {
			return nil, err
		}
		return &captureStreamConn{Conn: c, control: control}, nil
	}
	pool, err := pgxpool.NewWithConfig(f.ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	_, err = taskservice.NewTasks(&postgres.Store{Pool: pool}, f.capture).Create(f.ctx, f.principal, f.project, taskcore.CreateTask{Title: "must roll back after row"})
	if err == nil || !control.interrupted.Load() || control.rowsDelivered.Load() != 1 || !errors.Is(err, errCaptureStreamInterrupted) {
		t.Fatalf("interrupted=%t delivered=%d error=%v", control.interrupted.Load(), control.rowsDelivered.Load(), err)
	}
	if after := captureDatabaseFacts(t, f); after != before {
		t.Fatal("mid-stream failure changed source or notifications")
	}
}
