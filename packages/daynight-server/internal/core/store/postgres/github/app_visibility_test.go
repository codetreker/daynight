package github_test

import (
	"errors"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/githubpr"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func TestAppVisibilityReaderChecksLiveAdministratorInSnapshot(t *testing.T) {
	db, actor := dbFixture(t)
	ctx := t.Context()
	input := store.GitHubAppCreate{ID: uuid.NewString(), GitHubAppID: 901, Name: "App", GitHubName: "Remote", GitHubSlug: "remote", CreatorUserID: actor,
		Credentials: githubpr.AppCredentials{PrivateKeyPEM: []byte("key"), WebhookSecret: []byte("secret")}}
	if _, err := db.WriteGitHubApp(ctx, func(w store.GitHubAppWriteDAO) error { _, err := w.Create(ctx, input); return err }); err != nil {
		t.Fatal(err)
	}
	stranger := uuid.NewString()
	if err := db.ReadGitHubApps(ctx, func(r store.GitHubAppReadDAO) error {
		visible, ok := r.(store.GitHubAppVisibilityReader)
		if !ok {
			t.Fatal("visibility capability missing")
		}
		if err := visible.RequireAppVisible(ctx, input.ID, actor); err != nil {
			t.Fatal(err)
		}
		for _, tc := range []struct{ id, actor string }{{input.ID, stranger}, {uuid.NewString(), actor}} {
			if err := visible.RequireAppVisible(ctx, tc.id, tc.actor); !errors.Is(err, model.ErrNotFound) {
				t.Fatalf("hidden %s %s: %v", tc.id, tc.actor, err)
			}
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	// Visibility does not read the metadata projection, including its credential
	// integrity check. A scoped refusal must happen before that projection.
	if _, err := db.Pool.Exec(ctx, `UPDATE github_apps SET private_key_pem=NULL WHERE id=$1`, input.ID); err != nil {
		t.Fatal(err)
	}
	if err := db.ReadGitHubApps(ctx, func(r store.GitHubAppReadDAO) error {
		if err := r.(store.GitHubAppVisibilityReader).RequireAppVisible(ctx, input.ID, actor); err != nil {
			t.Fatal(err)
		}
		if _, err := r.Get(ctx, input.ID, actor); err == nil {
			t.Fatal("invalid metadata unexpectedly projected")
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Pool.Exec(ctx, `UPDATE github_apps SET private_key_pem=$2 WHERE id=$1`, input.ID, []byte("key")); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Pool.Exec(ctx, `INSERT INTO github_app_admins (app_resource_id,user_id) VALUES ($1,$2)`, input.ID, stranger); err != nil {
		t.Fatal(err)
	}
	if err := db.ReadGitHubApps(ctx, func(r store.GitHubAppReadDAO) error {
		if err := r.(store.GitHubAppVisibilityReader).RequireAppVisible(ctx, input.ID, actor); err != nil {
			t.Fatal(err)
		}
		if _, err := db.Pool.Exec(ctx, `DELETE FROM github_app_admins WHERE app_resource_id=$1 AND user_id=$2`, input.ID, actor); err != nil {
			t.Fatal(err)
		}
		got, err := r.Get(ctx, input.ID, actor)
		if err != nil || got.ID != input.ID {
			t.Fatalf("metadata lost snapshot: %+v %v", got, err)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if err := db.ReadGitHubApps(ctx, func(r store.GitHubAppReadDAO) error {
		if err := r.(store.GitHubAppVisibilityReader).RequireAppVisible(ctx, input.ID, actor); !errors.Is(err, model.ErrNotFound) {
			t.Fatalf("removed admin visible: %v", err)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Pool.Exec(ctx, `UPDATE github_apps SET deleted_at=now(), private_key_pem=NULL, webhook_secret=NULL WHERE id=$1`, input.ID); err != nil {
		t.Fatal(err)
	}
	if err := db.ReadGitHubApps(ctx, func(r store.GitHubAppReadDAO) error {
		if err := r.(store.GitHubAppVisibilityReader).RequireAppVisible(ctx, input.ID, stranger); !errors.Is(err, model.ErrNotFound) {
			t.Fatalf("deleted app visible: %v", err)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}
