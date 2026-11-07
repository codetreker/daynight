package webhook_test

import (
	"bytes"
	"context"
	"crypto/x509"
	"encoding/base64"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"os"
	"os/exec"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/webhook"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/httpoutbound"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secretbox"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

type finalizeExitConn struct {
	net.Conn
	loss *deliveryCommitLoss
}

func (c *finalizeExitConn) Read(p []byte) (int, error) {
	if !c.loss.armed.Load() {
		return c.Conn.Read(p)
	}
	var received []byte
	for len(received) < 4096 {
		n, err := c.Conn.Read(p)
		received = append(received, p[:n]...)
		if bytes.Contains(received, []byte("COMMIT\x00")) {
			_, _ = io.WriteString(os.Stderr, "finalize COMMIT response discarded before process exit\n")
			os.Exit(0)
		}
		if err != nil {
			return 0, err
		}
	}
	return 0, io.ErrUnexpectedEOF
}

// The first child discards the real finalized COMMIT response and exits at that
// boundary. A separately started process runs the delivery pool against the same
// database; neither process is a production application binary.
func TestDeliveryFinalizeReceiptLossProcessRestart(t *testing.T) {
	if mode := os.Getenv("DAYNIGHT_T07_FINALIZE_MODE"); mode != "" {
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		cfg, err := pgxpool.ParseConfig(os.Getenv("DAYNIGHT_T07_FINALIZE_DB"))
		if err != nil {
			t.Fatal(err)
		}
		if mode == "lose" {
			cfg.MaxConns = 1
			loss := &deliveryCommitLoss{target: "update webhook_attempts set"}
			cfg.ConnConfig.Tracer = loss
			cfg.ConnConfig.DialFunc = func(ctx context.Context, network, address string) (net.Conn, error) {
				conn, err := (&net.Dialer{}).DialContext(ctx, network, address)
				if err != nil {
					return nil, err
				}
				return &finalizeExitConn{Conn: conn, loss: loss}, nil
			}
		}
		pool, err := pgxpool.NewWithConfig(ctx, cfg)
		if err != nil {
			t.Fatal(err)
		}
		defer pool.Close()
		raw := base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{1}, 32))
		keys, err := secretbox.Parse([]byte(`{"activeKeyId":"primary","keys":{"primary":"` + raw + `"}}`))
		if err != nil {
			t.Fatal(err)
		}
		db := &postgres.Store{Pool: pool}
		svc := &webhook.Service{DB: db, Keys: keys}
		der, err := base64.StdEncoding.DecodeString(os.Getenv("DAYNIGHT_T07_FINALIZE_CERT"))
		if err != nil {
			t.Fatal(err)
		}
		cert, err := x509.ParseCertificate(der)
		if err != nil {
			t.Fatal(err)
		}
		roots := x509.NewCertPool()
		roots.AddCert(cert)
		runner := webhook.NewRunner(db, svc, true)
		runner.SetTestTransport(httpoutbound.NewForTesting(testResolver{}, func(ip netip.Addr) bool { return ip.IsLoopback() }, roots))
		if err = runner.Start(ctx); err != nil {
			t.Fatal(err)
		}
		if mode == "restart" {
			select {
			case err := <-runner.Failures():
				t.Fatalf("restart failure: %v", err)
			case <-time.After(1500 * time.Millisecond):
			}
			stop, done := context.WithTimeout(context.Background(), 5*time.Second)
			defer done()
			if err = runner.Stop(stop); err != nil {
				t.Fatal(err)
			}
			return
		}
		select {
		case err := <-runner.Failures():
			t.Fatalf("sender failure before receipt loss: %v", err)
		case <-ctx.Done():
			t.Fatal("finalize response was not intercepted")
		}
	}
	var requests atomic.Int64
	receiver := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { requests.Add(1); w.WriteHeader(http.StatusAccepted) }))
	defer receiver.Close()
	f := newCaptureFixture(t, 1)
	var endpoint string
	var version int64
	if err := f.db.Pool.QueryRow(f.ctx, `SELECT id::text,config_version FROM webhook_endpoints`).Scan(&endpoint, &version); err != nil {
		t.Fatal(err)
	}
	svc := &webhook.Service{DB: f.db, Keys: f.capture.Keys, ConfigurationExpansionAvailable: true}
	_, err := svc.Mutate(f.ctx, f.principal, webhook.Owner{Kind: "personal", ID: f.principal.UserID}, webhook.Mutation{Kind: "endpoint.update", EndpointID: endpoint, OperationID: uuid.NewString(), IssuedAt: time.Now().UTC().Format(time.RFC3339Nano), ExpectedUserID: f.principal.UserID, IfVersion: version, RequestSHA256: strings.Repeat("a", 64), Destination: &webhook.Destination{Kind: "http", AdapterVersion: "1", URL: receiver.URL}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = taskservice.NewTasks(f.db, f.capture).Create(f.ctx, f.principal, f.project, taskcore.CreateTask{Title: "finalize lost receipt"}); err != nil {
		t.Fatal(err)
	}
	run := func(mode string) string {
		t.Helper()
		cmd := exec.CommandContext(f.ctx, os.Args[0], "-test.run=^TestDeliveryFinalizeReceiptLossProcessRestart$", "-test.count=1")
		cmd.Env = append(os.Environ(), "DAYNIGHT_T07_FINALIZE_MODE="+mode, "DAYNIGHT_T07_FINALIZE_DB="+f.db.Pool.Config().ConnString(), "DAYNIGHT_T07_FINALIZE_CERT="+base64.StdEncoding.EncodeToString(receiver.Certificate().Raw))
		out, e := cmd.CombinedOutput()
		if e != nil {
			t.Fatalf("%s child: %v %s", mode, e, out)
		}
		return string(out)
	}
	if out := run("lose"); !strings.Contains(out, "finalize COMMIT response discarded") {
		t.Fatalf("missing receipt-loss proof: %s", out)
	}
	var state, outcome string
	var attempts, count int
	if err := f.db.Pool.QueryRow(f.ctx, `SELECT state,automatic_attempt_count,(SELECT count(*) FROM webhook_attempts),(SELECT outcome FROM webhook_attempts LIMIT 1) FROM webhook_deliveries`).Scan(&state, &count, &attempts, &outcome); err != nil {
		t.Fatal(err)
	}
	if state != "delivered" || outcome != "acknowledged" || count != 1 || attempts != 1 || requests.Load() != 1 {
		t.Fatalf("before restart state=%s outcome=%s count=%d attempts=%d HTTP=%d", state, outcome, count, attempts, requests.Load())
	}
	run("restart")
	if err := f.db.Pool.QueryRow(f.ctx, `SELECT state,automatic_attempt_count,(SELECT count(*) FROM webhook_attempts),(SELECT outcome FROM webhook_attempts LIMIT 1) FROM webhook_deliveries`).Scan(&state, &count, &attempts, &outcome); err != nil {
		t.Fatal(err)
	}
	if state != "delivered" || outcome != "acknowledged" || count != 1 || attempts != 1 || requests.Load() != 1 {
		t.Fatalf("after restart state=%s outcome=%s count=%d attempts=%d HTTP=%d", state, outcome, count, attempts, requests.Load())
	}
	t.Logf("discarded real finalize COMMIT response; separate restart state=%s outcome=%s attempts=%d HTTP=%d", state, outcome, attempts, requests.Load())
}
