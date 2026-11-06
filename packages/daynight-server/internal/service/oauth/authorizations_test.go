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
	"github.com/google/uuid"
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
