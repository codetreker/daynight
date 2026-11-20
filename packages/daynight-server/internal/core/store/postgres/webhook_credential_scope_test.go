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
