package postgres

import (
	"context"
	"errors"
	"slices"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopeadmission"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	wm "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
	"github.com/google/uuid"
)

type webhookAuthorizationReader interface {
	CurrentWebhookAuthorization(context.Context, model.Principal, model.CredentialPolicyProfile) (model.CredentialAuthorization, error)
}

func TestWebhookWriteReadsPolicyAfterCredentialLock(t *testing.T) {
	db := isolatedStore(t)
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	user, token := uuid.NewString(), uuid.NewString()
	mustQueryExec(t, db, `INSERT INTO users(id,uniauth_id,created_at,updated_at) VALUES($1,$2,now(),now())`, user, uuid.NewString())
	mustQueryExec(t, db, `INSERT INTO personal_access_tokens(id,user_id,token_hash,name,created_at,business_scopes,scope_version) VALUES($1,$2,decode(repeat('42',32),'hex'),'scope',now(),ARRAY['webhook:write'],1)`, token, user)
	p := model.Principal{Kind: model.PATCredential, UserID: user, CredentialID: token}
	editor, err := db.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = editor.Rollback(context.Background()) }()
	if _, err = editor.Exec(ctx, `UPDATE personal_access_tokens SET business_scopes=ARRAY['webhook:delete'],scope_version=2 WHERE id=$1`, token); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() {
		_, err := db.WriteWebhook(ctx, wm.Owner{Kind: "personal", ID: user}, uuid.NewString(), func(sc store.WebhookWriteScope) error {
			if _, err := sc.LockCredential(ctx, p); err != nil {
				return err
			}
			auth, err := sc.(webhookAuthorizationReader).CurrentWebhookAuthorization(ctx, p, model.ScopedPATProfile)
			if err != nil {
				return err
			}
			if auth.Policy == nil || auth.Policy.Version() != 2 || !slices.Equal(auth.Policy.Scopes(), []scopepolicy.ScopeID{"webhook:delete"}) {
				t.Errorf("current authorization: %+v", auth)
			}
			return scopeadmission.Require(auth, scopepolicy.WebhookWrite)
		})
		done <- err
	}()
	for {
		var blocked bool
		if err := db.Pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1::integer=ANY(pg_blocking_pids(pid)))`, int32(editor.Conn().PgConn().PID())).Scan(&blocked); err != nil {
			t.Fatal(err)
		}
		if blocked {
			break
		}
		select {
		case err := <-done:
			t.Fatalf("write did not wait: %v", err)
		case <-ctx.Done():
			t.Fatal("write did not reach lock")
		case <-time.After(10 * time.Millisecond):
		}
	}
	if err = editor.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-done:
		var f *model.Fault
		if !errors.As(err, &f) || f.Code != "insufficient_scope" {
			t.Fatalf("write should be refused: %v", err)
		}
	case <-ctx.Done():
		t.Fatal("write did not finish")
	}
}

func TestWebhookSnapshotRejectsMissingAndMalformedCredentialPolicies(t *testing.T) {
	db := isolatedStore(t)
	ctx := t.Context()
	user, token, session := uuid.NewString(), uuid.NewString(), uuid.NewString()
	mustQueryExec(t, db, `INSERT INTO users(id,uniauth_id,created_at,updated_at) VALUES($1,$2,now(),now())`, user, uuid.NewString())
	mustQueryExec(t, db, `INSERT INTO personal_access_tokens(id,user_id,token_hash,name,created_at,business_scopes,scope_version) VALUES($1,$2,decode(repeat('42',32),'hex'),'scope',now(),ARRAY['webhook:read'],1)`, token, user)
	mustQueryExec(t, db, `INSERT INTO sessions(id,user_id,token_hash,created_at,expires_at) VALUES($1,$2,decode(repeat('43',32),'hex'),now(),now()+interval '1 hour')`, session, user)
	pat := model.Principal{Kind: model.PATCredential, UserID: user, CredentialID: token}
	browser := model.Principal{Kind: model.SessionCredential, UserID: user, CredentialID: session}
	read := func(p model.Principal, profile model.CredentialPolicyProfile) (model.CredentialAuthorization, error) {
		var auth model.CredentialAuthorization
		err := db.ReadWebhookSnapshot(ctx, func(sc store.WebhookReadScope) error {
			var e error
			auth, e = sc.(webhookAuthorizationReader).CurrentWebhookAuthorization(ctx, p, profile)
			return e
		})
		return auth, err
	}
	got, err := read(browser, model.SessionProfile)
	if err != nil || got.Principal != browser || got.Policy != nil {
		t.Fatalf("session authorization=%+v err=%v", got, err)
	}
	missing := browser
	missing.CredentialID = uuid.NewString()
	if _, err = read(missing, model.SessionProfile); !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("missing session: %v", err)
	}
	if _, err = read(browser, model.OAuthAPIProfile); err == nil {
		t.Fatal("mismatched profile accepted")
	}
	missing = pat
	missing.CredentialID = uuid.NewString()
	if _, err = read(missing, model.ScopedPATProfile); !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("missing PAT: %v", err)
	}
	mustQueryExec(t, db, `ALTER TABLE personal_access_tokens ALTER COLUMN scope_version DROP NOT NULL`)
	mustQueryExec(t, db, `UPDATE personal_access_tokens SET scope_version=NULL WHERE id=$1`, token)
	if _, err = read(pat, model.ScopedPATProfile); err == nil {
		t.Fatal("missing scope version accepted")
	}
	mustQueryExec(t, db, `UPDATE personal_access_tokens SET business_scopes=ARRAY['unknown'],scope_version=1 WHERE id=$1`, token)
	if _, err = read(pat, model.ScopedPATProfile); err == nil {
		t.Fatal("unknown scope accepted")
	}
}
