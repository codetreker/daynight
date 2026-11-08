package webhook_test

import (
	"bytes"
	"context"
	"crypto/x509"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/webhook"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/httpoutbound"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type deliveryCommitLoss struct {
	target                   string
	pending, armed, observed atomic.Bool
}

func (l *deliveryCommitLoss) TraceQueryStart(ctx context.Context, _ *pgx.Conn, q pgx.TraceQueryStartData) context.Context {
	sql := strings.ToLower(strings.TrimSpace(q.SQL))
	if strings.HasPrefix(sql, l.target) && !l.observed.Load() {
		l.pending.Store(true)
	}
	if sql == "commit" && l.pending.Swap(false) && !l.observed.Load() {
		l.armed.Store(true)
	}
	return ctx
}
func (*deliveryCommitLoss) TraceQueryEnd(context.Context, *pgx.Conn, pgx.TraceQueryEndData) {}

type deliveryDropConn struct {
	net.Conn
	loss *deliveryCommitLoss
}

func (c *deliveryDropConn) Read(p []byte) (int, error) {
	if !c.loss.armed.Load() {
		return c.Conn.Read(p)
	}
	var buf []byte
	for len(buf) < 4096 {
		n, err := c.Conn.Read(p)
		buf = append(buf, p[:n]...)
		if bytes.Contains(buf, []byte("COMMIT\x00")) {
			c.loss.observed.Store(true)
			return 0, io.ErrUnexpectedEOF
		}
		if err != nil {
			return 0, err
		}
	}
	return 0, errors.New("commit response lacked CommandComplete")
}

// The proxy only discards a real COMMIT CommandComplete, not a simulated DAO result.
func TestDeliveryLostCommitReceipts(t *testing.T) {
	for _, mode := range []string{"admission", "finalize"} {
		t.Run(mode, func(t *testing.T) {
			requests := make(chan struct{}, 4)
			receiver := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				requests <- struct{}{}
				w.WriteHeader(http.StatusAccepted)
			}))
			defer receiver.Close()
			f := newCaptureFixture(t, 1)
			var endpoint string
			var version int64
			if err := f.db.Pool.QueryRow(f.ctx, `SELECT id::text,config_version FROM webhook_endpoints`).Scan(&endpoint, &version); err != nil {
				t.Fatal(err)
			}
			svc := &webhook.Service{DB: f.db, Keys: f.capture.Keys, ConfigurationExpansionAvailable: true}
			m := webhook.Mutation{Kind: "endpoint.update", EndpointID: endpoint, OperationID: uuid.NewString(), IssuedAt: time.Now().UTC().Format(time.RFC3339Nano), ExpectedUserID: f.principal.UserID, IfVersion: version, RequestSHA256: strings.Repeat("a", 64), Destination: &webhook.Destination{Kind: "http", AdapterVersion: "1", URL: receiver.URL}}
			if _, err := svc.Mutate(f.ctx, f.principal, webhook.Owner{Kind: "personal", ID: f.principal.UserID}, m); err != nil {
				t.Fatal(err)
			}
			if _, err := taskservice.NewTasks(f.db, f.capture).Create(f.ctx, f.principal, f.project, taskcore.CreateTask{Title: "commit loss"}); err != nil {
				t.Fatal(err)
			}
			target := "insert into webhook_attempts"
			if mode == "finalize" {
				target = "update webhook_attempts set"
			}
			loss := &deliveryCommitLoss{target: target}
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
			db := &postgres.Store{Pool: pool}
			runner := newTestRunner(db, svc, true)
			roots := x509.NewCertPool()
			roots.AddCert(receiver.Certificate())
			runner.SetTestTransport(httpoutbound.NewForTesting(testResolver{}, func(ip netip.Addr) bool { return ip.IsLoopback() }, roots))
			if err := runner.Start(context.Background()); err != nil {
				t.Fatal(err)
			}
			defer func() {
				ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
				defer cancel()
				if err := runner.Stop(ctx); err != nil {
					t.Error(err)
				}
			}()
			deadline := time.After(12 * time.Second)
			for !loss.observed.Load() {
				select {
				case err := <-runner.Failures():
					t.Fatalf("runner failed: %v", err)
				case <-deadline:
					t.Fatal("PostgreSQL COMMIT acknowledgement was not observed and dropped")
				case <-time.After(20 * time.Millisecond):
				}
			}
			stopctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			if err := runner.Stop(stopctx); err != nil {
				cancel()
				t.Fatal(err)
			}
			cancel()
			var attempts, count int
			var state string
			var outcome *string
			if err := f.db.Pool.QueryRow(f.ctx, `SELECT d.state,d.automatic_attempt_count,(SELECT count(*) FROM webhook_attempts),(SELECT outcome FROM webhook_attempts LIMIT 1) FROM webhook_deliveries d`).Scan(&state, &count, &attempts, &outcome); err != nil {
				t.Fatal(err)
			}
			if attempts != 1 || count != 1 {
				t.Fatalf("attempts=%d automatic=%d state=%s", attempts, count, state)
			}
			if mode == "admission" {
				if state != "leased" || outcome != nil {
					t.Fatalf("admission: state=%s outcome=%v", state, outcome)
				}
				select {
				case <-requests:
					t.Fatal("sent after unknown admission")
				default:
				}
			} else {
				if state != "delivered" || outcome == nil || *outcome != "acknowledged" {
					t.Fatalf("finalize: state=%s outcome=%v", state, outcome)
				}
				select {
				case <-requests:
				default:
					t.Fatal("missing receiver acknowledgement")
				}
				select {
				case <-requests:
					t.Fatal("duplicate request")
				default:
				}
			}
		})
	}
}
