package github_test

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"testing"
	"time"

	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/github"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/githubpr"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/github"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type appWorkFixture struct {
	db                                       *postgres.Store
	project, app, grant, team, hint, request string
	identity                                 store.GitHubAppWorkIdentity
}

func newAppWorkFixture(t *testing.T) appWorkFixture {
	t.Helper()
	db, project := dbFixture(t)
	f := appWorkFixture{db: db, project: project, app: uuid.NewString(), grant: uuid.NewString(), team: uuid.NewString(), hint: uuid.NewString(), request: uuid.NewString()}
	f.identity = store.GitHubAppWorkIdentity{AppResourceID: f.app, GrantID: f.grant, TeamID: f.team, AppID: 91, CredentialVersion: 1}
	for _, q := range []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO projects(id,name,repo_url) VALUES($1,'Project','https://github.com/owner/repo')`, []any{f.project}},
		{`INSERT INTO teams(id,name) VALUES($1,'Team')`, []any{f.team}},
		{`INSERT INTO project_ownership(project_id,team_id) VALUES($1,$2)`, []any{f.project, f.team}},
		{`INSERT INTO github_apps(id,github_app_id,name,github_name,github_slug,private_key_pem,webhook_secret) VALUES($1,91,'App','App','app','key','secret')`, []any{f.app}},
		{`INSERT INTO github_app_team_grants(id,app_resource_id,team_id) VALUES($1,$2,$3)`, []any{f.grant, f.app, f.team}},
		{`INSERT INTO project_github(project_id,version,generation,revision,enabled,sync_enabled,app_id,installation_id,repository_id,app_resource_id,team_grant_id,credential_version,access_state,access_hint_id,access_delivery_id,next_poll_at) VALUES($1,2,1,7,true,true,91,20,30,$2,$3,1,'available',$4,'delivery',now()-interval '1 minute')`, []any{f.project, f.app, f.grant, f.hint}},
		{`INSERT INTO project_github_pending_prs(project_id,number,generation,request_id,delivery_id,received_at,next_attempt_at) VALUES($1,42,1,$2,'delivery',now(),now())`, []any{f.project, f.request}},
	} {
		if _, err := db.Pool.Exec(t.Context(), q.sql, q.args...); err != nil {
			t.Fatal(err)
		}
	}
	return f
}

func (f appWorkFixture) claimed(t *testing.T, tx pgx.Tx) (store.GitHubAppWorkDAO, store.GitHubLease, time.Time) {
	t.Helper()
	w, err := github.NewAppWorkWriter(t.Context(), tx, f.project, &f.identity)
	if err != nil {
		t.Fatal(err)
	}
	now, err := w.ObservedAt(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	lease := store.GitHubLease{Generation: 1, Token: uuid.NewString()}
	ok, err := w.Claim(t.Context(), store.GitHubClaim{AppID: 91, Generation: 1, Token: lease.Token, Kind: core.WorkPoll, Until: now.Add(5 * time.Minute)})
	if err != nil || !ok {
		t.Fatalf("claim: %v %v", ok, err)
	}
	return w, lease, now
}

func TestAppWorkPublishesWithCapturedIdentity(t *testing.T) {
	f := newAppWorkFixture(t)
	tx := begin(t, f.db, pgx.TxOptions{})
	w, lease, now := f.claimed(t, tx)
	ctx := t.Context()
	if w.Identity() != f.identity {
		t.Fatalf("identity: %+v", w.Identity())
	}
	if ok, err := w.ValidLease(ctx, lease); err != nil || !ok {
		t.Fatalf("lease: %v %v", ok, err)
	}
	if due, err := w.HasDuePending(ctx, now.Add(time.Second)); err != nil || !due {
		t.Fatalf("due: %v %v", due, err)
	}
	if pending, valid, err := w.Pending(ctx, lease, now.Add(time.Second), 25); err != nil || !valid || len(pending) != 1 || pending[0].RequestID != f.request {
		t.Fatalf("pending: %+v %v %v", pending, valid, err)
	}
	if pending, valid, err := w.HasPending(ctx, lease); err != nil || !valid || !pending {
		t.Fatalf("has pending: %v %v %v", pending, valid, err)
	}
	if ok, err := w.Renew(ctx, lease, now.Add(6*time.Minute)); err != nil || !ok {
		t.Fatalf("renew: %v %v", ok, err)
	}
	if ok, err := w.PublishRepository(ctx, lease, store.GitHubRepositoryObservation{InstallationID: 20, RepositoryID: 30, InstallationAccountLogin: "owner", RepositoryFullName: "owner/repo", RepositoryPrivate: true}); err != nil || !ok {
		t.Fatalf("repository: %v %v", ok, err)
	}
	p := githubpr.PullRequest{PullRequestSummary: githubpr.PullRequestSummary{Number: 42, GitHubID: 420, URL: "https://github.com/owner/repo/pull/42", Title: "Title", State: "open", BaseRef: "main", HeadSHA: "sha", GitHubCreatedAt: now, GitHubUpdatedAt: now, ObservedAt: now}, Description: ptr("Description")}
	if ok, err := w.Publish(ctx, lease, []githubpr.PullRequest{p}); err != nil || !ok {
		t.Fatalf("publish: %v %v", ok, err)
	}
	if numbers, valid, err := w.UnseenActive(ctx, lease, uuid.NewString(), 0, 25); err != nil || !valid || !reflect.DeepEqual(numbers, []int64{42}) {
		t.Fatalf("unseen: %v %v %v", numbers, valid, err)
	}
	if ok, err := w.ReschedulePending(ctx, lease, 42, f.request, now.Add(time.Hour)); err != nil || !ok {
		t.Fatalf("reschedule: %v %v", ok, err)
	}
	if ok, err := w.AckPending(ctx, lease, 42, f.request); err != nil || !ok {
		t.Fatalf("ack: %v %v", ok, err)
	}
	if ok, err := w.AckAccessHint(ctx, lease, f.hint); err != nil || !ok {
		t.Fatalf("hint: %v %v", ok, err)
	}
	conn, err := w.Connection(ctx)
	if err != nil {
		t.Fatal(err)
	}
	runtime := core.Runtime(conn)
	runtime.ReleaseClaim = true
	if ok, err := w.SaveRuntime(ctx, lease, runtime); err != nil || !ok {
		t.Fatalf("runtime: %v %v", ok, err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	var title string
	if err := f.db.Pool.QueryRow(ctx, `SELECT title FROM project_pull_requests WHERE project_id=$1 AND number=42`, f.project).Scan(&title); err != nil || title != "Title" {
		t.Fatalf("persisted: %q %v", title, err)
	}
}

func assertAppWorkFenced(t *testing.T, w store.GitHubAppWorkDAO, lease store.GitHubLease, now time.Time, f appWorkFixture) {
	t.Helper()
	ctx := t.Context()
	checks := []struct {
		name string
		run  func() (bool, error)
	}{
		{"lease", func() (bool, error) { return w.ValidLease(ctx, lease) }},
		{"renew", func() (bool, error) { return w.Renew(ctx, lease, now.Add(time.Hour)) }},
		{"publish", func() (bool, error) { return w.Publish(ctx, lease, []githubpr.PullRequest{{}}) }},
		{"repository", func() (bool, error) {
			return w.PublishRepository(ctx, lease, store.GitHubRepositoryObservation{InstallationID: 20, RepositoryID: 30})
		}},
		{"ack pending", func() (bool, error) { return w.AckPending(ctx, lease, 42, f.request) }},
		{"reschedule", func() (bool, error) { return w.ReschedulePending(ctx, lease, 42, f.request, now.Add(time.Hour)) }},
		{"ack access", func() (bool, error) { return w.AckAccessHint(ctx, lease, f.hint) }},
		{"runtime", func() (bool, error) {
			return w.SaveRuntime(ctx, lease, store.GitHubRuntimeWrite{ExpectedRevision: 8, Revision: 9, AccessState: "available", ReleaseClaim: true})
		}},
	}
	for _, check := range checks {
		if ok, err := check.run(); err != nil || ok {
			t.Fatalf("%s escaped fence: %v %v", check.name, ok, err)
		}
	}
	if _, valid, err := w.Pending(ctx, lease, now, 25); err != nil || valid {
		t.Fatalf("pending escaped: %v %v", valid, err)
	}
	if _, valid, err := w.UnseenActive(ctx, lease, uuid.NewString(), 0, 25); err != nil || valid {
		t.Fatalf("unseen escaped: %v %v", valid, err)
	}
	if _, valid, err := w.HasPending(ctx, lease); err != nil || valid {
		t.Fatalf("has pending escaped: %v %v", valid, err)
	}
}

func TestAppWorkEveryWriteRejectsStaleAuthorization(t *testing.T) {
	f := newAppWorkFixture(t)
	changes := []struct {
		name, sql string
		args      []any
	}{
		{"App deleted", `UPDATE github_apps SET deleted_at=now() WHERE id=$1`, []any{f.app}},
		{"credential changed", `UPDATE github_apps SET credential_version=2 WHERE id=$1`, []any{f.app}},
		{"binding credential changed", `UPDATE project_github SET credential_version=2 WHERE project_id=$1`, []any{f.project}},
		{"grant revoked", `UPDATE github_app_team_grants SET revoked_at=now() WHERE id=$1`, []any{f.grant}},
		{"grant replaced", `UPDATE project_github SET team_grant_id=$2 WHERE project_id=$1`, []any{f.project, uuid.NewString()}},
		{"owner changed", `UPDATE project_ownership SET team_id=$2 WHERE project_id=$1`, []any{f.project, uuid.NewString()}},
		{"Project deleted", `UPDATE projects SET deleted_at=now() WHERE id=$1`, []any{f.project}},
		{"Team deleted", `DELETE FROM teams WHERE id=$1`, []any{f.team}},
		{"disabled", `UPDATE project_github SET enabled=false WHERE project_id=$1`, []any{f.project}},
		{"sync disabled", `UPDATE project_github SET sync_enabled=false WHERE project_id=$1`, []any{f.project}},
		{"external App changed", `UPDATE project_github SET app_id=92 WHERE project_id=$1`, []any{f.project}},
		{"App replaced", `UPDATE project_github SET app_resource_id=$2 WHERE project_id=$1`, []any{f.project, uuid.NewString()}},
	}
	for _, change := range changes {
		t.Run(change.name, func(t *testing.T) {
			tx := begin(t, f.db, pgx.TxOptions{})
			w, lease, now := f.claimed(t, tx)
			mustExec(t, tx, change.sql, change.args...)
			assertAppWorkFenced(t, w, lease, now, f)
			if _, err := w.Connection(t.Context()); !errors.Is(err, store.ErrGitHubAppWorkUnavailable) {
				t.Fatalf("connection: %v", err)
			}
			if due, err := w.HasDuePending(t.Context(), now.Add(time.Second)); err != nil || due {
				t.Fatalf("due escaped: %v %v", due, err)
			}
			mustExec(t, tx, `UPDATE project_github SET claim_token=NULL,claim_until=NULL,claim_kind=NULL WHERE project_id=$1`, f.project)
			if ok, err := w.Claim(t.Context(), store.GitHubClaim{AppID: 91, Generation: 1, Token: uuid.NewString(), Kind: core.WorkPoll, Until: now.Add(time.Hour)}); err != nil || ok {
				t.Fatalf("claim escaped: %v %v", ok, err)
			}
		})
	}
	for _, field := range []string{"generation=generation+1", "claim_until=now()-interval '1 second'", "claim_token=gen_random_uuid()"} {
		t.Run(field, func(t *testing.T) {
			tx := begin(t, f.db, pgx.TxOptions{})
			w, lease, now := f.claimed(t, tx)
			mustExec(t, tx, `UPDATE project_github SET `+field+` WHERE project_id=$1`, f.project)
			assertAppWorkFenced(t, w, lease, now, f)
		})
	}
}

func TestAppWorkCandidatesFilterBeforeLimit(t *testing.T) {
	f := newAppWorkFixture(t)
	ctx := t.Context()
	for n := 0; n < 35; n++ {
		id := uuid.NewString()
		if _, err := f.db.Pool.Exec(ctx, `INSERT INTO projects(id,name,repo_url) VALUES($1,$2,'https://github.com/owner/repo')`, id, fmt.Sprintf("Project %d", n)); err != nil {
			t.Fatal(err)
		}
		if _, err := f.db.Pool.Exec(ctx, `INSERT INTO project_ownership(project_id,team_id) VALUES($1,$2)`, id, f.team); err != nil {
			t.Fatal(err)
		}
		if _, err := f.db.Pool.Exec(ctx, `INSERT INTO project_github(project_id,enabled,sync_enabled,app_id,installation_id,repository_id,app_resource_id,team_grant_id,credential_version,access_state,next_poll_at) VALUES($1,true,true,91,20,30,$2,$3,1,'available',now()-interval '1 minute')`, id, f.app, f.grant); err != nil {
			t.Fatal(err)
		}
	}
	got, err := f.db.DueGitHubAppProjects(ctx, time.Now(), 32)
	if err != nil || len(got) != 32 || got[0] != f.project {
		t.Fatalf("bounded priority: %v %v", got, err)
	}
	if _, err := f.db.DueGitHubAppProjects(ctx, time.Now(), 33); err == nil {
		t.Fatal("limit accepted")
	}
	if _, err := f.db.DueGitHubAppProjects(ctx, time.Now(), 0); err == nil {
		t.Fatal("zero limit accepted")
	}
	if _, err := f.db.Pool.Exec(ctx, `UPDATE github_apps SET credential_version=2 WHERE id=$1`, f.app); err != nil {
		t.Fatal(err)
	}
	got, err = f.db.DueGitHubAppProjects(ctx, time.Now(), 32)
	if err != nil || len(got) != 0 {
		t.Fatalf("stale candidate: %v %v", got, err)
	}
	if _, err := f.db.Pool.Exec(ctx, `UPDATE project_github SET credential_version=2 WHERE app_resource_id=$1`, f.app); err != nil {
		t.Fatal(err)
	}
	got, err = f.db.DueGitHubAppProjects(ctx, time.Now(), 1)
	if err != nil || len(got) != 1 {
		t.Fatalf("new credentials: %v %v", got, err)
	}
	if _, err := f.db.Pool.Exec(ctx, `UPDATE github_app_team_grants SET revoked_at=now() WHERE id=$1`, f.grant); err != nil {
		t.Fatal(err)
	}
	got, err = f.db.DueGitHubAppProjects(ctx, time.Now(), 32)
	if err != nil || len(got) != 0 {
		t.Fatalf("revoked candidates: %v %v", got, err)
	}
}

func TestAppWorkOperationsPropagateCancellation(t *testing.T) {
	f := newAppWorkFixture(t)
	tx := begin(t, f.db, pgx.TxOptions{})
	w, lease, now := f.claimed(t, tx)
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	operations := []func() error{
		func() error { _, e := w.Connection(ctx); return e },
		func() error { _, e := w.ObservedAt(ctx); return e },
		func() error { _, e := w.Claim(ctx, store.GitHubClaim{}); return e },
		func() error { _, e := w.ValidLease(ctx, lease); return e },
		func() error { _, e := w.Renew(ctx, lease, now); return e },
		func() error { _, e := w.Publish(ctx, lease, nil); return e },
		func() error { _, e := w.PublishRepository(ctx, lease, store.GitHubRepositoryObservation{}); return e },
		func() error { _, _, e := w.UnseenActive(ctx, lease, uuid.NewString(), 0, 1); return e },
		func() error { _, _, e := w.Pending(ctx, lease, now, 1); return e },
		func() error { _, _, e := w.HasPending(ctx, lease); return e },
		func() error { _, e := w.HasDuePending(ctx, now); return e },
		func() error { _, e := w.AckPending(ctx, lease, 42, f.request); return e },
		func() error { _, e := w.ReschedulePending(ctx, lease, 42, f.request, now); return e },
		func() error { _, e := w.AckAccessHint(ctx, lease, f.hint); return e },
		func() error { _, e := w.SaveRuntime(ctx, lease, store.GitHubRuntimeWrite{}); return e },
	}
	for n, operation := range operations {
		if err := operation(); !errors.Is(err, context.Canceled) {
			t.Fatalf("operation %d lost cancellation: %v", n, err)
		}
	}
	if _, err := f.db.DueGitHubAppProjects(ctx, now, 32); !errors.Is(err, context.Canceled) {
		t.Fatalf("scan cancellation: %v", err)
	}
}

func TestAppWorkConstructorPreservesFailureMeaning(t *testing.T) {
	f := newAppWorkFixture(t)
	cases := []struct {
		name, sql   string
		args        []any
		unavailable bool
	}{
		{"Project deleted", `UPDATE projects SET deleted_at=now() WHERE id=$1`, []any{f.project}, true},
		{"ownership missing", `DELETE FROM project_ownership WHERE project_id=$1`, []any{f.project}, false},
		{"Team missing", `DELETE FROM teams WHERE id=$1`, []any{f.team}, false},
		{"disabled", `UPDATE project_github SET enabled=false WHERE project_id=$1`, []any{f.project}, true},
		{"App missing with live reference", `DELETE FROM github_apps WHERE id=$1`, []any{f.app}, false},
		{"App deleted with live reference", `UPDATE github_apps SET deleted_at=now() WHERE id=$1`, []any{f.app}, false},
		{"grant revoked", `UPDATE github_app_team_grants SET revoked_at=now() WHERE id=$1`, []any{f.grant}, true},
		{"credential changed", `UPDATE github_apps SET credential_version=2 WHERE id=$1`, []any{f.app}, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			tx := begin(t, f.db, pgx.TxOptions{})
			mustExec(t, tx, tc.sql, tc.args...)
			_, err := github.NewAppWorkWriter(t.Context(), tx, f.project, &f.identity)
			if err == nil || errors.Is(err, store.ErrGitHubAppWorkUnavailable) != tc.unavailable {
				t.Fatalf("failure kind: %v", err)
			}
		})
	}
	t.Run("changed expected identity", func(t *testing.T) {
		tx := begin(t, f.db, pgx.TxOptions{})
		old := f.identity
		old.CredentialVersion++
		if _, err := github.NewAppWorkWriter(t.Context(), tx, f.project, &old); !errors.Is(err, store.ErrGitHubAppWorkUnavailable) {
			t.Fatalf("old identity: %v", err)
		}
	})
	t.Run("cancelled", func(t *testing.T) {
		tx := begin(t, f.db, pgx.TxOptions{})
		ctx, cancel := context.WithCancel(t.Context())
		cancel()
		if _, err := github.NewAppWorkWriter(ctx, tx, f.project, nil); !errors.Is(err, context.Canceled) {
			t.Fatalf("cancellation: %v", err)
		}
	})
}
