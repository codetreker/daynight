package github_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/githubpr"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/github"
	"github.com/google/uuid"
)

func TestAppCreationReadsAndTombstones(t *testing.T) {
	db, actor := dbFixture(t)
	ctx := t.Context()
	input := store.GitHubAppCreate{ID: uuid.NewString(), GitHubAppID: 901, Name: "Automation", GitHubName: "Remote", GitHubSlug: "remote", CreatorUserID: actor,
		Credentials: githubpr.AppCredentials{PrivateKeyPEM: []byte("key"), WebhookSecret: []byte("secret")}}
	create := func(v store.GitHubAppCreate) (githubpr.AppMetadata, store.Completion, error) {
		var result githubpr.AppMetadata
		completion, err := db.WriteGitHubApp(ctx, func(w store.GitHubAppWriteDAO) error {
			var err error
			result, err = w.Create(ctx, v)
			return err
		})
		return result, completion, err
	}
	app, completion, err := create(input)
	if err != nil || completion.Outcome != store.TransactionCommitted || app.ID != input.ID || app.Version != 1 || app.Administrators != 1 || app.AuthorizedTeams != 0 || app.ConnectedProjects != 0 || app.CreatedAt.IsZero() {
		t.Fatalf("creation: %+v %+v %v", app, completion, err)
	}
	duplicate := input
	duplicate.ID = uuid.NewString()
	if _, completion, err = create(duplicate); !errors.Is(err, store.ErrGitHubAppIDConflict) || completion.Outcome != store.TransactionNotCommitted {
		t.Fatalf("duplicate external ID: %+v %v", completion, err)
	}
	duplicate = input
	duplicate.GitHubAppID++
	if _, completion, err = create(duplicate); !errors.Is(err, store.ErrGitHubAppResourceIDConflict) || completion.Outcome != store.TransactionNotCommitted {
		t.Fatalf("duplicate resource ID: %+v %v", completion, err)
	}
	var key, secret []byte
	if err := db.Pool.QueryRow(ctx, `SELECT private_key_pem,webhook_secret FROM github_apps WHERE id=$1`, input.ID).Scan(&key, &secret); err != nil || string(key) != "key" || string(secret) != "secret" {
		t.Fatalf("secret persistence: %q %q %v", key, secret, err)
	}
	other := uuid.NewString()
	if err := db.ReadGitHubApps(ctx, func(r store.GitHubAppReadDAO) error {
		_, err := r.Get(ctx, input.ID, other)
		if !errors.Is(err, model.ErrNotFound) {
			t.Fatalf("non-admin read: %v", err)
		}
		page, err := r.List(ctx, store.GitHubAppQuery{ActorID: other, Limit: 1})
		if err != nil || len(page.Items) != 0 || page.Items == nil {
			t.Fatalf("non-admin list: %+v %v", page, err)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Pool.Exec(ctx, `UPDATE github_apps SET deleted_at=now(), private_key_pem=NULL, webhook_secret=NULL WHERE id=$1`, input.ID); err != nil {
		t.Fatal(err)
	}
	if err := db.ReadGitHubApps(ctx, func(r store.GitHubAppReadDAO) error {
		_, err := r.Get(ctx, input.ID, actor)
		if !errors.Is(err, model.ErrNotFound) {
			t.Fatalf("deleted read: %v", err)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	duplicate = input
	duplicate.ID = uuid.NewString()
	if _, completion, err = create(duplicate); err != nil || completion.Outcome != store.TransactionCommitted {
		t.Fatalf("reregister: %+v %v", completion, err)
	}
	duplicate = input
	duplicate.GitHubAppID = 999
	if _, completion, err = create(duplicate); !errors.Is(err, store.ErrGitHubAppResourceIDConflict) || completion.Outcome != store.TransactionNotCommitted {
		t.Fatalf("tombstone reuse: %+v %v", completion, err)
	}
}

func TestConcurrentAppRegistrationKeepsOnlyWinner(t *testing.T) {
	db, winner := dbFixture(t)
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	first, err := db.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	second, err := db.Pool.Begin(ctx)
	if err != nil {
		_ = first.Rollback(context.Background())
		t.Fatal(err)
	}
	done := make(chan error, 1)
	started, received := false, false
	defer func() {
		cancel()
		_ = first.Rollback(context.Background())
		if started && !received {
			<-done
		}
		_ = second.Rollback(context.Background())
	}()

	input := store.GitHubAppCreate{ID: uuid.NewString(), GitHubAppID: 901, Name: "Winner", GitHubName: "Remote", GitHubSlug: "remote", CreatorUserID: winner,
		Credentials: githubpr.AppCredentials{PrivateKeyPEM: []byte("key"), WebhookSecret: []byte("secret")}}
	if _, err := github.NewAppWriter(first).Create(ctx, input); err != nil {
		t.Fatal(err)
	}
	loser := input
	loser.ID, loser.CreatorUserID = uuid.NewString(), uuid.NewString()
	started = true
	go func() { _, err := github.NewAppWriter(second).Create(ctx, loser); done <- err }()
	// The loser must reach the unique-index lock before the winning transaction commits.
	waitForLock(t, db, int(second.Conn().PgConn().PID()))
	if err := first.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	err = <-done
	received = true
	if !errors.Is(err, store.ErrGitHubAppIDConflict) {
		t.Fatalf("loser result: %v", err)
	}
	if err := second.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	var apps, admins, correctAdmin, loserAdmin int
	if err := db.Pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM github_apps), (SELECT count(*) FROM github_app_admins),
 (SELECT count(*) FROM github_app_admins WHERE app_resource_id=$1 AND user_id=$2),
 (SELECT count(*) FROM github_app_admins WHERE app_resource_id=$3 OR user_id=$4)`, input.ID, winner, loser.ID, loser.CreatorUserID).
		Scan(&apps, &admins, &correctAdmin, &loserAdmin); err != nil || apps != 1 || admins != 1 || correctAdmin != 1 || loserAdmin != 0 {
		t.Fatalf("concurrent registration rows: apps=%d admins=%d winner=%d loser=%d err=%v", apps, admins, correctAdmin, loserAdmin, err)
	}
}

func TestAppScopeAtomicityCountsAndPagination(t *testing.T) {
	db, actor := dbFixture(t)
	ctx := t.Context()
	input := store.GitHubAppCreate{ID: uuid.NewString(), GitHubAppID: 1, Name: "A", GitHubName: "Remote", GitHubSlug: "remote", CreatorUserID: actor,
		Credentials: githubpr.AppCredentials{PrivateKeyPEM: []byte("key"), WebhookSecret: []byte("secret")}}
	refusal := errors.New("abort")
	completion, err := db.WriteGitHubApp(ctx, func(w store.GitHubAppWriteDAO) error {
		if _, err := w.Create(ctx, input); err != nil {
			return err
		}
		return refusal
	})
	if !errors.Is(err, refusal) || completion.Outcome != store.TransactionNotCommitted {
		t.Fatalf("rollback: %+v %v", completion, err)
	}
	var appCount, adminCount int
	if err := db.Pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM github_apps),(SELECT count(*) FROM github_app_admins)`).Scan(&appCount, &adminCount); err != nil || appCount != 0 || adminCount != 0 {
		t.Fatalf("partial rollback: %d %d %v", appCount, adminCount, err)
	}
	invalidCreator := input
	invalidCreator.CreatorUserID = "not-a-uuid"
	completion, err = db.WriteGitHubApp(ctx, func(w store.GitHubAppWriteDAO) error { _, err := w.Create(ctx, invalidCreator); return err })
	if err == nil || completion.Outcome != store.TransactionNotCommitted {
		t.Fatalf("administrator insert failure: %+v %v", completion, err)
	}
	if err := db.Pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM github_apps),(SELECT count(*) FROM github_app_admins)`).Scan(&appCount, &adminCount); err != nil || appCount != 0 || adminCount != 0 {
		t.Fatalf("administrator failure left rows: %d %d %v", appCount, adminCount, err)
	}
	for i := int64(1); i <= 2; i++ {
		input.ID, input.GitHubAppID = uuid.NewString(), i
		completion, err = db.WriteGitHubApp(ctx, func(w store.GitHubAppWriteDAO) error { _, err := w.Create(ctx, input); return err })
		if err != nil || completion.Outcome != store.TransactionCommitted {
			t.Fatalf("create: %+v %v", completion, err)
		}
	}
	project := uuid.NewString()
	for _, command := range []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO projects(id,name,repo_url) VALUES ($1,'Project','url')`, []any{project}},
		{`INSERT INTO project_github(project_id,enabled,app_resource_id) VALUES ($1,true,$2)`, []any{project, input.ID}},
		{`INSERT INTO github_app_team_grants(id,app_resource_id,team_id) VALUES ($1,$2,$3)`, []any{uuid.NewString(), input.ID, uuid.NewString()}},
		{`INSERT INTO github_app_admins(app_resource_id,user_id) VALUES ($1,$2)`, []any{input.ID, uuid.NewString()}},
	} {
		if _, err := db.Pool.Exec(ctx, command.sql, command.args...); err != nil {
			t.Fatal(err)
		}
	}
	if err := db.ReadGitHubApps(ctx, func(r store.GitHubAppReadDAO) error {
		got, err := r.Get(ctx, input.ID, actor)
		if err != nil || got.Administrators != 2 || got.AuthorizedTeams != 1 || got.ConnectedProjects != 1 {
			t.Fatalf("counts: %+v %v", got, err)
		}
		first, err := r.List(ctx, store.GitHubAppQuery{ActorID: actor, Limit: 1})
		if err != nil || len(first.Items) != 1 || !first.HasMore {
			t.Fatalf("first page: %+v %v", first, err)
		}
		last := first.Items[0]
		second, err := r.List(ctx, store.GitHubAppQuery{ActorID: actor, Limit: 1, After: &store.Position{CreatedAt: last.CreatedAt, ID: last.ID}})
		if err != nil || len(second.Items) != 1 || second.HasMore || second.Items[0].ID == last.ID {
			t.Fatalf("second page: %+v %v", second, err)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Pool.Exec(ctx, `UPDATE github_apps SET private_key_pem=NULL WHERE id=$1`, input.ID); err != nil {
		t.Fatal(err)
	}
	if err := db.ReadGitHubApps(ctx, func(r store.GitHubAppReadDAO) error { _, err := r.Get(ctx, input.ID, actor); return err }); err == nil {
		t.Fatal("missing live credentials must fail")
	}
}
