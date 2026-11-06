package oauth

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/oauth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

func authorizationFixture(t *testing.T) (context.Context, *postgres.Store, *Authorizations, model.Principal, StartInput) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	t.Cleanup(cancel)
	db, e := postgres.Open(ctx, testutil.ScopedDatabaseURL(t))
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(db.Close)
	admission := core.PublicAdmission{Writer: db}
	clients, e := NewClients(db, admission, map[string][]byte{"client": []byte(`{"client_id":"client","client_name":"Example","redirect_uris":["https://client.example/cb"]}`)})
	if e != nil {
		t.Fatal(e)
	}
	svc, e := NewAuthorizations(db, clients, admission, "https://server.example")
	if e != nil {
		t.Fatal(e)
	}
	user := uuid.NewString()
	_, e = db.Pool.Exec(ctx, `INSERT INTO users (id,uniauth_id,created_at,updated_at) VALUES ($1,$2,now(),now())`, user, uuid.NewString())
	if e != nil {
		t.Fatal(e)
	}
	verifier := strings.Repeat("a", 43)
	hash := sha256.Sum256([]byte(verifier))
	principal := model.Principal{Kind: model.SessionCredential, UserID: user, CredentialID: uuid.NewString()}
	_, e = db.Pool.Exec(ctx, `INSERT INTO sessions (id,user_id,token_hash,created_at,expires_at) VALUES ($1,$2,$3,now(),now()+interval '1 hour')`, principal.CredentialID, user, []byte("01234567890123456789012345678901"))
	if e != nil {
		t.Fatal(e)
	}
	return ctx, db, svc, principal, StartInput{Source: "test", ClientID: "client", RedirectURI: "https://client.example/cb", ResponseType: "code", Scope: core.Scope, Resource: "https://server.example/mcp", State: "s", StatePresent: true, CodeChallenge: base64.RawURLEncoding.EncodeToString(hash[:]), CodeChallengeMethod: "S256"}
}
func TestAuthorizationExpiryAndPruning(t *testing.T) {
	ctx, db, svc, user, in := authorizationFixture(t)
	result, e := svc.Start(ctx, in)
	if e != nil {
		t.Fatal(e)
	}
	view, e := svc.Inspect(ctx, result.RequestID, result.Binding, user)
	if e != nil || view.Status != "pending" {
		t.Fatalf("pending: %+v %v", view, e)
	}
	dec, e := svc.Decide(ctx, DecisionInput{RequestID: result.RequestID, Binding: result.Binding, Principal: user, ExpectedUserID: user.UserID, Decision: "approve"})
	if e != nil {
		t.Fatal(e)
	}
	parsed, e := url.Parse(dec.RedirectURI)
	if e != nil {
		t.Fatal(e)
	}
	code := parsed.Query().Get("code")
	if _, e = db.Pool.Exec(ctx, `UPDATE oauth_authorizations SET code_expires_at=now()-interval '1 second' WHERE id=$1`, result.RequestID); e != nil {
		t.Fatal(e)
	}
	view, e = svc.Inspect(ctx, result.RequestID, result.Binding, user)
	if e != nil || view.Status != "approved" || !view.CodeExpired {
		t.Fatalf("approved fact lost: %+v %v", view, e)
	}
	_, e = svc.RedeemCode(ctx, RedeemInput{Code: code, ClientID: in.ClientID, RedirectURI: in.RedirectURI, Resource: in.Resource, Verifier: strings.Repeat("a", 43)})
	if !errors.Is(e, core.ErrInvalidGrant) {
		t.Fatalf("expired code: %v", e)
	}
	pending, e := svc.Start(ctx, in)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = db.Pool.Exec(ctx, `UPDATE oauth_authorizations SET expires_at=now()-interval '1 second' WHERE id=$1`, pending.RequestID); e != nil {
		t.Fatal(e)
	}
	n, e := svc.PruneAuthorizations(ctx, 100)
	if e != nil || n != 1 {
		t.Fatalf("expire: %d %v", n, e)
	}
	var state, status string
	var present bool
	if e = db.Pool.QueryRow(ctx, `SELECT state,state_present,status FROM oauth_authorizations WHERE id=$1`, pending.RequestID).Scan(&state, &present, &status); e != nil || state != "" || present || status != "expired" {
		t.Fatalf("expiry state: %q %v %q %v", state, present, status, e)
	}
	view, e = svc.Inspect(ctx, pending.RequestID, pending.Binding, user)
	if e != nil || view.Status != "expired" {
		t.Fatalf("expired view: %+v %v", view, e)
	}
	if _, e = db.Pool.Exec(ctx, `UPDATE oauth_authorizations SET retain_until=now()-interval '1 second'`); e != nil {
		t.Fatal(e)
	}
	n, e = svc.PruneAuthorizations(ctx, 100)
	if e != nil || n != 2 {
		t.Fatalf("delete: %d %v", n, e)
	}
	if _, e = svc.PruneAuthorizations(ctx, -1); e == nil {
		t.Fatal("negative budget accepted")
	}
}

// unknownWriter models a lost transaction response after the real commit.
type unknownWriter struct{ store.AuthorizationWriter }

func (w unknownWriter) WriteAuthorizations(ctx context.Context, fn func(store.AuthorizationScope) error) (store.Completion, error) {
	c, e := w.AuthorizationWriter.WriteAuthorizations(ctx, fn)
	if e == nil && c.Outcome == store.TransactionCommitted {
		return store.Completion{Outcome: store.TransactionUnknown}, errors.New("lost response")
	}
	return c, e
}
func TestAuthorizationUnknownDecision(t *testing.T) {
	ctx, db, svc, user, in := authorizationFixture(t)
	started, e := svc.Start(ctx, in)
	if e != nil {
		t.Fatal(e)
	}
	svc.writer = unknownWriter{db}
	result, e := svc.Decide(ctx, DecisionInput{RequestID: started.RequestID, Binding: started.Binding, Principal: user, ExpectedUserID: user.UserID, Decision: "approve"})
	if !errors.Is(e, core.ErrAuthorizationUnknown) || result.RedirectURI != "" {
		t.Fatalf("unknown exposed redirect: %+v %v", result, e)
	}
	svc.writer = db
	view, e := svc.Inspect(ctx, started.RequestID, started.Binding, user)
	if e != nil || view.Status != "approved" {
		t.Fatalf("unknown status: %+v %v", view, e)
	}
	_, e = svc.Decide(ctx, DecisionInput{RequestID: started.RequestID, Binding: started.Binding, Principal: user, ExpectedUserID: user.UserID, Decision: "approve"})
	if !errors.Is(e, core.ErrInvalidAuthorization) {
		t.Fatalf("repeat decision: %v", e)
	}
}

func TestAuthorizationCapacityAndFreshTime(t *testing.T) {
	ctx, db, _, _, _ := authorizationFixture(t)
	stale := time.Now().UTC().Add(-time.Hour)
	tx, e := db.Pool.Begin(ctx)
	if e != nil {
		t.Fatal(e)
	}
	defer tx.Rollback(ctx)
	if _, e = tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, int64(0x444e4f4155544841)); e != nil {
		t.Fatal(e)
	}
	record := store.OAuthAuthorization{ID: uuid.NewString(), BindingHash: make([]byte, 32), Client: []byte(`{}`), ClientID: "client", RedirectURI: "https://client.example/cb", Resource: "https://server.example/mcp", Scope: core.Scope, Challenge: "challenge", Status: "pending", CreatedAt: stale, ExpiresAt: stale.Add(10 * time.Minute), RetainUntil: stale.Add(24 * time.Hour)}
	done := make(chan error, 1)
	go func() {
		_, err := db.WriteAuthorizations(ctx, func(scope store.AuthorizationScope) error {
			ok, err := scope.AuthorizationDAO().InsertAuthorization(ctx, record, 1, stale)
			if err != nil {
				return err
			}
			if !ok {
				return errors.New("capacity denied")
			}
			return nil
		})
		done <- err
	}()
	waitForDBLock(t, ctx, db, "pg_advisory_xact_lock")
	released := time.Now().UTC()
	if e = tx.Commit(ctx); e != nil {
		t.Fatal(e)
	}
	if e = <-done; e != nil {
		t.Fatal(e)
	}
	var created, expires time.Time
	if e = db.Pool.QueryRow(ctx, `SELECT created_at,expires_at FROM oauth_authorizations WHERE id=$1`, record.ID).Scan(&created, &expires); e != nil || created.Before(released.Add(-time.Second)) || expires.Sub(created) != 10*time.Minute {
		t.Fatalf("fresh allocation: %v %v %v", created, expires, e)
	}
	record.ID = uuid.NewString()
	c, e := db.WriteAuthorizations(ctx, func(scope store.AuthorizationScope) error {
		ok, err := scope.AuthorizationDAO().InsertAuthorization(ctx, record, 1, time.Now())
		if ok {
			t.Error("capacity exceeded")
		}
		return err
	})
	if e != nil || c.Outcome != store.TransactionCommitted {
		t.Fatalf("capacity check: %+v %v", c, e)
	}
}
func waitForDBLock(t *testing.T, ctx context.Context, db *postgres.Store, query string) {
	t.Helper()
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	for {
		var waiting bool
		e := db.Pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE application_name=current_setting('application_name') AND wait_event_type='Lock' AND pid<>pg_backend_pid() AND position($1 in query)>0)`, query).Scan(&waiting)
		if e != nil {
			t.Fatal(e)
		}
		if waiting {
			return
		}
		select {
		case <-ctx.Done():
			t.Fatal("database lock wait not observed")
		case <-ticker.C:
		}
	}
}

func approvedCode(t *testing.T, ctx context.Context, svc *Authorizations, user model.Principal, in StartInput) (StartResult, RedeemInput) {
	t.Helper()
	started, e := svc.Start(ctx, in)
	if e != nil {
		t.Fatal(e)
	}
	d, e := svc.Decide(ctx, DecisionInput{RequestID: started.RequestID, Binding: started.Binding, Principal: user, ExpectedUserID: user.UserID, Decision: "approve"})
	if e != nil {
		t.Fatal(e)
	}
	u, e := url.Parse(d.RedirectURI)
	if e != nil {
		t.Fatal(e)
	}
	return started, RedeemInput{Code: u.Query().Get("code"), ClientID: in.ClientID, RedirectURI: in.RedirectURI, Resource: in.Resource, Verifier: strings.Repeat("a", 43)}
}
func TestAuthorizationLockWaitRechecksExpiry(t *testing.T) {
	ctx, db, svc, user, in := authorizationFixture(t)
	started, redeem := approvedCode(t, ctx, svc, user, in)
	tx, e := db.Pool.Begin(ctx)
	if e != nil {
		t.Fatal(e)
	}
	defer tx.Rollback(ctx)
	if _, e = tx.Exec(ctx, `UPDATE oauth_authorizations SET code_expires_at=now()-interval '1 second' WHERE id=$1`, started.RequestID); e != nil {
		t.Fatal(e)
	}
	done := make(chan error, 1)
	go func() { _, err := svc.RedeemCode(ctx, redeem); done <- err }()
	waitForDBLock(t, ctx, db, "WHERE code_hash=$1 FOR UPDATE")
	if e = tx.Commit(ctx); e != nil {
		t.Fatal(e)
	}
	if e = <-done; !errors.Is(e, core.ErrInvalidGrant) {
		t.Fatalf("expired while waiting: %v", e)
	}
	var count int
	if e = db.Pool.QueryRow(ctx, `SELECT count(*) FROM oauth_grants`).Scan(&count); e != nil || count != 0 {
		t.Fatalf("unexpected grant: %d %v", count, e)
	}
}

type blockingWriter struct {
	store.AuthorizationWriter
	entered chan struct{}
	release chan struct{}
}

func (w blockingWriter) WriteAuthorizations(ctx context.Context, fn func(store.AuthorizationScope) error) (store.Completion, error) {
	return w.AuthorizationWriter.WriteAuthorizations(ctx, func(s store.AuthorizationScope) error {
		if e := fn(s); e != nil {
			return e
		}
		close(w.entered)
		select {
		case <-w.release:
			return nil
		case <-ctx.Done():
			return ctx.Err()
		}
	})
}
func TestDCRIssuancePinsClientAgainstCleanup(t *testing.T) {
	ctx, db, svc, user, in := authorizationFixture(t)
	registered, e := svc.clients.Register(ctx, "registration", []byte(`{"redirect_uris":["https://client.example/cb"]}`))
	if e != nil {
		t.Fatal(e)
	}
	in.ClientID = registered.ClientID
	_, redeem := approvedCode(t, ctx, svc, user, in)
	writer := blockingWriter{AuthorizationWriter: db, entered: make(chan struct{}), release: make(chan struct{})}
	svc.writer = writer
	issue := make(chan error, 1)
	go func() { _, err := svc.RedeemCode(ctx, redeem); issue <- err }()
	select {
	case <-writer.entered:
	case <-ctx.Done():
		t.Fatal("issuance did not reach commit")
	}
	cleanup := make(chan error, 1)
	go func() { _, err := core.PruneClients(ctx, db, 100, time.Now().Add(8*24*time.Hour)); cleanup <- err }()
	waitForDBLock(t, ctx, db, "FROM oauth_clients WHERE id=$1 FOR UPDATE")
	close(writer.release)
	if e = <-issue; e != nil {
		t.Fatal(e)
	}
	if e = <-cleanup; e != nil {
		t.Fatal(e)
	}
	var clients, grants int
	if e = db.Pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM oauth_clients WHERE id=$1),(SELECT count(*) FROM oauth_grants WHERE client_id=$1)`, registered.ClientID).Scan(&clients, &grants); e != nil || clients != 1 || grants != 1 {
		t.Fatalf("cleanup removed referenced client: %d %d %v", clients, grants, e)
	}
}

func TestSessionRevocationAndExpiryDuringAuthorizationWait(t *testing.T) {
	t.Run("revoked while waiting for session", func(t *testing.T) {
		ctx, db, svc, p, in := authorizationFixture(t)
		started, e := svc.Start(ctx, in)
		if e != nil {
			t.Fatal(e)
		}
		tx, e := db.Pool.Begin(ctx)
		if e != nil {
			t.Fatal(e)
		}
		defer tx.Rollback(ctx)
		if _, e = tx.Exec(ctx, `DELETE FROM sessions WHERE id=$1`, p.CredentialID); e != nil {
			t.Fatal(e)
		}
		done := make(chan error, 1)
		go func() {
			_, err := svc.Decide(ctx, DecisionInput{RequestID: started.RequestID, Binding: started.Binding, Principal: p, ExpectedUserID: p.UserID, Decision: "approve"})
			done <- err
		}()
		waitForDBLock(t, ctx, db, "FROM sessions WHERE id=$1")
		if e = tx.Commit(ctx); e != nil {
			t.Fatal(e)
		}
		assertUnauthenticated(t, <-done)
		var status string
		if e = db.Pool.QueryRow(ctx, `SELECT status FROM oauth_authorizations WHERE id=$1`, started.RequestID).Scan(&status); e != nil || status != "pending" {
			t.Fatalf("revoked session decided: %s %v", status, e)
		}
	})
	t.Run("expired while waiting for request", func(t *testing.T) {
		ctx, db, svc, p, in := authorizationFixture(t)
		started, e := svc.Start(ctx, in)
		if e != nil {
			t.Fatal(e)
		}
		if _, e = db.Pool.Exec(ctx, `UPDATE sessions SET expires_at=clock_timestamp()+interval '1 hour' WHERE id=$1`, p.CredentialID); e != nil {
			t.Fatal(e)
		}
		var clock atomic.Int64
		clock.Store(time.Now().UnixNano())
		svc.now = func() time.Time { return time.Unix(0, clock.Load()) }
		tx, e := db.Pool.Begin(ctx)
		if e != nil {
			t.Fatal(e)
		}
		defer tx.Rollback(ctx)
		if _, e = tx.Exec(ctx, `SELECT id FROM oauth_authorizations WHERE id=$1 FOR UPDATE`, started.RequestID); e != nil {
			t.Fatal(e)
		}
		done := make(chan error, 1)
		go func() {
			_, err := svc.Decide(ctx, DecisionInput{RequestID: started.RequestID, Binding: started.Binding, Principal: p, ExpectedUserID: p.UserID, Decision: "approve"})
			done <- err
		}()
		waitForDBLock(t, ctx, db, "FROM oauth_authorizations WHERE id=$1 FOR UPDATE")
		clock.Store(time.Now().Add(2 * time.Hour).UnixNano())
		if e = tx.Commit(ctx); e != nil {
			t.Fatal(e)
		}
		assertUnauthenticated(t, <-done)
		var status string
		if e = db.Pool.QueryRow(ctx, `SELECT status FROM oauth_authorizations WHERE id=$1`, started.RequestID).Scan(&status); e != nil || status != "pending" {
			t.Fatalf("expired session decided: %s %v", status, e)
		}
	})
}
func assertUnauthenticated(t *testing.T, err error) {
	t.Helper()
	var fault *model.Fault
	if !errors.As(err, &fault) || fault.Code != "unauthenticated" {
		t.Fatalf("expected unauthenticated, got %v", err)
	}
}

func TestAuthorizationInvalidInputsAndInspection(t *testing.T) {
	ctx, db, svc, p, in := authorizationFixture(t)
	if _, err := NewAuthorizations(nil, svc.clients, svc.admission, "https://server.example"); !errors.Is(err, core.ErrInvalidAuthorization) {
		t.Fatalf("nil writer: %v", err)
	}
	for _, issuer := range []string{"", "https://server.example/path", "https://server.example?x=1", "ftp://server.example", "https://u@server.example"} {
		if _, err := NewAuthorizations(db, svc.clients, svc.admission, issuer); !errors.Is(err, core.ErrInvalidAuthorization) {
			t.Fatalf("issuer %q: %v", issuer, err)
		}
	}
	bad := in
	bad.Source = ""
	if _, err := svc.Start(ctx, bad); err == nil {
		t.Fatal("missing admission source accepted")
	}
	for _, change := range []func(*StartInput){func(v *StartInput) { v.ResponseType = "token" }, func(v *StartInput) { v.CodeChallengeMethod = "plain" }, func(v *StartInput) { v.Resource = "https://other/mcp" }, func(v *StartInput) { v.ClientID = "missing" }} {
		bad = in
		change(&bad)
		if _, err := svc.Start(ctx, bad); err == nil {
			t.Fatal("invalid start accepted")
		}
	}
	started, err := svc.Start(ctx, in)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = svc.Inspect(ctx, started.RequestID, started.Binding, model.Principal{}); err == nil {
		t.Fatal("invalid principal accepted")
	}
	for _, v := range []struct{ id, binding string }{{"bad", started.Binding}, {uuid.NewString(), started.Binding}, {started.RequestID, secret.Random(core.BindingPrefix)}} {
		if _, err = svc.Inspect(ctx, v.id, v.binding, p); !errors.Is(err, core.ErrInvalidAuthorization) {
			t.Fatalf("invalid inspection: %v", err)
		}
	}
	if _, err = db.Pool.Exec(ctx, `UPDATE oauth_authorizations SET client_snapshot='[]'::jsonb WHERE id=$1`, started.RequestID); err != nil {
		t.Fatal(err)
	}
	if _, err = svc.Inspect(ctx, started.RequestID, started.Binding, p); !errors.Is(err, core.ErrInvalidAuthorization) {
		t.Fatalf("invalid snapshot: %v", err)
	}
}

type failureWriter struct {
	err     error
	outcome store.TransactionOutcome
}

func (w failureWriter) WriteAuthorizations(context.Context, func(store.AuthorizationScope) error) (store.Completion, error) {
	return store.Completion{Outcome: w.outcome}, w.err
}

type capacityWriter struct{ store.AuthorizationWriter }
type capacityScope struct{ store.AuthorizationScope }
type capacityDAO struct{ store.AuthorizationDAO }

func (d capacityDAO) InsertAuthorization(context.Context, store.OAuthAuthorization, int, time.Time) (bool, error) {
	return false, nil
}
func (s capacityScope) AuthorizationDAO() store.AuthorizationDAO {
	return capacityDAO{s.AuthorizationScope.AuthorizationDAO()}
}
func (w capacityWriter) WriteAuthorizations(ctx context.Context, fn func(store.AuthorizationScope) error) (store.Completion, error) {
	return w.AuthorizationWriter.WriteAuthorizations(ctx, func(s store.AuthorizationScope) error { return fn(capacityScope{s}) })
}
func TestAuthorizationStorageFailuresAndCapacity(t *testing.T) {
	ctx, db, svc, p, in := authorizationFixture(t)
	started, redeem := approvedCode(t, ctx, svc, p, in)
	svc.writer = capacityWriter{db}
	if result, err := svc.Start(ctx, in); !errors.Is(err, core.ErrAuthorizationCapacity) || result.RequestID != "" {
		t.Fatalf("capacity: %+v %v", result, err)
	}
	fail := errors.New("storage unavailable")
	svc.writer = failureWriter{err: fail, outcome: store.TransactionNotCommitted}
	if _, err := svc.Start(ctx, in); !errors.Is(err, fail) {
		t.Fatalf("start failure: %v", err)
	}
	if _, err := svc.Inspect(ctx, started.RequestID, started.Binding, p); !errors.Is(err, fail) {
		t.Fatalf("inspect failure: %v", err)
	}
	if _, err := svc.RedeemCode(ctx, redeem); !errors.Is(err, fail) {
		t.Fatalf("redeem failure: %v", err)
	}
	if _, err := svc.PruneAuthorizations(ctx, 1); !errors.Is(err, fail) {
		t.Fatalf("prune failure: %v", err)
	}
	svc.writer = unknownWriter{db}
	if result, err := svc.RedeemCode(ctx, redeem); !errors.Is(err, core.ErrAuthorizationUnknown) || result.AccessToken != "" || result.RefreshToken != "" {
		t.Fatalf("unknown token response: %+v %v", result, err)
	}
	svc.writer = db
	if view, err := svc.Inspect(ctx, started.RequestID, started.Binding, p); err != nil || view.Status != "consumed" {
		t.Fatalf("unknown token status: %+v %v", view, err)
	}
}
func TestAuthorizationDCRMissingAndCodeReplay(t *testing.T) {
	ctx, db, svc, p, in := authorizationFixture(t)
	m, err := svc.clients.Register(ctx, "registration", []byte(`{"redirect_uris":["https://client.example/cb"]}`))
	if err != nil {
		t.Fatal(err)
	}
	in.ClientID = m.ClientID
	_, redeem := approvedCode(t, ctx, svc, p, in)
	if _, err = db.Pool.Exec(ctx, `DELETE FROM oauth_clients WHERE id=$1`, m.ClientID); err != nil {
		t.Fatal(err)
	}
	if _, err = svc.RedeemCode(ctx, redeem); !errors.Is(err, core.ErrInvalidGrant) {
		t.Fatalf("missing DCR client: %v", err)
	}
	in.ClientID = "client"
	_, redeem = approvedCode(t, ctx, svc, p, in)
	if _, err = svc.RedeemCode(ctx, redeem); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Pool.Exec(ctx, `UPDATE oauth_grants SET created_at=now()-interval '31 days',expires_at=now()-interval '1 day' WHERE client_id='client'`); err != nil {
		t.Fatal(err)
	}
	if _, err = svc.RedeemCode(ctx, redeem); !errors.Is(err, core.ErrInvalidGrant) {
		t.Fatalf("expired grant replay: %v", err)
	}
	redeem.Code = secret.Random(core.CodePrefix)
	if _, err = svc.RedeemCode(ctx, redeem); !errors.Is(err, core.ErrInvalidGrant) {
		t.Fatalf("unknown code: %v", err)
	}
}

type injectedWriter struct {
	store.AuthorizationWriter
	mode    string
	failure error
}
type injectedScope struct {
	store.AuthorizationScope
	mode    string
	failure error
}
type injectedAuthorizationDAO struct {
	store.AuthorizationDAO
	mode    string
	failure error
	calls   int
}
type injectedFamilyDAO struct {
	store.CredentialFamilyDAO
	mode    string
	failure error
}
type injectedClientDAO struct {
	store.OAuthClientDAO
	mode    string
	failure error
}

func (w injectedWriter) WriteAuthorizations(ctx context.Context, fn func(store.AuthorizationScope) error) (store.Completion, error) {
	return w.AuthorizationWriter.WriteAuthorizations(ctx, func(s store.AuthorizationScope) error { return fn(injectedScope{s, w.mode, w.failure}) })
}
func (s injectedScope) AuthorizationDAO() store.AuthorizationDAO {
	return &injectedAuthorizationDAO{AuthorizationDAO: s.AuthorizationScope.AuthorizationDAO(), mode: s.mode, failure: s.failure}
}
func (s injectedScope) CredentialFamilyDAO() store.CredentialFamilyDAO {
	return injectedFamilyDAO{s.AuthorizationScope.CredentialFamilyDAO(), s.mode, s.failure}
}
func (s injectedScope) OAuthClientDAO() store.OAuthClientDAO {
	return injectedClientDAO{s.AuthorizationScope.OAuthClientDAO(), s.mode, s.failure}
}
func (d *injectedAuthorizationDAO) AuthorizationByCode(ctx context.Context, hash []byte, lock bool) (store.OAuthAuthorization, error) {
	if lock && d.mode == "lock-code" {
		return store.OAuthAuthorization{}, d.failure
	}
	return d.AuthorizationDAO.AuthorizationByCode(ctx, hash, lock)
}
func (d *injectedAuthorizationDAO) FreshTime(ctx context.Context, now time.Time) (time.Time, error) {
	d.calls++
	if d.mode == "fresh" || (d.mode == "fresh-after-pin" && d.calls == 2) {
		return time.Time{}, d.failure
	}
	return d.AuthorizationDAO.FreshTime(ctx, now)
}
func (d *injectedAuthorizationDAO) UpdateAuthorization(ctx context.Context, a store.OAuthAuthorization) error {
	if d.mode == "update" {
		return d.failure
	}
	return d.AuthorizationDAO.UpdateAuthorization(ctx, a)
}
func (d injectedFamilyDAO) IssueFamily(ctx context.Context, v store.OAuthFamilyIssue) error {
	if d.mode == "issue" {
		return d.failure
	}
	return d.CredentialFamilyDAO.IssueFamily(ctx, v)
}
func (d injectedFamilyDAO) InspectGrant(ctx context.Context, id string, lock bool) (store.OAuthGrant, error) {
	if (lock && d.mode == "lock-grant") || (!lock && d.mode == "read-grant") {
		return store.OAuthGrant{}, d.failure
	}
	return d.CredentialFamilyDAO.InspectGrant(ctx, id, lock)
}
func (d injectedFamilyDAO) RevokeFamily(ctx context.Context, id string, now time.Time) (bool, error) {
	if d.mode == "revoke" {
		changed, err := d.CredentialFamilyDAO.RevokeFamily(ctx, id, now)
		if err != nil {
			return false, err
		}
		return changed, d.failure
	}
	return d.CredentialFamilyDAO.RevokeFamily(ctx, id, now)
}
func (d injectedClientDAO) PinClient(ctx context.Context, id string, now time.Time) (store.OAuthClient, error) {
	if d.mode == "pin" {
		return store.OAuthClient{}, d.failure
	}
	return d.OAuthClientDAO.PinClient(ctx, id, now)
}
func TestAuthorizationRedeemStorageFailuresRollBack(t *testing.T) {
	ctx, db, svc, p, in := authorizationFixture(t)
	failure := errors.New("injected storage failure")
	registered, err := svc.clients.Register(ctx, "registration", []byte(`{"redirect_uris":["https://client.example/cb"]}`))
	if err != nil {
		t.Fatal(err)
	}
	for _, mode := range []string{"lock-code", "fresh", "issue", "update", "pin", "fresh-after-pin", "lock-grant", "read-grant", "revoke"} {
		t.Run(mode, func(t *testing.T) {
			svc.writer = db
			request := in
			if mode == "pin" || mode == "fresh-after-pin" {
				request.ClientID = registered.ClientID
			}
			if mode == "update" {
				request.ClientID = "update-failure-client"
				svc.clients.preregistered[request.ClientID] = core.ClientMetadata{ClientID: request.ClientID, RedirectURIs: []string{request.RedirectURI}, TokenEndpointAuthMethod: "none"}
			}
			started, redeem := approvedCode(t, ctx, svc, p, request)
			replay := mode == "lock-grant" || mode == "read-grant" || mode == "revoke"
			var access string
			if replay {
				tokens, e := svc.RedeemCode(ctx, redeem)
				if e != nil {
					t.Fatal(e)
				}
				access = tokens.AccessToken
			}
			counts := func() [3]int {
				t.Helper()
				var values [3]int
				err := db.Pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM oauth_grants), (SELECT count(*) FROM oauth_access_tokens), (SELECT count(*) FROM oauth_refresh_tokens)`).Scan(&values[0], &values[1], &values[2])
				if err != nil {
					t.Fatal(err)
				}
				return values
			}
			before := counts()
			svc.writer = injectedWriter{db, mode, failure}
			if _, e := svc.RedeemCode(ctx, redeem); !errors.Is(e, failure) {
				t.Fatalf("%s: %v", mode, e)
			}
			svc.writer = db
			view, e := svc.Inspect(ctx, started.RequestID, started.Binding, p)
			if e != nil {
				t.Fatal(e)
			}
			want := "approved"
			if replay {
				want = "consumed"
			}
			if view.Status != want {
				t.Fatalf("failed transaction changed status: %+v", view)
			}
			if after := counts(); after != before {
				t.Fatalf("failed transaction changed family records: before %v after %v", before, after)
			}
			if mode == "update" {
				var grants, accesses, refreshes int
				err := db.Pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM oauth_grants WHERE client_id=$1), (SELECT count(*) FROM oauth_access_tokens a JOIN oauth_grants g ON g.id=a.grant_id WHERE g.client_id=$1), (SELECT count(*) FROM oauth_refresh_tokens r JOIN oauth_grants g ON g.id=r.grant_id WHERE g.client_id=$1)`, request.ClientID).Scan(&grants, &accesses, &refreshes)
				if err != nil || grants != 0 || accesses != 0 || refreshes != 0 {
					t.Fatalf("failed issue left family records: grants=%d access=%d refresh=%d: %v", grants, accesses, refreshes, err)
				}
			}
			if mode == "revoke" {
				_, e := db.WriteCredentialFamily(ctx, func(scope store.CredentialFamilyScope) error {
					identity, err := core.AuthenticateAccess(ctx, scope.CredentialFamilyDAO(), access, in.Resource, time.Now())
					if err != nil {
						return err
					}
					if identity.Principal.UserID != p.UserID {
						return errors.New("access authenticated as the wrong user")
					}
					return nil
				})
				if e != nil {
					t.Fatalf("rolled-back revocation invalidated access: %v", e)
				}
			}
			if !replay {
				if _, e = svc.RedeemCode(ctx, redeem); e != nil {
					t.Fatalf("retry after confirmed rollback: %v", e)
				}
			}
		})
	}
}

func TestCodeAdmissionReleasesConnectionBeforeClientBudget(t *testing.T) {
	ctx, db, svc, user, in := authorizationFixture(t)
	_, redeem := approvedCode(t, ctx, svc, user, in)
	config := db.Pool.Config()
	config.MaxConns = 1
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	single := &postgres.Store{Pool: pool}
	svc.writer = single
	admission := core.PublicAdmission{Writer: single}
	permit, allowed, err := admission.TakeToken(ctx, "single-pool")
	if err != nil || !allowed {
		t.Fatalf("permit: %v %v", allowed, err)
	}
	redeem.AdmitClient = func(ctx context.Context, id string) error {
		ok, err := permit.TakeClient(ctx, id)
		if err != nil {
			return err
		}
		if !ok {
			return core.ErrRateLimited
		}
		return nil
	}
	bounded, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	tokens, err := svc.RedeemCode(bounded, redeem)
	if err != nil || tokens.AccessToken == "" {
		t.Fatalf("single-connection exchange: %+v %v", tokens, err)
	}
}
