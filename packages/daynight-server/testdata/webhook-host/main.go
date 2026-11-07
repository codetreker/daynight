// webhook-host is an isolated, temporary integration fixture for client tests.
package main

import (
	"context"
	"crypto/rand"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"net/url"
	"os"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/config"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	authhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"
	projecthttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/project"
	taskhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/task"
	teamhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/team"
	webhookhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/webhook"
	identityservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/identity"
	projectservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/project"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
	teamservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/team"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/webhook"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/httpoutbound"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secretbox"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type loopbackResolver struct{}

func (loopbackResolver) LookupNetIP(_ context.Context, _, host string) ([]netip.Addr, error) {
	ip, err := netip.ParseAddr(host)
	if err != nil || !ip.IsLoopback() {
		return nil, errors.New("fixture receiver must be loopback")
	}
	return []netip.Addr{ip}, nil
}

type info struct {
	URL         string `json:"url"`
	Origin      string `json:"origin"`
	UserID      string `json:"userId"`
	MemberID    string `json:"memberId"`
	ProjectID   string `json:"projectId"`
	TeamID      string `json:"teamId"`
	ReceiverURL string `json:"receiverUrl"`
	Schema      string `json:"schema"`
}
type receipt struct {
	Body      []byte `json:"body"`
	EventID   string `json:"eventId"`
	Timestamp string `json:"timestamp"`
	Signature string `json:"signature"`
	Status    int    `json:"status"`
}
type fixture struct {
	db                *postgres.Store
	admin             *pgxpool.Pool
	server            *http.Server
	listener          net.Listener
	receiver          *httptest.Server
	schema            string
	schemaCreated     bool
	schemaOwner       string
	runner            *webhook.Runner
	beforeRunnerStart func()
	handlerLock       sync.Mutex
	handlers          sync.WaitGroup
	receiverLock      sync.Mutex
	receiverHandlers  sync.WaitGroup
	receiverAccepting bool
	accepting         bool
	mu                sync.Mutex
	receipts          []receipt
	status            int
	done              chan struct{}
	stopOnce          sync.Once
	info              info
}

func start(ctx context.Context, databaseURL, token, pat, memberToken, memberPAT string) (*fixture, error) {
	return startWithStore(ctx, databaseURL, token, pat, memberToken, memberPAT, postgres.Open)
}

func startWithStore(ctx context.Context, databaseURL, token, pat, memberToken, memberPAT string, open func(context.Context, string) (*postgres.Store, error)) (*fixture, error) {
	return startWithAdmin(ctx, databaseURL, token, pat, memberToken, memberPAT, open, pgxpool.New)
}

func startWithAdmin(ctx context.Context, databaseURL, token, pat, memberToken, memberPAT string, open func(context.Context, string) (*postgres.Store, error), newAdmin func(context.Context, string) (*pgxpool.Pool, error)) (f *fixture, err error) {
	if databaseURL == "" {
		return nil, errors.New("test database URL is required")
	}
	if !secret.Valid(memberPAT, "dnpat_") || !secret.Valid(memberToken, "dnst_") || memberPAT == pat || memberToken == token {
		return nil, errors.New("fixture member credentials must be valid and distinct")
	}
	if !secret.Valid(pat, "dnpat_") {
		return nil, errors.New("fixture PAT must be valid")
	}
	if !secret.Valid(token, "dnst_") {
		return nil, errors.New("fixture token must be a valid session token")
	}
	admin, err := newAdmin(ctx, databaseURL)
	if err != nil {
		return nil, err
	}
	f = &fixture{admin: admin, status: http.StatusAccepted, done: make(chan struct{}), schema: "webhook_fixture_" + strings.ReplaceAll(uuid.NewString(), "-", ""), schemaOwner: uuid.NewString()}
	owned := f
	defer func() {
		if err != nil {
			cleanup, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			if e := owned.close(cleanup); e != nil {
				err = errors.Join(err, &schemaIssue{schema: owned.schema})
			}
		}
	}()
	if err = f.createSchema(ctx); err != nil {
		return nil, err
	}
	u, err := url.Parse(databaseURL)
	if err != nil {
		return nil, err
	}
	q := u.Query()
	q.Set("search_path", f.schema)
	q.Set("timezone", "UTC")
	q.Set("application_name", f.schema)
	u.RawQuery = q.Encode()
	f.db, err = open(ctx, u.String())
	if err != nil {
		return nil, err
	}
	user, session, team, project := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	member, memberSession := uuid.NewString(), uuid.NewString()
	personalTeam, memberPersonalTeam := uuid.NewString(), uuid.NewString()
	for _, s := range []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO users(id,uniauth_id,created_at,updated_at) VALUES($1,$1::uuid::text,now(),now())`, []any{user}},
		{`INSERT INTO users(id,uniauth_id,created_at,updated_at) VALUES($1,$1::uuid::text,now(),now())`, []any{member}},
		{`INSERT INTO sessions(id,user_id,token_hash,created_at,expires_at) VALUES($1,$2,$3,now(),now()+interval '1 day')`, []any{memberSession, member, secret.Hash(memberToken)}},
		{`INSERT INTO personal_access_tokens(id,user_id,token_hash,name,created_at,expires_at) VALUES($1,$2,$3,'fixture member',now(),now()+interval '1 day')`, []any{uuid.NewString(), member, secret.Hash(memberPAT)}},
		{`INSERT INTO sessions(id,user_id,token_hash,created_at,expires_at) VALUES($1,$2,$3,now(),now()+interval '1 day')`, []any{session, user, secret.Hash(token)}},
		{`INSERT INTO personal_access_tokens(id,user_id,token_hash,name,created_at,expires_at) VALUES($1,$2,$3,'fixture',now(),now()+interval '1 day')`, []any{uuid.NewString(), user, secret.Hash(pat)}},
		{`INSERT INTO teams(id,personal_user_id) VALUES($1,$2),($3,$4)`, []any{personalTeam, user, memberPersonalTeam, member}},
		{`INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'admin'),($3,$4,'admin')`, []any{personalTeam, user, memberPersonalTeam, member}},
		{`INSERT INTO teams(id,name) VALUES($1,'fixture')`, []any{team}},
		{`INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'admin')`, []any{team, user}},
		{`INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'member')`, []any{team, member}},
		{`INSERT INTO projects(id,name,repo_url) VALUES($1,'fixture',$2)`, []any{project, "https://example.test/" + project}},
		{`INSERT INTO project_ownership(project_id,team_id) VALUES($1,$2)`, []any{project, team}},
	} {
		if _, err = f.db.Pool.Exec(ctx, s.sql, s.args...); err != nil {
			return nil, err
		}
	}
	key := make([]byte, 32)
	if _, err = rand.Read(key); err != nil {
		return nil, err
	}
	keys, err := secretbox.Parse([]byte(`{"activeKeyId":"fixture","keys":{"fixture":"` + base64.StdEncoding.EncodeToString(key) + `"}}`))
	if err != nil {
		return nil, err
	}
	receiverPath := "/" + uuid.NewString()
	f.receiverAccepting = true
	f.receiver = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.receiverLock.Lock()
		if !f.receiverAccepting {
			f.receiverLock.Unlock()
			http.Error(w, "fixture shutting down", http.StatusServiceUnavailable)
			return
		}
		f.receiverHandlers.Add(1)
		f.receiverLock.Unlock()
		defer f.receiverHandlers.Done()
		if r.Method != http.MethodPost || r.URL.Path != receiverPath {
			http.NotFound(w, r)
			return
		}
		body, e := io.ReadAll(io.LimitReader(r.Body, 65537))
		if e != nil || len(body) > 65536 {
			w.WriteHeader(400)
			return
		}
		f.mu.Lock()
		f.receipts = append(f.receipts, receipt{Body: body, EventID: r.Header.Get("Webhook-Id"), Timestamp: r.Header.Get("Webhook-Timestamp"), Signature: r.Header.Get("Webhook-Signature"), Status: f.status})
		status := f.status
		f.mu.Unlock()
		w.WriteHeader(status)
	}))
	f.listener, err = net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	origin := "http://" + f.listener.Addr().String()
	logger := slog.New(slog.NewJSONHandler(io.Discard, nil))
	auth, err := authhttp.NewAuthentication(identityservice.New(f.db, nil, origin+"/auth/callback"), config.AuthSettings{PublicOrigin: origin, AllowHTTPTestOrigin: true}, logger)
	if err != nil {
		return nil, err
	}
	svc := &webhook.Service{DB: f.db, Keys: keys, ConfigurationExpansionAvailable: true, DispatchEnabled: true}
	capture := &webhook.Capturer{Keys: keys, Logger: logger}
	f.runner = webhook.NewRunner(f.db, svc, true)
	roots := x509.NewCertPool()
	roots.AddCert(f.receiver.Certificate())
	f.runner.SetFixtureTransport(httpoutbound.NewForTesting(loopbackResolver{}, func(ip netip.Addr) bool { return ip.IsLoopback() }, roots))
	mux := http.NewServeMux()
	auth.RegisterRoutes(mux)
	teamhttp.RegisterRoutes(mux, teamservice.NewTeams(f.db), auth, logger)
	webhookhttp.NewRoutes(svc, auth, logger).RegisterRoutes(mux)
	projecthttp.RegisterRoutes(mux, projectservice.NewProjects(f.db), auth, logger)
	projecthttp.NewMembershipRoutes(projectservice.NewMemberships(f.db), auth, logger).RegisterRoutes(mux)
	taskhttp.TaskRoutes(mux, taskservice.NewTasks(f.db, capture), auth, logger)
	taskhttp.TaskStepsRoutes(mux, taskservice.NewTaskSteps(f.db, capture), auth, logger)
	taskhttp.TaskThreadRoutes(mux, taskservice.NewTaskThreads(f.db, capture), auth, logger)
	mux.HandleFunc("POST /__fixture/runner/start", auth.Require(func(w http.ResponseWriter, r *http.Request, p model.Principal) {
		if p.UserID != user {
			http.Error(w, "forbidden", 403)
			return
		}
		if f.beforeRunnerStart != nil {
			f.beforeRunnerStart()
		}
		if e := f.runner.Start(context.Background()); e != nil {
			http.Error(w, "runner unavailable", 409)
			return
		}
		w.WriteHeader(204)
	}))
	mux.HandleFunc("POST /__fixture/runner/stop", auth.Require(func(w http.ResponseWriter, r *http.Request, p model.Principal) {
		if p.UserID != user {
			http.Error(w, "forbidden", 403)
			return
		}
		c, cancel := context.WithTimeout(r.Context(), 5*time.Second)
		defer cancel()
		if e := f.runner.Stop(c); e != nil {
			http.Error(w, "runner unavailable", 503)
			return
		}
		w.WriteHeader(204)
	}))
	mux.HandleFunc("POST /__fixture/shutdown", auth.Require(func(w http.ResponseWriter, r *http.Request, p model.Principal) {
		if p.UserID != user {
			http.Error(w, "forbidden", 403)
			return
		}
		w.WriteHeader(http.StatusNoContent)
		f.stopOnce.Do(func() { close(f.done) })
	}))
	mux.HandleFunc("PUT /__fixture/receiver/status", auth.Require(func(w http.ResponseWriter, r *http.Request, p model.Principal) {
		if p.UserID != user {
			http.Error(w, "forbidden", 403)
			return
		}
		var input struct {
			Status int `json:"status"`
		}
		decoder := json.NewDecoder(io.LimitReader(r.Body, 1025))
		decoder.DisallowUnknownFields()
		if decoder.Decode(&input) != nil || input.Status < 200 || input.Status > 599 {
			http.Error(w, "invalid status", 400)
			return
		}
		var extra any
		if decoder.Decode(&extra) != io.EOF {
			http.Error(w, "invalid status", 400)
			return
		}
		f.mu.Lock()
		f.status = input.Status
		f.mu.Unlock()
		w.WriteHeader(http.StatusNoContent)
	}))
	mux.HandleFunc("GET /__fixture/receiver", auth.Require(func(w http.ResponseWriter, r *http.Request, p model.Principal) {
		if p.UserID != user {
			http.Error(w, "forbidden", 403)
			return
		}
		f.mu.Lock()
		copy := append([]receipt{}, f.receipts...)
		f.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(copy)
	}))
	f.accepting = true
	f.server = &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.handlerLock.Lock()
		if !f.accepting {
			f.handlerLock.Unlock()
			http.Error(w, "fixture shutting down", http.StatusServiceUnavailable)
			return
		}
		f.handlers.Add(1)
		f.handlerLock.Unlock()
		defer f.handlers.Done()
		mux.ServeHTTP(w, r)
	}), ReadHeaderTimeout: 5 * time.Second}
	f.info = info{URL: origin, Origin: origin, UserID: user, MemberID: member, ProjectID: project, TeamID: team, ReceiverURL: f.receiver.URL + receiverPath, Schema: f.schema}
	go func() { _ = f.server.Serve(f.listener) }()
	return f, nil
}

// schemaIssue reports uncertainty without exposing credentials or driver errors.
type schemaIssue struct{ schema string }

func (e *schemaIssue) Error() string {
	return "fixture schema " + e.schema + " retained or cleanup could not be confirmed"
}

func (f *fixture) createSchema(ctx context.Context) error {
	tx, err := f.admin.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(context.Background())
	schema := pgx.Identifier{f.schema}.Sanitize()
	marker := pgx.Identifier{f.schema, "__webhook_fixture_owner"}.Sanitize()
	if _, err = tx.Exec(ctx, "CREATE SCHEMA "+schema); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, "CREATE TABLE "+marker+" (owner_id uuid PRIMARY KEY)"); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, "INSERT INTO "+marker+" (owner_id) VALUES ($1)", f.schemaOwner); err != nil {
		return err
	}
	if err = tx.Commit(ctx); err == nil {
		f.schemaCreated = true
		return nil
	}
	// The transaction may have committed even if the reply was lost. Observe
	// the unique owner marker on a fresh connection before any cleanup decision.
	check, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	owned, checkErr := f.ownsSchema(check)
	if checkErr != nil || !owned {
		// Absence in one observation does not prove that an in-flight COMMIT
		// cannot still become visible. Preserve the name for reconciliation.
		return errors.Join(err, &schemaIssue{schema: f.schema})
	}
	f.schemaCreated = true
	return err
}

func (f *fixture) ownsSchema(ctx context.Context) (bool, error) {
	var exists bool
	if err := f.admin.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname=$1)`, f.schema).Scan(&exists); err != nil {
		return false, err
	}
	if !exists {
		return false, nil
	}
	marker := pgx.Identifier{f.schema, "__webhook_fixture_owner"}.Sanitize()
	var owner string
	var count int64
	if err := f.admin.QueryRow(ctx, "SELECT count(*),coalesce(min(owner_id::text),'') FROM "+marker).Scan(&count, &owner); err != nil {
		return false, err
	}
	if count != 1 || owner != f.schemaOwner {
		return false, &schemaIssue{schema: f.schema}
	}
	return true, nil
}

func (f *fixture) dropSchema(ctx context.Context) error {
	tx, err := f.admin.Begin(ctx)
	if err != nil {
		return &schemaIssue{schema: f.schema}
	}
	defer tx.Rollback(context.Background())
	var exists bool
	if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname=$1)`, f.schema).Scan(&exists); err != nil {
		return &schemaIssue{schema: f.schema}
	}
	if !exists {
		return nil
	}
	marker := pgx.Identifier{f.schema, "__webhook_fixture_owner"}.Sanitize()
	if _, err = tx.Exec(ctx, "LOCK TABLE "+marker+" IN ACCESS EXCLUSIVE MODE"); err != nil {
		return &schemaIssue{schema: f.schema}
	}
	var owner string
	var count int64
	if err = tx.QueryRow(ctx, "SELECT count(*),coalesce(min(owner_id::text),'') FROM "+marker).Scan(&count, &owner); err != nil || count != 1 || owner != f.schemaOwner {
		return &schemaIssue{schema: f.schema}
	}
	if _, err = tx.Exec(ctx, "DROP SCHEMA "+pgx.Identifier{f.schema}.Sanitize()+" CASCADE"); err != nil {
		return &schemaIssue{schema: f.schema}
	}
	if err = tx.Commit(ctx); err != nil {
		check, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		owned, observeErr := f.ownsSchema(check)
		if observeErr == nil && !owned {
			return nil
		}
		return &schemaIssue{schema: f.schema}
	}
	return nil
}

func (f *fixture) close(ctx context.Context) error {
	f.handlerLock.Lock()
	f.accepting = false
	f.handlerLock.Unlock()
	if f.server != nil {
		if err := f.server.Shutdown(ctx); err != nil {
			if closeErr := f.server.Close(); closeErr != nil {
				return errors.Join(err, closeErr)
			}
		}
	} else if f.listener != nil {
		if err := f.listener.Close(); err != nil {
			return err
		}
	}
	// After admission is closed, no new handler can join this wait. A forced
	// connection close interrupts blocked request bodies before resources close.
	cleanup, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	done := make(chan struct{})
	go func() { f.handlers.Wait(); close(done) }()
	select {
	case <-done:
	case <-cleanup.Done():
		return cleanup.Err()
	}
	if f.runner != nil {
		if err := f.runner.Stop(cleanup); err != nil {
			return err
		}
	}
	if f.receiver != nil {
		f.receiverLock.Lock()
		f.receiverAccepting = false
		f.receiverLock.Unlock()
		grace, stopGrace := context.WithTimeout(context.Background(), 2*time.Second)
		shutdownErr := f.receiver.Config.Shutdown(grace)
		stopGrace()
		if shutdownErr != nil {
			f.receiver.CloseClientConnections()
			if err := f.receiver.Config.Close(); err != nil {
				return errors.Join(shutdownErr, err)
			}
		}
		receiverCleanup, stopReceiver := context.WithTimeout(context.Background(), 10*time.Second)
		defer stopReceiver()
		receiverDone := make(chan struct{})
		go func() { f.receiverHandlers.Wait(); close(receiverDone) }()
		select {
		case <-receiverDone:
		case <-receiverCleanup.Done():
			return receiverCleanup.Err()
		}
		serverDone := make(chan struct{})
		go func() { f.receiver.Close(); close(serverDone) }()
		select {
		case <-serverDone:
		case <-receiverCleanup.Done():
			return receiverCleanup.Err()
		}
	}
	if f.db != nil {
		f.db.Close()
	}
	var err error
	databaseCleanup, stopDatabase := context.WithTimeout(context.Background(), 10*time.Second)
	defer stopDatabase()
	if f.admin != nil {
		if f.schemaCreated {
			err = f.dropSchema(databaseCleanup)
		}
		f.admin.Close()
	}
	return err
}
func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	f, err := start(ctx, os.Getenv("DAYNIGHT_TEST_DATABASE_URL"), os.Getenv("DAYNIGHT_WEBHOOK_FIXTURE_TOKEN"), os.Getenv("DAYNIGHT_WEBHOOK_FIXTURE_PAT"), os.Getenv("DAYNIGHT_WEBHOOK_FIXTURE_MEMBER_TOKEN"), os.Getenv("DAYNIGHT_WEBHOOK_FIXTURE_MEMBER_PAT"))
	if err != nil {
		var issue *schemaIssue
		if errors.As(err, &issue) {
			fmt.Fprintln(os.Stderr, issue.Error())
		} else {
			fmt.Fprintln(os.Stderr, "webhook fixture startup failed")
		}
		os.Exit(1)
	}
	if err = json.NewEncoder(os.Stdout).Encode(f.info); err != nil {
		cleanup, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = f.close(cleanup)
		os.Exit(1)
	}
	select {
	case <-ctx.Done():
	case <-f.done:
	}
	cleanup, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err = f.close(cleanup); err != nil {
		fmt.Fprintf(os.Stderr, "webhook fixture cleanup failed; schema %s may remain\n", f.schema)
		os.Exit(1)
	}
}
