package webhook_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"os"
	"os/exec"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/webhook"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/httpoutbound"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secretbox"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type exitCommitMarker struct {
	target  string
	pending atomic.Bool
}
type exitCommitContext struct{}

func (m *exitCommitMarker) TraceQueryStart(ctx context.Context, _ *pgx.Conn, q pgx.TraceQueryStartData) context.Context {
	sql := strings.ToLower(strings.TrimSpace(q.SQL))
	if strings.HasPrefix(sql, m.target) {
		m.pending.Store(true)
	}
	if sql == "commit" && m.pending.Swap(false) {
		return context.WithValue(ctx, exitCommitContext{}, true)
	}
	return ctx
}
func (*exitCommitMarker) TraceQueryEnd(ctx context.Context, _ *pgx.Conn, q pgx.TraceQueryEndData) {
	if ctx.Value(exitCommitContext{}) == true && q.Err == nil {
		os.Exit(0)
	}
}

// A subprocess exits at committed boundaries or immediately after a real TLS
// response. A distinct process then observes and recovers the persisted facts.
func TestDeliveryProcessExitRecovery(t *testing.T) {
	if mode := os.Getenv("DAYNIGHT_T04_EXIT_MODE"); mode != "" {
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		cfg, err := pgxpool.ParseConfig(os.Getenv("DAYNIGHT_T04_EXIT_DB"))
		if err != nil {
			t.Fatal(err)
		}
		cfg.MaxConns = 1
		if mode == "claimed" {
			cfg.ConnConfig.Tracer = &exitCommitMarker{target: "update webhook_deliveries set"}
		}
		if mode == "admitted" {
			cfg.ConnConfig.Tracer = &exitCommitMarker{target: "insert into webhook_attempts"}
		}
		pool, err := pgxpool.NewWithConfig(ctx, cfg)
		if err != nil {
			t.Fatal(err)
		}
		raw := base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{1}, 32))
		keys, err := secretbox.Parse([]byte(`{"activeKeyId":"primary","keys":{"primary":"` + raw + `"}}`))
		if err != nil {
			t.Fatal(err)
		}
		db := &postgres.Store{Pool: pool}
		if mode == "captured" {
			principal := model.Principal{Kind: model.SessionCredential, UserID: os.Getenv("DAYNIGHT_T04_EXIT_USER"), CredentialID: os.Getenv("DAYNIGHT_T04_EXIT_SESSION")}
			if _, err := taskservice.NewTasks(db, &webhook.Capturer{Keys: keys}).Create(ctx, principal, os.Getenv("DAYNIGHT_T04_EXIT_PROJECT"), taskcore.CreateTask{Title: "child capture"}); err != nil {
				t.Fatal(err)
			}
			os.Exit(0)
		}
		svc := &webhook.Service{DB: db, Keys: keys}
		runner := webhook.NewRunner(db, svc, true)
		der, err := base64.StdEncoding.DecodeString(os.Getenv("DAYNIGHT_T04_EXIT_CERT"))
		if err != nil {
			t.Fatal(err)
		}
		cert, err := x509.ParseCertificate(der)
		if err != nil {
			t.Fatal(err)
		}
		roots := x509.NewCertPool()
		roots.AddCert(cert)
		client := httpoutbound.NewForTesting(testResolver{}, func(ip netip.Addr) bool { return ip.IsLoopback() }, roots)
		if mode == "response" {
			runner.SetExitAfterHTTP(client)
		} else {
			runner.SetTestTransport(client)
		}
		if err := runner.Start(ctx); err != nil {
			t.Fatal(err)
		}
		select {
		case err := <-runner.Failures():
			t.Fatalf("runner: %v", err)
		case <-ctx.Done():
			t.Fatal("exit boundary was not reached")
		}
	}
	for _, mode := range []string{"captured", "claimed", "admitted", "response"} {
		t.Run(mode, func(t *testing.T) {
			requests := make(chan struct{}, 2)
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
			if mode != "captured" {
				if _, err := taskservice.NewTasks(f.db, f.capture).Create(f.ctx, f.principal, f.project, taskcore.CreateTask{Title: "process exit"}); err != nil {
					t.Fatal(err)
				}
			}
			cmd := exec.CommandContext(f.ctx, os.Args[0], "-test.run=^TestDeliveryProcessExitRecovery$", "-test.count=1")
			cmd.Env = append(os.Environ(), "DAYNIGHT_T04_EXIT_MODE="+mode, "DAYNIGHT_T04_EXIT_DB="+f.db.Pool.Config().ConnString(), "DAYNIGHT_T04_EXIT_CERT="+base64.StdEncoding.EncodeToString(receiver.Certificate().Raw), "DAYNIGHT_T04_EXIT_USER="+f.principal.UserID, "DAYNIGHT_T04_EXIT_SESSION="+f.principal.CredentialID, "DAYNIGHT_T04_EXIT_PROJECT="+f.project)
			out, err := cmd.CombinedOutput()
			if err != nil {
				t.Fatalf("child: %v %s", err, out)
			}
			var id string
			var body, hash []byte
			var matches int
			if err := f.db.Pool.QueryRow(f.ctx, `SELECT id::text,body,body_sha256,(SELECT count(*) FROM webhook_delivery_matches WHERE delivery_id=d.id) FROM webhook_deliveries d`).Scan(&id, &body, &hash, &matches); err != nil {
				t.Fatal(err)
			}
			sum := sha256.Sum256(body)
			if !bytes.Equal(sum[:], hash) || matches != 1 {
				t.Fatal("capture proof missing")
			}
			var state string
			var attempts, count int
			var gen int64
			read := func() {
				t.Helper()
				if err := f.db.Pool.QueryRow(f.ctx, `SELECT state,generation,automatic_attempt_count,(SELECT count(*) FROM webhook_attempts) FROM webhook_deliveries WHERE id=$1`, id).Scan(&state, &gen, &count, &attempts); err != nil {
					t.Fatal(err)
				}
			}
			read()
			wantAttempts := 0
			if mode == "admitted" || mode == "response" {
				wantAttempts = 1
			}
			if attempts != wantAttempts || count != wantAttempts {
				t.Fatalf("mode %s state %s attempts %d count %d", mode, state, attempts, count)
			}
			if mode == "captured" {
				if state != "pending" {
					t.Fatal(state)
				}
				return
			}
			if state != "leased" {
				t.Fatalf("expected persisted lease: %s", state)
			}
			if mode == "response" {
				select {
				case <-requests:
				default:
					t.Fatal("receiver did not see response-stage request")
				}
			} else {
				select {
				case <-requests:
					t.Fatal("request before admission boundary")
				default:
				}
			}
			// Advance only the lease age to exercise the real expiry transaction without
			// delaying the routine suite 45 seconds. Original schedule and deadline stay intact.
			if _, err = f.db.Pool.Exec(f.ctx, `UPDATE webhook_deliveries SET lease_claimed_at=now()-interval '46 seconds',lease_until=now()-interval '1 second' WHERE id=$1`, id); err != nil {
				t.Fatal(err)
			}
			recovery := webhook.NewRunner(f.db, svc, false)
			if err = recovery.Start(context.Background()); err != nil {
				t.Fatal(err)
			}
			defer func() {
				ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
				defer cancel()
				if e := recovery.Stop(ctx); e != nil {
					t.Error(e)
				}
			}()
			deadline := time.After(5 * time.Second)
			for {
				read()
				if state == "pending" && gen > 1 {
					break
				}
				select {
				case e := <-recovery.Failures():
					t.Fatalf("recovery: %v", e)
				case <-deadline:
					t.Fatalf("recovery state=%s gen=%d", state, gen)
				case <-time.After(20 * time.Millisecond):
				}
			}
			if wantAttempts == 1 {
				var outcome string
				var recovered *time.Time
				if err = f.db.Pool.QueryRow(f.ctx, `SELECT outcome,recovered_unknown_at FROM webhook_attempts WHERE delivery_id=$1`, id).Scan(&outcome, &recovered); err != nil {
					t.Fatal(err)
				}
				if outcome != "unknown" || recovered == nil {
					t.Fatalf("recovery outcome %s", outcome)
				}
			}
			if attempts != wantAttempts || count != wantAttempts {
				t.Fatalf("recovery changed admitted count: %d %d", attempts, count)
			}
		})
	}
}
