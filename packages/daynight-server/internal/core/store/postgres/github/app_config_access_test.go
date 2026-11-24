package github_test

import (
	"errors"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/github"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func TestAppConfigAccessUsesSameTransactionWithoutCredentials(t *testing.T) {
	db, app, actor, stranger := appAdminFixture(t)
	ctx := t.Context()
	if _, err := db.Pool.Exec(ctx, `UPDATE github_apps SET version=7,impact_version=9 WHERE id=$1`, app); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Pool.Exec(ctx, `UPDATE github_app_admins SET version=4 WHERE app_resource_id=$1 AND user_id=$2`, app, actor); err != nil {
		t.Fatal(err)
	}
	want := store.GitHubAppConfigAccess{AppVersion: 7, ImpactVersion: 9, MembershipVersion: 4}
	if err := db.ReadGitHubAppConfig(ctx, app, func(r store.GitHubAppConfigReader) error {
		access, ok := r.(store.GitHubAppConfigAccessReader)
		if !ok {
			t.Fatal("access capability missing")
		}
		got, err := access.ConfigAccess(ctx, actor)
		if err != nil || got != want {
			t.Fatalf("access: %+v %v", got, err)
		}
		if _, err := access.ConfigAccess(ctx, stranger); !errors.Is(err, model.ErrNotFound) {
			t.Fatalf("non-admin: %v", err)
		}
		facts, err := r.Facts(ctx, actor)
		if err != nil || facts.App.Version != got.AppVersion || facts.ImpactVersion != got.ImpactVersion || facts.MembershipVersion != got.MembershipVersion {
			t.Fatalf("facts differ: %+v %v", facts, err)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if err := db.ReadGitHubAppConfig(ctx, uuid.NewString(), func(r store.GitHubAppConfigReader) error {
		_, err := r.(store.GitHubAppConfigAccessReader).ConfigAccess(ctx, actor)
		if !errors.Is(err, model.ErrNotFound) {
			t.Fatalf("missing App: %v", err)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	completion, err := db.WriteGitHubAppConfig(ctx, app, func(w store.GitHubAppConfigWriter) error {
		got, err := w.(store.GitHubAppConfigAccessReader).ConfigAccess(ctx, actor)
		if err != nil || got != want {
			t.Fatalf("write scope access: %+v %v", got, err)
		}
		return nil
	})
	if err != nil || completion.Outcome != store.TransactionCommitted {
		t.Fatalf("write scope: %+v %v", completion, err)
	}

	// Hiding both credential columns in the test transaction proves the access
	// query does not even refer to them; the full configuration query cannot run.
	tx := begin(t, db, pgx.TxOptions{})
	mustExec(t, tx, `ALTER TABLE github_apps RENAME COLUMN private_key_pem TO hidden_private_key`)
	mustExec(t, tx, `ALTER TABLE github_apps RENAME COLUMN webhook_secret TO hidden_webhook_secret`)
	reader := github.NewAppConfigReader(tx, app)
	got, err := reader.(store.GitHubAppConfigAccessReader).ConfigAccess(ctx, actor)
	if err != nil || got != want {
		t.Fatalf("secret-independent access: %+v %v", got, err)
	}
	if _, err := reader.Facts(ctx, actor); err == nil {
		t.Fatal("full facts succeeded without credential columns")
	}
}
