//go:build webhooktest

package server

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"os"
	"os/exec"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	corewebhook "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/webhook"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/httpoutbound"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const runnerProcessExitCode = 23

type runnerProcessCommitContext struct{}

type runnerProcessTracer struct {
	mode    string
	pending atomic.Bool
	armed   atomic.Bool
}

func (s *runnerProcessTracer) TraceQueryStart(ctx context.Context, _ *pgx.Conn, q pgx.TraceQueryStartData) context.Context {
	query := strings.ToLower(strings.TrimSpace(q.SQL))
	target := "update webhook_deliveries set"
	if s.mode == "admitted" {
		target = "insert into webhook_attempts"
	} else if s.mode == "response" || s.mode == "finalize_loss" {
		target = "update webhook_attempts set"
	}
	if strings.HasPrefix(query, target) {
		if s.mode == "response" {
			// This query is the first finalized effect after the real TLS response.
			fmt.Fprintln(os.Stdout, "runner exited after TLS response before finalized effect")
			os.Exit(runnerProcessExitCode)
		}
		s.pending.Store(true)
	}
	if query == "commit" && s.pending.Swap(false) {
		if s.mode == "finalize_loss" {
			s.armed.Store(true)
		} else {
			return context.WithValue(ctx, runnerProcessCommitContext{}, true)
		}
	}
	return ctx
}

func (s *runnerProcessTracer) TraceQueryEnd(ctx context.Context, _ *pgx.Conn, q pgx.TraceQueryEndData) {
	if ctx.Value(runnerProcessCommitContext{}) == true && q.Err == nil {
		fmt.Fprintf(os.Stdout, "runner exited after committed %s boundary\n", s.mode)
		os.Exit(runnerProcessExitCode)
	}
}

type runnerProcessCommitConn struct {
	net.Conn
	trace   *runnerProcessTracer
	pending []byte
}

func (c *runnerProcessCommitConn) Read(p []byte) (int, error) {
	if len(c.pending) != 0 {
		n := copy(p, c.pending)
		c.pending = c.pending[n:]
		return n, nil
	}
	if !c.trace.armed.Load() {
		return c.Conn.Read(p)
	}
	header := make([]byte, 5)
	if _, err := io.ReadFull(c.Conn, header); err != nil {
		return 0, err
	}
	size := binary.BigEndian.Uint32(header[1:])
	if size < 4 || size > 1<<20 {
		return 0, fmt.Errorf("invalid PostgreSQL reply length %d", size)
	}
	payload := make([]byte, int(size)-4)
	if _, err := io.ReadFull(c.Conn, payload); err != nil {
		return 0, err
	}
	if header[0] == 'C' && bytes.Equal(payload, []byte("COMMIT\x00")) {
		fmt.Fprintln(os.Stdout, "finalize COMMIT CommandComplete discarded before process exit")
		os.Exit(runnerProcessExitCode)
	}
	c.pending = append(header, payload...)
	n := copy(p, c.pending)
	c.pending = c.pending[n:]
	return n, nil
}

type runnerProcessResolver struct{}

func (runnerProcessResolver) LookupNetIP(context.Context, string, string) ([]netip.Addr, error) {
	return []netip.Addr{netip.MustParseAddr("127.0.0.1")}, nil
}

type runnerProcessClaimObservation struct {
	lease      string
	deliveries int
}

type runnerProcessRestartStore struct {
	*postgres.Store
	claims  chan runnerProcessClaimObservation
	entered chan runnerProcessClaimObservation
	release chan struct{}
}

type runnerProcessRestartScope struct {
	store.WebhookDeliveryScope
	owner *runnerProcessRestartStore
	claim *runnerProcessClaimObservation
}

func (s *runnerProcessRestartScope) Claim(ctx context.Context, limit int, now time.Time, workers []string) ([]store.WebhookDelivery, error) {
	deliveries, err := s.WebhookDeliveryScope.Claim(ctx, limit, now, workers)
	if err == nil {
		observation := &runnerProcessClaimObservation{deliveries: len(deliveries)}
		if len(workers) == 1 {
			observation.lease = workers[0]
		}
		s.claim = observation
		select {
		case s.owner.entered <- *observation:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
		select {
		case <-s.owner.release:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	return deliveries, err
}

func (s *runnerProcessRestartStore) WriteWebhookDelivery(ctx context.Context, work func(store.WebhookDeliveryScope) error) (store.Completion, error) {
	var observation *runnerProcessClaimObservation
	completion, err := s.Store.WriteWebhookDelivery(ctx, func(scope store.WebhookDeliveryScope) error {
		traced := &runnerProcessRestartScope{WebhookDeliveryScope: scope, owner: s}
		err := work(traced)
		observation = traced.claim
		return err
	})
	if observation != nil && err == nil && completion.Outcome == store.TransactionCommitted {
		select {
		case s.claims <- *observation:
		case <-ctx.Done():
		}
	}
	return completion, err
}

func runRunnerProcessChild(t *testing.T, mode string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	cfg, err := pgxpool.ParseConfig(os.Getenv("DAYNIGHT_RUNNER_PROCESS_DATABASE"))
	if err != nil {
		t.Fatal(err)
	}
	cfg.MaxConns = 1
	if mode == "restart_finalized" {
		cfg.MaxConns = 9
	}
	if mode != "recover" && mode != "restart_finalized" {
		trace := &runnerProcessTracer{mode: mode}
		cfg.ConnConfig.Tracer = trace
		if mode == "finalize_loss" {
			cfg.ConnConfig.DialFunc = func(ctx context.Context, network, address string) (net.Conn, error) {
				conn, err := (&net.Dialer{}).DialContext(ctx, network, address)
				if err != nil {
					return nil, err
				}
				return &runnerProcessCommitConn{Conn: conn, trace: trace}, nil
			}
		}
	}
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	if mode == "restart_finalized" {
		connections := make([]*pgxpool.Conn, 0, cfg.MaxConns)
		for range cfg.MaxConns {
			connection, err := pool.Acquire(ctx)
			if err != nil {
				for _, held := range connections {
					held.Release()
				}
				t.Fatal(err)
			}
			connections = append(connections, connection)
		}
		for _, connection := range connections {
			connection.Release()
		}
	}
	db := &postgres.Store{Pool: pool}
	der, err := base64.StdEncoding.DecodeString(os.Getenv("DAYNIGHT_RUNNER_PROCESS_CERTIFICATE"))
	if err != nil {
		t.Fatal(err)
	}
	certificate, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatal(err)
	}
	roots := x509.NewCertPool()
	roots.AddCert(certificate)
	dispatch := mode != "recover"
	var deliveryStore store.WebhookDeliveryTransactions = db
	var restart *runnerProcessRestartStore
	if mode == "restart_finalized" {
		restart = &runnerProcessRestartStore{Store: db, claims: make(chan runnerProcessClaimObservation, 32), entered: make(chan runnerProcessClaimObservation, 32), release: make(chan struct{})}
		deliveryStore = restart
	}
	runner := webhook.NewRunner(deliveryStore, &webhook.Service{DB: db}, dispatch)
	client := httpoutbound.NewForTesting(runnerProcessResolver{}, func(ip netip.Addr) bool { return ip.IsLoopback() }, roots)
	if err = runner.SetControlledTestTransport(client); err != nil {
		t.Fatal(err)
	}
	if err = runner.Start(ctx); err != nil {
		t.Fatal(err)
	}
	defer func() {
		stop, done := context.WithTimeout(context.Background(), 5*time.Second)
		defer done()
		if err := runner.Stop(stop); err != nil {
			t.Error(err)
		}
	}()
	if dispatch && restart == nil {
		select {
		case err := <-runner.Failures():
			t.Fatalf("runner failed before exit boundary: %v", err)
		case <-ctx.Done():
			t.Fatal("runner did not reach process exit boundary")
		}
		return
	}
	if restart != nil {
		initial := make(map[string]struct{}, 8)
		for len(initial) != 8 {
			select {
			case observation := <-restart.entered:
				if observation.lease == "" || observation.deliveries != 0 {
					t.Fatalf("finalized restart claimed work: %+v", observation)
				}
				initial[observation.lease] = struct{}{}
			case err := <-runner.Failures():
				t.Fatalf("enabled finalized restart: %v", err)
			case <-ctx.Done():
				t.Fatalf("enabled finalized restart entered only %d concurrent claims", len(initial))
			}
		}
		// Each worker cannot begin a second Claim until its first transaction
		// returns. Holding all eight callbacks establishes one real decision
		// opportunity per worker, then commits those exact lease-token probes.
		close(restart.release)
		committed := make(map[string]struct{}, 8)
		for len(committed) != 8 {
			select {
			case observation := <-restart.claims:
				if observation.deliveries != 0 {
					t.Fatalf("finalized restart committed new work: %+v", observation)
				}
				if _, ok := initial[observation.lease]; ok {
					committed[observation.lease] = struct{}{}
				}
			case err := <-runner.Failures():
				t.Fatalf("finalized restart claim completion: %v", err)
			case <-ctx.Done():
				t.Fatalf("enabled finalized restart committed only %d initial claims", len(committed))
			}
		}
		if err = runner.Stop(ctx); err != nil {
			t.Fatal(err)
		}
		fmt.Fprintln(os.Stdout, "separate enabled runner committed eight concurrent empty claims and drained")
		return
	}
	for {
		var state string
		var generation int64
		if err = pool.QueryRow(ctx, `SELECT state,generation FROM webhook_deliveries WHERE id=$1`, os.Getenv("DAYNIGHT_RUNNER_PROCESS_DELIVERY")).Scan(&state, &generation); err != nil {
			t.Fatal(err)
		}
		if state == "pending" && generation > 1 {
			// The subsequent drain observes real maintenance completion, not elapsed
			// wall time standing in for a reconstructed process's progress.
			if err = runner.Stop(ctx); err != nil {
				t.Fatal(err)
			}
			fmt.Fprintf(os.Stdout, "separate runner process reconciled state=%s generation=%d\n", state, generation)
			return
		}
		select {
		case err := <-runner.Failures():
			t.Fatalf("reconstructed runner: %v", err)
		case <-ctx.Done():
			t.Fatalf("reconstructed runner did not reconcile: state=%s generation=%d", state, generation)
		case <-time.After(10 * time.Millisecond):
		}
	}
}

type runnerProcessOutput struct {
	mu sync.Mutex
	bytes.Buffer
}

func (w *runnerProcessOutput) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if _, err := os.Stdout.Write(p); err != nil {
		return 0, err
	}
	return w.Buffer.Write(p)
}

func runnerProcessFixture(t *testing.T, target string) (context.Context, *postgres.Store, string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	t.Cleanup(cancel)
	db, err := postgres.Open(ctx, testutil.ScopedDatabaseURL(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(db.Close)
	user, session, team, project := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	hash := sha256.Sum256([]byte(session))
	for _, query := range []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO users(id,uniauth_id,created_at,updated_at) VALUES($1,$1::uuid::text,now(),now())`, []any{user}},
		{`INSERT INTO sessions(id,user_id,token_hash,created_at,expires_at) VALUES($1,$2,$3,now(),now()+interval '1 day')`, []any{session, user, hash[:]}},
		{`INSERT INTO teams(id,name) VALUES($1,'runner process')`, []any{team}},
		{`INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'admin')`, []any{team, user}},
		{`INSERT INTO projects(id,name,repo_url) VALUES($1,'runner process','https://example.test/runner-process')`, []any{project}},
		{`INSERT INTO project_ownership(project_id,team_id) VALUES($1,$2)`, []any{project, team}},
	} {
		if _, err = db.Pool.Exec(ctx, query.sql, query.args...); err != nil {
			t.Fatal(err)
		}
	}
	principal := model.Principal{Kind: model.SessionCredential, UserID: user, CredentialID: session}
	name, enabled := "process receiver", true
	svc := &webhook.Service{DB: db, ConfigurationExpansionAvailable: true}
	_, err = svc.Mutate(ctx, principal, webhook.Owner{Kind: "personal", ID: user}, webhook.Mutation{
		Kind: "endpoint.create", OperationID: uuid.NewString(), IssuedAt: time.Now().UTC().Format(time.RFC3339Nano), ExpectedUserID: user,
		RequestSHA256: strings.Repeat("a", 64), Name: &name, Enabled: &enabled, Destination: &webhook.Destination{Kind: "http", AdapterVersion: "1", URL: target}, HasSubscriptions: true,
		Subscriptions: []corewebhook.SubscriptionInput{{ProjectID: project, EventTypes: []string{"task.created"}}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = taskservice.NewTasks(db, &webhook.Capturer{}).Create(ctx, principal, project, taskcore.CreateTask{Title: "runner process source"}); err != nil {
		t.Fatal(err)
	}
	var delivery string
	if err = db.Pool.QueryRow(ctx, `SELECT id::text FROM webhook_deliveries`).Scan(&delivery); err != nil {
		t.Fatal(err)
	}
	return ctx, db, delivery
}

// Abrupt process exit and discarded finalize acknowledgement exercise the real
// Runner, TLS and durable transaction boundaries; rule matrices live in mocks.
func TestWebhookRunnerAbruptProcessRecovery(t *testing.T) {
	if mode := os.Getenv("DAYNIGHT_RUNNER_PROCESS_MODE"); mode != "" {
		runRunnerProcessChild(t, mode)
		return
	}
	for _, mode := range []string{"claimed", "admitted", "response", "finalize_loss"} {
		t.Run(mode, func(t *testing.T) {
			var requests atomic.Int64
			receiver := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if _, err := io.Copy(io.Discard, r.Body); err != nil {
					t.Error(err)
				}
				requests.Add(1)
				w.WriteHeader(http.StatusAccepted)
			}))
			t.Cleanup(receiver.Close)
			ctx, db, delivery := runnerProcessFixture(t, receiver.URL)
			var originalBody, originalHash, originalFacts []byte
			var originalMatches int
			if err := db.Pool.QueryRow(ctx, `SELECT d.body,d.body_sha256,e.fact_bytes,(SELECT count(*) FROM webhook_delivery_matches WHERE delivery_id=d.id) FROM webhook_deliveries d JOIN webhook_events e ON e.id=d.event_id WHERE d.id=$1`, delivery).Scan(&originalBody, &originalHash, &originalFacts, &originalMatches); err != nil {
				t.Fatal(err)
			}
			digest := sha256.Sum256(originalBody)
			if !bytes.Equal(digest[:], originalHash) || !bytes.Equal(originalBody, originalFacts) || originalMatches != 1 {
				t.Fatal("source did not persist a complete capture proof")
			}
			type immutableDelivery struct {
				policy, revision               int64
				schedule                       []time.Time
				automaticExpiry, payloadExpiry time.Time
				destination                    []byte
			}
			readImmutable := func() immutableDelivery {
				t.Helper()
				var value immutableDelivery
				if err := db.Pool.QueryRow(ctx, `SELECT policy_version,destination_revision,automatic_schedule_at,automatic_expires_at,payload_expires_at,destination_configuration FROM webhook_deliveries WHERE id=$1`, delivery).Scan(&value.policy, &value.revision, &value.schedule, &value.automaticExpiry, &value.payloadExpiry, &value.destination); err != nil {
					t.Fatal(err)
				}
				return value
			}
			originalImmutable := readImmutable()
			run := func(childMode string, exit int) string {
				t.Helper()
				command := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestWebhookRunnerAbruptProcessRecovery$", "-test.count=1")
				command.Env = append(os.Environ(), "DAYNIGHT_RUNNER_PROCESS_MODE="+childMode, "DAYNIGHT_RUNNER_PROCESS_DATABASE="+db.Pool.Config().ConnString(), "DAYNIGHT_RUNNER_PROCESS_DELIVERY="+delivery, "DAYNIGHT_RUNNER_PROCESS_CERTIFICATE="+base64.StdEncoding.EncodeToString(receiver.Certificate().Raw))
				var output runnerProcessOutput
				command.Stdout, command.Stderr = &output, &output
				err := command.Run()
				if exit == 0 && err != nil {
					t.Fatalf("%s child failed: %v\n%s", childMode, err, output.String())
				}
				if exit != 0 {
					var stopped *exec.ExitError
					if !errors.As(err, &stopped) || stopped.ExitCode() != exit {
						t.Fatalf("%s child exit: %v\n%s", childMode, err, output.String())
					}
				}
				return output.String()
			}
			output := run(mode, runnerProcessExitCode)
			if mode == "finalize_loss" && !strings.Contains(output, "COMMIT CommandComplete discarded") {
				t.Fatalf("missing framed finalize acknowledgement loss: %s", output)
			}
			read := func() (string, int64, int, int, *string, *time.Time) {
				t.Helper()
				var state string
				var generation int64
				var automatic, attempts int
				var outcome *string
				var recovered *time.Time
				if err := db.Pool.QueryRow(ctx, `SELECT state,generation,automatic_attempt_count,(SELECT count(*) FROM webhook_attempts WHERE delivery_id=$1),(SELECT outcome FROM webhook_attempts WHERE delivery_id=$1 LIMIT 1),(SELECT recovered_unknown_at FROM webhook_attempts WHERE delivery_id=$1 LIMIT 1) FROM webhook_deliveries WHERE id=$1`, delivery).Scan(&state, &generation, &automatic, &attempts, &outcome, &recovered); err != nil {
					t.Fatal(err)
				}
				return state, generation, automatic, attempts, outcome, recovered
			}
			state, generation, automatic, attempts, outcome, _ := read()
			wantAttempts, wantRequests := 1, int64(0)
			if mode == "claimed" {
				wantAttempts = 0
			}
			if mode == "response" || mode == "finalize_loss" {
				wantRequests = 1
			}
			if automatic != wantAttempts || attempts != wantAttempts || generation != 1 || requests.Load() != wantRequests {
				t.Fatalf("exit state: state=%s generation=%d automatic=%d attempts=%d requests=%d", state, generation, automatic, attempts, requests.Load())
			}
			if mode == "finalize_loss" {
				if state != "delivered" || outcome == nil || *outcome != "acknowledged" {
					t.Fatalf("finalized before exit: state=%s outcome=%v", state, outcome)
				}
				run("restart_finalized", 0)
			} else {
				if state != "leased" || outcome != nil {
					t.Fatalf("unfinalized exit: state=%s outcome=%v", state, outcome)
				}
				// Age only the mutable lease; immutable schedule and expiry facts stay fixed.
				if _, err := db.Pool.Exec(ctx, `UPDATE webhook_deliveries SET lease_claimed_at=now()-interval '46 seconds',lease_until=now()-interval '1 second' WHERE id=$1`, delivery); err != nil {
					t.Fatal(err)
				}
				run("recover", 0)
			}
			state, generation, automatic, attempts, outcome, recovered := read()
			if automatic != wantAttempts || attempts != wantAttempts || requests.Load() != wantRequests {
				t.Fatalf("restart invented work: state=%s automatic=%d attempts=%d requests=%d", state, automatic, attempts, requests.Load())
			}
			if mode == "finalize_loss" {
				if state != "delivered" || generation != 1 || outcome == nil || *outcome != "acknowledged" {
					t.Fatalf("finalized restart changed result: state=%s generation=%d outcome=%v", state, generation, outcome)
				}
			} else if state != "pending" || generation != 2 || wantAttempts == 1 && (outcome == nil || *outcome != "unknown" || recovered == nil) {
				t.Fatalf("unfinalized recovery: state=%s generation=%d outcome=%v recovered=%v", state, generation, outcome, recovered)
			}
			var body, hash, facts []byte
			var matches int
			if err := db.Pool.QueryRow(ctx, `SELECT d.body,d.body_sha256,e.fact_bytes,(SELECT count(*) FROM webhook_delivery_matches WHERE delivery_id=d.id) FROM webhook_deliveries d JOIN webhook_events e ON e.id=d.event_id WHERE d.id=$1`, delivery).Scan(&body, &hash, &facts, &matches); err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(body, originalBody) || !bytes.Equal(hash, originalHash) || !bytes.Equal(facts, originalFacts) || matches != originalMatches || matches != 1 {
				t.Fatal("process restart changed original capture proof")
			}
			immutable := readImmutable()
			if immutable.policy != originalImmutable.policy || immutable.revision != originalImmutable.revision || !slices.EqualFunc(immutable.schedule, originalImmutable.schedule, time.Time.Equal) || !immutable.automaticExpiry.Equal(originalImmutable.automaticExpiry) || !immutable.payloadExpiry.Equal(originalImmutable.payloadExpiry) || !bytes.Equal(immutable.destination, originalImmutable.destination) {
				t.Fatal("process restart changed immutable delivery policy, target or deadlines")
			}
		})
	}
}
