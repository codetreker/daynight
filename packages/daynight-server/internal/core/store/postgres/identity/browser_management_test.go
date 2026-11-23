package identity_test

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	service "github.com/codetreker/daynight/packages/daynight-server/internal/service/identity"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
	"github.com/google/uuid"
)

func TestBrowserManagementPersistencePaginationAndRevocation(t *testing.T) {
	f := newPreviewFixture(t)
	ctx := t.Context()
	svc := service.New(f.db, nil, "")
	browser, os := "Firefox", "Linux"
	ids := make([]string, 3)
	for i := range ids {
		ids[i] = uuid.NewString()
		session := model.Session{ID: ids[i], UserID: f.principal.UserID, TokenHash: hash(fmt.Sprint("management", i)), CreatedAt: f.now.Add(-time.Hour), ExpiresAt: f.now.Add(time.Hour), Browser: &browser, OS: &os}
		identityScopeTest(t, f.db, func(sc store.IdentityScope) error { return sc.IdentityDAO().InsertSession(ctx, session) })
	}
	expired := uuid.NewString()
	_, err := f.db.Pool.Exec(ctx, `INSERT INTO sessions(id,user_id,token_hash,created_at,expires_at) VALUES($1,$2,$3,clock_timestamp()-interval '2 hours',clock_timestamp()-interval '1 hour')`, expired, f.principal.UserID, hash("expired"))
	requireNoError(t, err)
	first, err := svc.ListBrowserSessions(ctx, f.principal, "", 2)
	requireNoError(t, err)
	if first.Current.ID != f.session.ID || first.Current.Browser != nil || first.Current.OS != nil || len(first.Items) != 2 || first.NextCursor == nil {
		t.Fatalf("first page %+v", first)
	}
	if first.Items[0].ID <= first.Items[1].ID || first.Items[0].Browser == nil || *first.Items[0].Browser != browser {
		t.Fatalf("projection/order %+v", first.Items)
	}
	second, err := svc.ListBrowserSessions(ctx, f.principal, *first.NextCursor, 2)
	requireNoError(t, err)
	if len(second.Items) != 1 || second.NextCursor != nil || second.Items[0].ID == first.Items[0].ID || second.Items[0].ID == first.Items[1].ID {
		t.Fatalf("second page %+v", second)
	}
	alt := f.principal
	alt.CredentialID = ids[0]
	_, err = svc.ListBrowserSessions(ctx, alt, *first.NextCursor, 2)
	var fault *model.Fault
	if !errors.As(err, &fault) || fault.Code != "invalid_input" {
		t.Fatalf("cross-session cursor: %v", err)
	}
	if err = svc.RevokeBrowserSession(ctx, f.principal, ids[0], f.principal.UserID, ids[1]); !errors.As(err, &fault) || fault.Code != "identity_mismatch" {
		t.Fatalf("identity change: %v", err)
	}
	if err = svc.RevokeBrowserSession(ctx, f.principal, f.session.ID, f.principal.UserID, f.session.ID); !errors.As(err, &fault) || fault.Code != "identity_mismatch" {
		t.Fatalf("self revoke: %v", err)
	}
	requireNoError(t, svc.RevokeBrowserSession(ctx, f.principal, ids[0], f.principal.UserID, f.session.ID))
	_, err = svc.GetBrowserSession(ctx, f.principal, ids[0])
	if !errors.As(err, &fault) || fault.Code != "not_found" {
		t.Fatalf("read revoked: %v", err)
	}
	_, err = svc.GetBrowserSession(ctx, f.principal, expired)
	if !errors.As(err, &fault) || fault.Code != "not_found" {
		t.Fatalf("read expired: %v", err)
	}
	_, err = svc.GetBrowserSession(ctx, f.principal, uuid.NewString())
	if !errors.As(err, &fault) || fault.Code != "not_found" {
		t.Fatalf("read missing: %v", err)
	}
	_, err = svc.GetBrowserSession(ctx, f.principal, ids[1])
	requireNoError(t, err)

	foreign := newPreviewFixtureInStore(t, f.db)
	_, err = svc.ListBrowserSessions(ctx, foreign.principal, *first.NextCursor, 2)
	if !errors.As(err, &fault) || fault.Code != "invalid_input" {
		t.Fatalf("cross-account cursor: %v", err)
	}
	_, missing := svc.GetBrowserSession(ctx, f.principal, uuid.NewString())
	_, foreignRead := svc.GetBrowserSession(ctx, f.principal, foreign.session.ID)
	var missingFault, foreignFault *model.Fault
	if !errors.As(missing, &missingFault) || !errors.As(foreignRead, &foreignFault) || missingFault.Code != foreignFault.Code || missingFault.Message != foreignFault.Message {
		t.Fatalf("cross-account read differs: %v / %v", missing, foreignRead)
	}
	missing = svc.RevokeBrowserSession(ctx, f.principal, uuid.NewString(), f.principal.UserID, f.principal.CredentialID)
	foreignRevoke := svc.RevokeBrowserSession(ctx, f.principal, foreign.session.ID, f.principal.UserID, f.principal.CredentialID)
	if !errors.As(missing, &missingFault) || !errors.As(foreignRevoke, &foreignFault) || missingFault.Code != foreignFault.Code || missingFault.Message != foreignFault.Message {
		t.Fatalf("cross-account revoke differs: %v / %v", missing, foreignRevoke)
	}
	var exists bool
	requireNoError(t, f.db.Pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM sessions WHERE id=$1 AND user_id=$2)`, foreign.session.ID, foreign.principal.UserID).Scan(&exists))
	if !exists {
		t.Fatal("foreign session changed")
	}
}
func TestBrowserManagementOpposingRevocationsSerialize(t *testing.T) {
	f := newPreviewFixture(t)
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	other := model.Session{ID: uuid.NewString(), UserID: f.principal.UserID, TokenHash: hash("opposing"), CreatedAt: f.now, ExpiresAt: f.now.Add(time.Hour)}
	identityScopeTest(t, f.db, func(sc store.IdentityScope) error { return sc.IdentityDAO().InsertSession(ctx, other) })
	svc := service.New(f.db, nil, "")
	second := model.Principal{Kind: model.SessionCredential, UserID: f.principal.UserID, CredentialID: other.ID}
	holder, err := f.db.Pool.Begin(ctx)
	requireNoError(t, err)
	defer holder.Rollback(context.Background())
	lower := f.principal.CredentialID
	if other.ID < lower {
		lower = other.ID
	}
	_, err = holder.Exec(ctx, `SELECT id FROM sessions WHERE id=$1 FOR UPDATE`, lower)
	requireNoError(t, err)
	start := make(chan struct{})
	results := make(chan error, 2)
	go func() {
		<-start
		results <- svc.RevokeBrowserSession(ctx, f.principal, other.ID, f.principal.UserID, f.principal.CredentialID)
	}()
	go func() {
		<-start
		results <- svc.RevokeBrowserSession(ctx, second, f.principal.CredentialID, second.UserID, second.CredentialID)
	}()
	close(start)
	waitBrowserLockers(t, ctx, f, holder.Conn().PgConn().PID(), 2)
	requireNoError(t, holder.Commit(ctx))
	a, b := <-results, <-results
	if (a == nil) == (b == nil) {
		t.Fatalf("exactly one revoke must commit: %v / %v", a, b)
	}
	var count int
	requireNoError(t, f.db.Pool.QueryRow(ctx, `SELECT count(*) FROM sessions WHERE user_id=$1`, f.principal.UserID).Scan(&count))
	if count != 1 {
		t.Fatalf("remaining sessions=%d", count)
	}
}

func waitBrowserLockers(t *testing.T, ctx context.Context, f previewFixture, blocker uint32, count int) {
	t.Helper()
	for {
		var n, direct int
		requireNoError(t, f.db.Pool.QueryRow(ctx, `SELECT count(*), count(*) FILTER (WHERE $1::integer=ANY(pg_blocking_pids(pid))) FROM pg_stat_activity WHERE application_name=current_schema() AND wait_event_type='Lock' AND query LIKE 'SELECT id::text,user_id::text,browser,os,created_at,last_used_at,expires_at FROM sessions%'`, int32(blocker)).Scan(&n, &direct))
		if n >= count && direct >= 1 {
			return
		}
		select {
		case <-ctx.Done():
			t.Fatal("browser operations did not wait for row lock")
		case <-time.After(time.Millisecond):
		}
	}
}

func TestBrowserManagementRechecksExpiryAfterLockWait(t *testing.T) {
	f := newPreviewFixture(t)
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	other := model.Session{ID: uuid.NewString(), UserID: f.principal.UserID, TokenHash: hash("expiry-wait"), CreatedAt: f.now.Add(-time.Hour), ExpiresAt: f.now.Add(time.Hour)}
	identityScopeTest(t, f.db, func(sc store.IdentityScope) error { return sc.IdentityDAO().InsertSession(ctx, other) })
	caller, target := f.principal, other.ID
	if caller.CredentialID < target {
		caller.CredentialID, target = target, caller.CredentialID
	}
	holder, err := f.db.Pool.Begin(ctx)
	requireNoError(t, err)
	defer holder.Rollback(context.Background())
	_, err = holder.Exec(ctx, `SELECT id FROM sessions WHERE id=$1 FOR UPDATE`, target)
	requireNoError(t, err)
	result := make(chan error, 1)
	svc := service.New(f.db, nil, "")
	go func() { result <- svc.RevokeBrowserSession(ctx, caller, target, caller.UserID, caller.CredentialID) }()
	waitBrowserLockers(t, ctx, f, holder.Conn().PgConn().PID(), 1)
	_, err = holder.Exec(ctx, `UPDATE sessions SET expires_at=clock_timestamp() WHERE id=$1`, target)
	requireNoError(t, err)
	requireNoError(t, holder.Commit(ctx))
	err = <-result
	var fault *model.Fault
	if !errors.As(err, &fault) || fault.Code != "not_found" {
		t.Fatalf("expired target: %v", err)
	}
	var count int
	requireNoError(t, f.db.Pool.QueryRow(ctx, `SELECT count(*) FROM sessions WHERE id=$1`, target).Scan(&count))
	if count != 1 {
		t.Fatal("expired row was deleted")
	}
}

func TestBrowserRevocationInvalidatesMainPreviewAndCredentialRecheck(t *testing.T) {
	f := newPreviewFixture(t)
	ctx := t.Context()
	svc := service.New(f.db, nil, "")
	mainSecret, previewSecret, otherSecret, patSecret := secret.Random("dnst_"), secret.Random("dnpv_"), secret.Random("dnst_"), secret.Random("dnpat_")
	_, err := f.db.Pool.Exec(ctx, `UPDATE sessions SET token_hash=$2,preview_token_hash=$3 WHERE id=$1`, f.session.ID, secret.Hash(mainSecret), secret.Hash(previewSecret))
	requireNoError(t, err)
	other := model.Session{ID: uuid.NewString(), UserID: f.principal.UserID, TokenHash: secret.Hash(otherSecret), CreatedAt: f.now, ExpiresAt: f.now.Add(time.Hour)}
	policy, err := scopepolicy.NewPolicy(scopepolicy.PAT, []scopepolicy.ScopeID{"task:read"}, 1)
	requireNoError(t, err)
	pat := model.PersonalAccessToken{ScopePolicy: &policy, ID: uuid.NewString(), UserID: f.principal.UserID, TokenHash: secret.Hash(patSecret), Name: "unaffected", CreatedAt: f.now}
	identityScopeTest(t, f.db, func(sc store.IdentityScope) error {
		if err := sc.IdentityDAO().InsertSession(ctx, other); err != nil {
			return err
		}
		return sc.IdentityDAO().InsertPAT(ctx, pat)
	})
	oauthPolicy, err := scopepolicy.NewPolicy(scopepolicy.MCP, []scopepolicy.ScopeID{"task:read"}, 1)
	requireNoError(t, err)
	issue := store.OAuthFamilyIssue{
		Grant:    store.OAuthGrant{ID: uuid.NewString(), UserID: f.principal.UserID, ClientID: "test-client", ClientSnapshot: []byte(`{"client_name":"Tool"}`), Resource: "https://example.test/mcp", Scope: "daynight:mcp", ScopePolicy: &oauthPolicy, CreatedAt: f.now, ExpiresAt: f.now.Add(24 * time.Hour)},
		AccessID: uuid.NewString(), AccessHash: hash("oauth-access"), RefreshHash: hash("oauth-refresh"), AccessExpiresAt: f.now.Add(time.Hour),
	}
	binding := []store.OAuthBinding{{Resource: issue.Grant.Resource, Scope: issue.Grant.Scope}}
	identityScopeTest(t, f.db, func(sc store.IdentityScope) error { return sc.CredentialFamilyDAO().IssueFamily(ctx, issue) })
	checkOAuth := func() {
		t.Helper()
		identityScopeTest(t, f.db, func(sc store.IdentityScope) error {
			got, err := sc.CredentialFamilyDAO().AuthenticateAccess(ctx, issue.AccessHash, binding, time.Now())
			if err != nil {
				return err
			}
			if got.Principal.CredentialID != issue.AccessID || got.Principal.UserID != issue.Grant.UserID || got.GrantID != issue.Grant.ID {
				return fmt.Errorf("OAuth identity changed: %+v", got)
			}
			return nil
		})
		var intact bool
		requireNoError(t, f.db.Pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM oauth_refresh_tokens WHERE token_hash=$1 AND grant_id=$2) AND EXISTS(SELECT 1 FROM oauth_grants WHERE id=$2 AND revoked_at IS NULL)`, issue.RefreshHash, issue.Grant.ID).Scan(&intact))
		if !intact {
			t.Fatal("OAuth family changed")
		}
	}
	checkOAuth()
	caller := model.Principal{Kind: model.SessionCredential, UserID: f.principal.UserID, CredentialID: other.ID}
	preview, err := service.NewPreviewSSO(f.db, "https://daynight.cc", "https://preview.daynight.cc", "https://daynight.cc/api/v1/auth/callback")
	requireNoError(t, err)
	_, err = svc.Authenticate(ctx, model.SessionCredential, mainSecret)
	requireNoError(t, err)
	_, _, err = preview.Authenticate(ctx, previewSecret)
	requireNoError(t, err)
	requireNoError(t, svc.RevokeBrowserSession(ctx, caller, f.session.ID, caller.UserID, caller.CredentialID))
	_, err = svc.Authenticate(ctx, model.SessionCredential, mainSecret)
	requireMissing(t, err)
	_, _, err = preview.Authenticate(ctx, previewSecret)
	requireMissing(t, err)
	completion, err := f.db.WriteIdentity(ctx, func(sc store.IdentityScope) error { return sc.IdentityDAO().LockSession(ctx, f.principal, time.Now()) })
	requireMissing(t, err)
	if completion.Outcome != store.TransactionNotCommitted {
		t.Fatalf("credential recheck completion: %+v", completion)
	}
	observed, err := svc.Authenticate(ctx, model.SessionCredential, otherSecret)
	requireNoError(t, err)
	if observed != caller {
		t.Fatalf("other session: %+v", observed)
	}
	observed, err = svc.Authenticate(ctx, model.PATCredential, patSecret)
	requireNoError(t, err)
	if observed.CredentialID != pat.ID {
		t.Fatalf("PAT: %+v", observed)
	}
	checkOAuth()
}

func TestBrowserManagementRechecksCallerExpiryAfterLockWait(t *testing.T) {
	f := newPreviewFixture(t)
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	other := model.Session{ID: uuid.NewString(), UserID: f.principal.UserID, TokenHash: hash("caller-expiry-wait"), CreatedAt: f.now.Add(-time.Hour), ExpiresAt: f.now.Add(time.Hour)}
	identityScopeTest(t, f.db, func(sc store.IdentityScope) error { return sc.IdentityDAO().InsertSession(ctx, other) })
	caller, target := f.principal, other.ID
	if caller.CredentialID > target {
		caller.CredentialID, target = target, caller.CredentialID
	}
	holder, err := f.db.Pool.Begin(ctx)
	requireNoError(t, err)
	defer holder.Rollback(context.Background())
	_, err = holder.Exec(ctx, `SELECT id FROM sessions WHERE id=$1 FOR UPDATE`, caller.CredentialID)
	requireNoError(t, err)
	result := make(chan error, 1)
	svc := service.New(f.db, nil, "")
	go func() { result <- svc.RevokeBrowserSession(ctx, caller, target, caller.UserID, caller.CredentialID) }()
	waitBrowserLockers(t, ctx, f, holder.Conn().PgConn().PID(), 1)
	_, err = holder.Exec(ctx, `UPDATE sessions SET expires_at=clock_timestamp() WHERE id=$1`, caller.CredentialID)
	requireNoError(t, err)
	requireNoError(t, holder.Commit(ctx))
	err = <-result
	if !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("expired caller: %v", err)
	}
	var count int
	requireNoError(t, f.db.Pool.QueryRow(ctx, `SELECT count(*) FROM sessions WHERE id=$1 AND expires_at>clock_timestamp()`, target).Scan(&count))
	if count != 1 {
		t.Fatal("valid target changed after caller expiry")
	}
}
