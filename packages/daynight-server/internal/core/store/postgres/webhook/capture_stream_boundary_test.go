package webhook

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	wm "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

var errAudienceFrameInterrupted = errors.New("audience stream interrupted after first row")

type audienceFrameControl struct {
	armed       atomic.Bool
	rows        atomic.Int32
	interrupted atomic.Bool
}

func (c *audienceFrameControl) TraceQueryStart(ctx context.Context, _ *pgx.Conn, q pgx.TraceQueryStartData) context.Context {
	if strings.Contains(q.SQL, "WITH facts AS MATERIALIZED") {
		c.armed.Store(true)
	}
	return ctx
}

func (*audienceFrameControl) TraceQueryEnd(context.Context, *pgx.Conn, pgx.TraceQueryEndData) {}

type audienceFrameConn struct {
	net.Conn
	control *audienceFrameControl
	pending []byte
	row     bool
}

// Forward one complete frame at a time so the first DataRow reaches pgx even
// when PostgreSQL sent both rows in one TCP read; fail before the next row.
func (c *audienceFrameConn) Read(p []byte) (int, error) {
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
			return 0, fmt.Errorf("invalid PostgreSQL frame length %d", length)
		}
		if header[0] == 'D' && c.control.rows.Load() > 0 {
			c.control.interrupted.Store(true)
			return 0, errAudienceFrameInterrupted
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
		c.control.rows.Add(1)
		c.row = false
	}
	return n, nil
}

func testAudiencePartialStreamFailureDiscardsSourceTransaction(t *testing.T, conn *pgx.Conn) {
	f := newDeliveryFailureFixture(t, conn)
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	if f.conn.Config().TLSConfig != nil {
		t.Fatal("PostgreSQL frame proof requires the documented sslmode=disable test database")
	}
	setup, err := f.conn.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer setup.Rollback(context.Background())
	now := time.Now().UTC().Truncate(time.Microsecond)
	endpoint := wm.Endpoint{ID: uuid.NewString(), Owner: wm.Owner{Kind: "personal", ID: f.user}, Name: "second receiver", Enabled: true, ConfigVersion: 1, DestinationRevision: 1, DestinationKind: "http", AdapterVersion: "1", Origin: "https://example.test", DestinationConfiguration: sampleDestination(), ActiveKeyID: uuid.NewString(), CreatedAt: now, UpdatedAt: now}
	dao := New(setup)
	if err = dao.PutEndpoint(ctx, endpoint); err != nil {
		t.Fatal(err)
	}
	sub := wm.Subscription{ID: uuid.NewString(), EndpointID: endpoint.ID, ProjectID: f.project, Owner: endpoint.Owner, AuthorizationState: "active", AuthorizationEpoch: 1, CreatedAt: now, UpdatedAt: now}
	if err = dao.PutSubscription(ctx, sub); err != nil {
		t.Fatal(err)
	}
	if err = dao.PutBinding(ctx, wm.Binding{ID: uuid.NewString(), SubscriptionID: sub.ID, EventType: "task.created", CreatedAt: now}); err != nil {
		t.Fatal(err)
	}
	if err = setup.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	control := &audienceFrameControl{}
	config := f.conn.Config().Copy()
	config.Tracer = control
	config.DialFunc = func(ctx context.Context, network, address string) (net.Conn, error) {
		conn, err := (&net.Dialer{}).DialContext(ctx, network, address)
		if err != nil {
			return nil, err
		}
		return &audienceFrameConn{Conn: conn, control: control}, nil
	}
	reader, err := pgx.ConnectConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close(context.Background())
	pid := reader.PgConn().PID()
	tx, err := reader.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	source := uuid.NewString()
	if _, err = tx.Exec(ctx, `INSERT INTO tasks(id,project_id,title) VALUES($1,$2,'partial stream source')`, source, f.project); err != nil {
		t.Fatal(err)
	}
	audience, err := NewProjectCapture(tx, f.project).FreezeAudience(ctx, f.project, []string{"task.created"})
	if !errors.Is(err, errAudienceFrameInterrupted) || !control.interrupted.Load() || control.rows.Load() != 1 || len(audience) != 0 {
		t.Fatalf("partial audience returned: rows=%d interrupted=%v audience=%+v error=%v", control.rows.Load(), control.interrupted.Load(), audience, err)
	}
	if err = reader.Close(ctx); err != nil {
		t.Fatal(err)
	}
	for {
		var gone bool
		if err = f.conn.QueryRow(ctx, `SELECT NOT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid=$1)`, pid).Scan(&gone); err != nil {
			t.Fatal(err)
		}
		if gone {
			break
		}
		select {
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		case <-time.After(5 * time.Millisecond):
		}
	}
	var count int
	if err = f.conn.QueryRow(ctx, `SELECT count(*) FROM tasks WHERE id=$1`, source).Scan(&count); err != nil || count != 0 {
		t.Fatalf("failed stream committed source: %d %v", count, err)
	}
}

func testCapturedAuthorizationEpochDoesNotBecomeContinuousOnRegrant(t *testing.T, conn *pgx.Conn) {
	f := newDeliveryFailureFixture(t, conn)
	ctx := t.Context()
	for _, state := range []struct {
		authorization string
		epoch         int64
	}{
		{"confirmation_required", 2}, {"active", 3},
	} {
		if _, err := f.conn.Exec(ctx, `UPDATE webhook_subscriptions SET authorization_state=$1,authorization_epoch=$2 WHERE project_id=$3`, state.authorization, state.epoch, f.project); err != nil {
			t.Fatal(err)
		}
		tx, err := f.conn.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		sources, err := New(tx).AdmissionSources(ctx, f.delivery, time.Now())
		if err != nil || len(sources.Matches) != 1 || sources.Matches[0].AuthorizationEpoch != 1 || sources.Matches[0].Continuous {
			t.Fatalf("old proof changed on regrant: %+v %v", sources.Matches, err)
		}
		if err = tx.Rollback(ctx); err != nil {
			t.Fatal(err)
		}
	}
	tx, err := f.conn.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	if _, err = tx.Exec(ctx, `UPDATE tasks SET updated_at=statement_timestamp() WHERE project_id=$1`, f.project); err != nil {
		t.Fatal(err)
	}
	audience, err := NewProjectCapture(tx, f.project).FreezeAudience(ctx, f.project, []string{"task.created"})
	if err != nil || len(audience) != 1 || audience[0].AuthorizationEpoch != 3 {
		t.Fatalf("new capture did not use current confirmed epoch: %+v %v", audience, err)
	}
	var epoch int64
	if err = tx.QueryRow(ctx, `SELECT authorization_epoch FROM webhook_delivery_matches WHERE delivery_id=$1`, f.delivery).Scan(&epoch); err != nil || epoch != 1 {
		t.Fatalf("regrant rewrote original proof: %d %v", epoch, err)
	}
}
