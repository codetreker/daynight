package postgres

import (
	"errors"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func TestAppConfigScopeMissingRootAndClosedPool(t *testing.T) {
	db, app, _, _, _ := appAdminScopeFixture(t)
	ctx := t.Context()
	called := false
	c, err := db.WriteGitHubAppConfig(ctx, uuid.NewString(), func(store.GitHubAppConfigWriter) error { called = true; return nil })
	if called || !errors.Is(err, model.ErrNotFound) || c.Outcome != store.TransactionNotCommitted {
		t.Fatalf("missing root: %+v %v called=%v", c, err, called)
	}
	db.Pool.Close()
	c, err = db.WriteGitHubAppConfig(ctx, app, func(store.GitHubAppConfigWriter) error { t.Fatal("closed pool callback"); return nil })
	if err == nil || c.Outcome != store.TransactionNotCommitted {
		t.Fatalf("closed pool: %+v %v", c, err)
	}
}
