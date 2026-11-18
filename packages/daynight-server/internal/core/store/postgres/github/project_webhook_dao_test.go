package github_test

import (
	"errors"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/github"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func TestProjectWebhookDAOFailureAndConditionalWrite(t *testing.T) {
	f := newProjectAppFixture(t)
	ctx := t.Context()
	if _, _, err := f.write(ctx, "connect", 1, nil); err != nil {
		t.Fatal(err)
	}

	t.Run("missing connection", func(t *testing.T) {
		tx := begin(t, f.db, pgx.TxOptions{})
		got, err := github.NewProjectWebhookWriter(tx, uuid.NewString()).LockWebhook(ctx)
		if err != nil || got.Exists {
			t.Fatalf("missing connection: %+v %v", got, err)
		}
	})
	t.Run("invalid stored configuration", func(t *testing.T) {
		tx := begin(t, f.db, pgx.TxOptions{})
		mustExec(t, tx, `UPDATE project_github SET hook_version=1,hook_repository_id=8,hook_enabled=true,hook_secret=$2 WHERE project_id=$1`, f.project, []byte{0xff})
		got, err := github.NewProjectWebhookWriter(tx, f.project).LockWebhook(ctx)
		if err == nil || !got.Exists {
			t.Fatalf("invalid credential accepted: exists=%t err=%v", got.Exists, err)
		}
	})
	t.Run("binding read failure", func(t *testing.T) {
		tx := begin(t, f.db, pgx.TxOptions{})
		// Transactional rename makes the post-lock binding query fail without altering the fixture.
		mustExec(t, tx, `ALTER TABLE github_app_team_grants RENAME TO github_app_team_grants_unavailable`)
		_, err := github.NewProjectWebhookWriter(tx, f.project).LockWebhook(ctx)
		var failure *store.Error
		if !errors.As(err, &failure) || !failure.DatabaseFailure || failure.Phase != "read project webhook binding" {
			t.Fatalf("binding failure: %v", err)
		}
	})
	t.Run("lock and save database failures", func(t *testing.T) {
		tx := begin(t, f.db, pgx.TxOptions{})
		dao := github.NewProjectWebhookWriter(tx, "invalid-uuid")
		_, err := dao.LockWebhook(ctx)
		var failure *store.Error
		if !errors.As(err, &failure) || !failure.DatabaseFailure || failure.Phase != "lock project webhook" {
			t.Fatalf("lock failure: %v", err)
		}
		// Use another transaction because PostgreSQL aborts a transaction after the invalid UUID.
		tx2 := begin(t, f.db, pgx.TxOptions{})
		dao = github.NewProjectWebhookWriter(tx2, "invalid-uuid")
		ok, err := dao.SaveWebhook(ctx, store.GitHubProjectWebhookWrite{Version: 1, RepositoryID: 8, Enabled: true, Secret: []byte("private-secret")})
		if ok || !errors.As(err, &failure) || !failure.DatabaseFailure || failure.Phase != "save project webhook" || strings.Contains(err.Error(), "private-secret") {
			t.Fatalf("save failure: ok=%t err=%v", ok, err)
		}
	})
	t.Run("stale version leaves row unchanged", func(t *testing.T) {
		tx := begin(t, f.db, pgx.TxOptions{})
		dao := github.NewProjectWebhookWriter(tx, f.project)
		expected := int64(1)
		ok, err := dao.SaveWebhook(ctx, store.GitHubProjectWebhookWrite{ExpectedVersion: &expected, Version: 2, RepositoryID: 8, Enabled: true, Secret: []byte("secret")})
		if err != nil || ok {
			t.Fatalf("stale write: ok=%t err=%v", ok, err)
		}
		got, err := dao.LockWebhook(ctx)
		if err != nil || got.Version != nil || got.Enabled || got.Secret != nil {
			t.Fatalf("unexpected mutation: %+v %v", got, err)
		}
	})
}
