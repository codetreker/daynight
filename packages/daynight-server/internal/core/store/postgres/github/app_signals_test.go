package github_test

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/github"
	"github.com/google/uuid"
)

type appSignalFixture struct {
	db                        *postgres.Store
	app, team, grant, project string
}

func newAppSignalFixture(t *testing.T) appSignalFixture {
	t.Helper()
	db, _ := dbFixture(t)
	f := appSignalFixture{db, uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()}
	ctx := t.Context()
	for _, q := range []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO github_apps(id,github_app_id,name,github_name,github_slug,private_key_pem,webhook_secret) VALUES($1,10,'app','remote','slug','key','secret')`, []any{f.app}},
		{`INSERT INTO teams(id,name) VALUES($1,'team')`, []any{f.team}},
		{`INSERT INTO github_app_team_grants(id,app_resource_id,team_id) VALUES($1,$2,$3)`, []any{f.grant, f.app, f.team}},
		{`INSERT INTO projects(id,name,repo_url) VALUES($1,'project','repo')`, []any{f.project}},
		{`INSERT INTO project_ownership(project_id,team_id) VALUES($1,$2)`, []any{f.project, f.team}},
		{`INSERT INTO project_github(project_id,app_resource_id,team_grant_id,app_id,credential_version,installation_id,repository_id,enabled,sync_enabled,generation) VALUES($1,$2,$3,10,1,20,30,true,true,4)`, []any{f.project, f.app, f.grant}},
	} {
		if _, err := db.Pool.Exec(ctx, q.sql, q.args...); err != nil {
			t.Fatal(err)
		}
	}
	return f
}
func (f appSignalFixture) signal(ctx context.Context, signal store.GitHubAppPRSignal) (int64, store.Completion, error) {
	var n int64
	completion, err := f.db.WriteGitHubAppSignals(ctx, f.app, 1, func(w store.GitHubAppSignalWriter) error {
		var e error
		n, e = w.SignalPullRequest(ctx, signal)
		return e
	})
	return n, completion, err
}
func signalInput() store.GitHubAppPRSignal {
	now := time.Now().UTC()
	return store.GitHubAppPRSignal{InstallationID: 20, RepositoryID: 30, Number: 7, RequestID: uuid.NewString(), DeliveryID: "delivery", ReceivedAt: now, NextAttemptAt: now}
}
func TestAppWebhookSnapshot(t *testing.T) {
	f := newAppSignalFixture(t)
	ctx := t.Context()
	snapshot, err := f.db.ReadGitHubAppWebhook(ctx, f.app)
	if err != nil || snapshot.GitHubAppID != 10 || snapshot.CredentialVersion != 1 || string(snapshot.Secret) != "secret" {
		t.Fatalf("snapshot: %+v %v", snapshot, err)
	}
	for _, sql := range []string{`UPDATE github_apps SET private_key_pem=NULL WHERE id=$1`,
		`UPDATE github_apps SET private_key_pem='key',webhook_secret=NULL WHERE id=$1`, `UPDATE github_apps SET webhook_secret=''::bytea WHERE id=$1`, `UPDATE github_apps SET webhook_secret='secret',credential_version=0 WHERE id=$1`} {
		if _, err = f.db.Pool.Exec(ctx, sql, f.app); err != nil {
			t.Fatal(err)
		}
		if _, err = f.db.ReadGitHubAppWebhook(ctx, f.app); err == nil || errors.Is(err, model.ErrNotFound) {
			t.Fatalf("expected invalid credential: %v", err)
		}
	}
	if _, err = f.db.Pool.Exec(ctx, `UPDATE github_apps SET deleted_at=now() WHERE id=$1`, f.app); err != nil {
		t.Fatal(err)
	}
	if _, err = f.db.ReadGitHubAppWebhook(ctx, f.app); !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("deleted App: %v", err)
	}
}
func TestAppSignalCurrentBindingAndMerge(t *testing.T) {
	for _, tc := range []struct {
		name, mutation string
		want           int64
	}{
		{"live", "", 1}, {"revoked", `UPDATE github_app_team_grants SET revoked_at=now() WHERE id=$1`, 0},
		{"wrong owner", `UPDATE project_ownership SET team_id=gen_random_uuid() WHERE project_id=$1`, 0},
		{"deleted", `UPDATE projects SET deleted_at=now() WHERE id=$1`, 0},
		{"disabled", `UPDATE project_github SET sync_enabled=false WHERE project_id=$1`, 0},
		{"old credential", `UPDATE project_github SET credential_version=2 WHERE project_id=$1`, 0},
		{"other app id", `UPDATE project_github SET app_id=11 WHERE project_id=$1`, 0},
		{"other installation", `UPDATE project_github SET installation_id=21 WHERE project_id=$1`, 0},
		{"other repository", `UPDATE project_github SET repository_id=31 WHERE project_id=$1`, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newAppSignalFixture(t)
			ctx := t.Context()
			target := f.project
			if tc.name == "revoked" {
				target = f.grant
			}
			if tc.mutation != "" {
				if _, err := f.db.Pool.Exec(ctx, tc.mutation, target); err != nil {
					t.Fatal(err)
				}
			}
			first := signalInput()
			n, c, err := f.signal(ctx, first)
			if err != nil || c.Outcome != store.TransactionCommitted || n != tc.want {
				t.Fatalf("signal: %d %+v %v", n, c, err)
			}
			second := signalInput()
			second.DeliveryID = "later"
			n, c, err = f.signal(ctx, second)
			if err != nil || c.Outcome != store.TransactionCommitted || n != tc.want {
				t.Fatalf("second signal: %d %+v %v", n, c, err)
			}
			var count int
			var request, delivery *string
			var generation *int64
			if err = f.db.Pool.QueryRow(ctx, `SELECT count(*),max(request_id::text),max(delivery_id),max(generation) FROM project_github_pending_prs WHERE project_id=$1`, f.project).Scan(&count, &request, &delivery, &generation); err != nil {
				t.Fatal(err)
			}
			if int64(count) != tc.want || (tc.want == 1 && (*request != second.RequestID || *delivery != "later" || *generation != 4)) {
				t.Fatalf("pending: %d %v %v %v", count, request, delivery, generation)
			}
		})
	}
}
func TestAppSignalAccessAndRollback(t *testing.T) {
	f := newAppSignalFixture(t)
	ctx := t.Context()
	now := time.Now().UTC()
	hint := uuid.NewString()
	completion, err := f.db.WriteGitHubAppSignals(ctx, f.app, 1, func(w store.GitHubAppSignalWriter) error {
		n, err := w.SignalAccess(ctx, store.GitHubAppAccessSignal{InstallationID: 20, HintID: hint, DeliveryID: "access", ReceivedAt: now})
		if err != nil || n != 1 {
			return fmt.Errorf("access n=%d: %w", n, err)
		}
		return nil
	})
	if err != nil || completion.Outcome != store.TransactionCommitted {
		t.Fatalf("access: %+v %v", completion, err)
	}
	var got string
	if err = f.db.Pool.QueryRow(ctx, `SELECT access_hint_id::text FROM project_github WHERE project_id=$1`, f.project).Scan(&got); err != nil || got != hint {
		t.Fatalf("hint %s %v", got, err)
	}
	sentinel := errors.New("abort")
	completion, err = f.db.WriteGitHubAppSignals(ctx, f.app, 1, func(w store.GitHubAppSignalWriter) error {
		if _, err := w.SignalPullRequest(ctx, signalInput()); err != nil {
			return err
		}
		return sentinel
	})
	if completion.Outcome != store.TransactionNotCommitted || !errors.Is(err, sentinel) {
		t.Fatalf("rollback: %+v %v", completion, err)
	}
	var count int
	if err = f.db.Pool.QueryRow(ctx, `SELECT count(*) FROM project_github_pending_prs WHERE project_id=$1`, f.project).Scan(&count); err != nil || count != 0 {
		t.Fatalf("rollback pending %d %v", count, err)
	}
}

func TestAppSignalRechecksAfterConnectionWait(t *testing.T) {
	for _, tc := range []struct{ name, mutation string }{
		{"transfer", `UPDATE project_ownership SET team_id=gen_random_uuid() WHERE project_id=$1`},
		{"delete", `UPDATE projects SET deleted_at=now() WHERE id=$1`},
		{"disconnect", `UPDATE project_github SET sync_enabled=false WHERE project_id=$1`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newAppSignalFixture(t)
			ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
			defer cancel()
			blocker, err := f.db.Pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer blocker.Rollback(context.Background())
			if _, err = blocker.Exec(ctx, `SELECT project_id FROM project_github WHERE project_id=$1 FOR UPDATE`, f.project); err != nil {
				t.Fatal(err)
			}
			if _, err = blocker.Exec(ctx, tc.mutation, f.project); err != nil {
				t.Fatal(err)
			}
			signalTx, err := f.db.Pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer signalTx.Rollback(context.Background())
			var pid int
			if err = signalTx.QueryRow(ctx, `SELECT pg_backend_pid()`).Scan(&pid); err != nil {
				t.Fatal(err)
			}
			writer := github.NewAppSignalWriter(signalTx, f.app, 10, 1)
			done := make(chan error, 1)
			go func() {
				n, e := writer.SignalPullRequest(ctx, signalInput())
				if e == nil && n != 0 {
					e = fmt.Errorf("stale candidate accepted: %d", n)
				}
				done <- e
			}()
			waitForLock(t, f.db, pid)
			if err = blocker.Commit(ctx); err != nil {
				t.Fatal(err)
			}
			select {
			case err = <-done:
				if err != nil {
					t.Fatal(err)
				}
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
			if err = signalTx.Commit(ctx); err != nil {
				t.Fatal(err)
			}
			var count int
			if err = f.db.Pool.QueryRow(ctx, `SELECT count(*) FROM project_github_pending_prs WHERE project_id=$1`, f.project).Scan(&count); err != nil || count != 0 {
				t.Fatalf("pending %d %v", count, err)
			}
		})
	}
}
