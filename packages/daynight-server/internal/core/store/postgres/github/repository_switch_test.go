package github_test

import (
	"errors"
	"math"
	"reflect"
	"testing"
	"time"

	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/github"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/githubpr"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/github"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func TestRepositorySwitchRetiresConnectionAndFencesWork(t *testing.T) {
	f := newAppWorkFixture(t)
	ctx := t.Context()
	start := time.Now().UTC().Truncate(time.Second).Add(-time.Hour)
	if _, err := f.db.Pool.Exec(ctx, `UPDATE project_github SET repository_full_name='owner/old',repository_default_branch='trunk',legacy_repository_id=30,poll_interval_minutes=17,claim_token=$2,claim_kind='poll',claim_until=now()+interval '1 hour',poll_error_code='failed',last_full_success_at=now() WHERE project_id=$1`, f.project, uuid.NewString()); err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.Pool.Exec(ctx, `INSERT INTO project_github_coverage(project_id,repository_id,started_at) VALUES($1,30,$2)`, f.project, start); err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.Pool.Exec(ctx, `INSERT INTO project_github_repositories(project_id,repository_id,full_name) VALUES($1,30,'owner/old')`, f.project); err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.Pool.Exec(ctx, `INSERT INTO project_pull_requests(project_id,repository_id,number,github_id,url,title,state,draft,base_ref,head_sha,github_created_at,github_updated_at,observed_at,revision)
		VALUES($1,30,7,70,'old-url','old','open',false,'main','sha',now(),now(),now(),1),($1,31,7,71,'new-url','new','open',false,'main','sha',now(),now(),now(),1)`, f.project); err != nil {
		t.Fatal(err)
	}
	tx := begin(t, f.db, pgx.TxOptions{})
	dao := github.NewRepositorySwitch(tx, f.project)
	if _, err := dao.SaveSwitch(ctx, store.GitHubRepositorySwitchWrite{}); err == nil {
		t.Fatal("unlocked switch succeeded")
	}
	app, err := dao.LockBinding(ctx)
	if err != nil || app == nil || *app != f.app {
		t.Fatalf("binding: %v %v", app, err)
	}
	target := &store.GitHubRepositoryTarget{RepositoryID: 31, FullName: "owner/new", Private: true}
	current, err := github.NewReader(tx).Connection(ctx, f.project)
	if err != nil {
		t.Fatal(err)
	}
	decision, err := core.RepositorySwitch(current, target)
	if err != nil {
		t.Fatal(err)
	}
	if ok, err := dao.SaveSwitch(ctx, decision); err != nil || !ok {
		t.Fatalf("save switch: %v %v", ok, err)
	}
	if err = dao.AdvanceImpact(ctx); err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	var clean bool
	err = f.db.Pool.QueryRow(ctx, `SELECT NOT enabled AND NOT sync_enabled AND version=3 AND generation=2 AND revision=8 AND app_resource_id IS NULL AND team_grant_id IS NULL AND credential_version IS NULL AND installation_id IS NULL AND repository_id=31 AND repository_full_name='owner/new' AND repository_private AND repository_default_branch IS NULL AND legacy_repository_id=30 AND poll_interval_minutes=17 AND claim_token IS NULL AND access_hint_id IS NULL AND next_poll_at IS NULL AND poll_error_code IS NULL AND last_full_success_at IS NULL AND (SELECT count(*) FROM project_github_pending_prs WHERE project_id=$1)=0 AND (SELECT impact_version FROM github_apps WHERE id=$2)=2 AND EXISTS(SELECT 1 FROM project_github_coverage WHERE project_id=$1 AND repository_id=30 AND ended_at IS NOT NULL) FROM project_github WHERE project_id=$1`, f.project, f.app).Scan(&clean)
	if err != nil || !clean {
		t.Fatalf("retired state=%v %v", clean, err)
	}
	readTx := begin(t, f.db, pgx.TxOptions{AccessMode: pgx.ReadOnly})
	reader := github.NewReader(readTx)
	sources, err := reader.Repositories(ctx, store.GitHubRepositoriesQuery{ProjectID: f.project, Limit: 100})
	if err != nil || !reflect.DeepEqual(sources, []githubpr.Repository{{RepositoryID: 30, FullName: "owner/old"}, {RepositoryID: 31, FullName: "owner/new"}}) {
		t.Fatalf("repository directory=%+v: %v", sources, err)
	}
	newID := int64(31)
	for _, tc := range []struct {
		id     *int64
		title  string
		source int64
	}{{nil, "old", 30}, {&newID, "new", 31}} {
		if _, err := reader.Repository(ctx, f.project, tc.source); err != nil {
			t.Fatalf("source %d: %v", tc.source, err)
		}
		pr, err := reader.PullRequest(ctx, f.project, 7, tc.id)
		if err != nil || pr.Title != tc.title || pr.RepositoryID != tc.source {
			t.Fatalf("source %d pull request=%+v: %v", tc.source, pr, err)
		}
	}
	completion, err := f.db.WriteGitHubAppWork(ctx, f.project, &f.identity, func(store.GitHubAppWorkDAO) error { t.Fatal("old binding accepted"); return nil })
	if err == nil && completion.Outcome == store.TransactionCommitted {
		t.Fatalf("old work accepted: %+v %v", completion, err)
	}
}

func TestRepositorySwitchUnboundAndAbsent(t *testing.T) {
	db, _ := dbFixture(t)
	ctx := t.Context()
	for _, existing := range []bool{false, true} {
		id := uuid.NewString()
		if existing {
			if _, err := db.Pool.Exec(ctx, `INSERT INTO project_github(project_id,version,generation,revision,repository_id,repository_full_name,claim_token,claim_until,claim_kind,poll_interval_minutes) VALUES($1,5,4,3,30,'owner/old',$2,now()+interval '1 hour','poll',19)`, id, uuid.NewString()); err != nil {
				t.Fatal(err)
			}
		}
		tx := begin(t, db, pgx.TxOptions{})
		dao := github.NewRepositorySwitch(tx, id)
		if _, err := dao.LockBinding(ctx); err != nil {
			t.Fatal(err)
		}
		current, err := github.NewReader(tx).Connection(ctx, id)
		if err != nil {
			t.Fatal(err)
		}
		decision, err := core.RepositorySwitch(current, nil)
		if err != nil {
			t.Fatal(err)
		}
		if ok, err := dao.SaveSwitch(ctx, decision); err != nil || !ok {
			t.Fatalf("save switch: %v %v", ok, err)
		}
		if err := dao.AdvanceImpact(ctx); err != nil {
			t.Fatal(err)
		}
		if err := tx.Commit(ctx); err != nil {
			t.Fatal(err)
		}
		var version, generation, revision int64
		var repository, claim *string
		var interval int32
		if err := db.Pool.QueryRow(ctx, `SELECT version,generation,revision,repository_id::text,claim_token::text,poll_interval_minutes FROM project_github WHERE project_id=$1`, id).Scan(&version, &generation, &revision, &repository, &claim, &interval); err != nil {
			t.Fatal(err)
		}
		if repository != nil || claim != nil || (!existing && (version != 2 || generation != 1 || revision != 1 || interval != 5)) || (existing && (version != 6 || generation != 5 || revision != 4 || interval != 19)) {
			t.Fatalf("existing=%v version=%d generation=%d revision=%d repo=%v claim=%v interval=%d", existing, version, generation, revision, repository, claim, interval)
		}
	}
}

func TestRepositorySwitchExhaustedUnboundRollsBack(t *testing.T) {
	db, id := dbFixture(t)
	ctx := t.Context()
	if _, err := db.Pool.Exec(ctx, `INSERT INTO project_github(project_id,version,repository_id) VALUES($1,$2,30)`, id, int64(math.MaxInt64)); err != nil {
		t.Fatal(err)
	}
	tx := begin(t, db, pgx.TxOptions{})
	dao := github.NewRepositorySwitch(tx, id)
	if _, err := dao.LockBinding(ctx); err != nil {
		t.Fatal(err)
	}
	current, err := github.NewReader(tx).Connection(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	_, err = core.RepositorySwitch(current, nil)
	var fault *model.Fault
	if !errors.As(err, &fault) || fault.Code != "version_exhausted" {
		t.Fatalf("exhaustion: %v", err)
	}
	if err := tx.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	var repo int64
	if err := db.Pool.QueryRow(ctx, `SELECT repository_id FROM project_github WHERE project_id=$1`, id).Scan(&repo); err != nil || repo != 30 {
		t.Fatalf("rollback: %d %v", repo, err)
	}
}

func TestRepositorySwitchSourceFailureRollsBackConnection(t *testing.T) {
	f := newAppWorkFixture(t)
	ctx := t.Context()
	if _, err := f.db.Pool.Exec(ctx, `ALTER TABLE project_github_repositories ADD CONSTRAINT test_reject_source CHECK (repository_id <> 31)`); err != nil {
		t.Fatal(err)
	}
	tx := begin(t, f.db, pgx.TxOptions{})
	dao := github.NewRepositorySwitch(tx, f.project)
	if _, err := dao.LockBinding(ctx); err != nil {
		t.Fatal(err)
	}
	current, err := github.NewReader(tx).Connection(ctx, f.project)
	if err != nil {
		t.Fatal(err)
	}
	decision, err := core.RepositorySwitch(current, &store.GitHubRepositoryTarget{RepositoryID: 31, FullName: "owner/new"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := dao.SaveSwitch(ctx, decision); err == nil {
		t.Fatal("source write failure was not propagated")
	}
	if err := tx.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	var intact bool
	err = f.db.Pool.QueryRow(ctx, `SELECT enabled AND sync_enabled AND repository_id=30 AND version=2 AND generation=1 AND revision=7 AND app_resource_id=$2 AND EXISTS(SELECT 1 FROM project_github_pending_prs WHERE project_id=$1) AND NOT EXISTS(SELECT 1 FROM project_github_repositories WHERE project_id=$1 AND repository_id=31) FROM project_github WHERE project_id=$1`, f.project, f.app).Scan(&intact)
	if err != nil || !intact {
		t.Fatalf("rolled back source failure: intact=%v err=%v", intact, err)
	}
}

func TestRepositorySwitchManualReconnectAndCoverage(t *testing.T) {
	f := newProjectAppFixture(t)
	ctx := t.Context()
	if _, _, err := f.write(ctx, "connect", 1, nil); err != nil {
		t.Fatal(err)
	}
	if _, _, err := f.write(ctx, "sync", 2, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.Pool.Exec(ctx, `UPDATE project_github_coverage SET started_at=date_trunc('second',now())-interval '1 hour' WHERE project_id=$1 AND repository_id=8`, f.project); err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.Pool.Exec(ctx, `INSERT INTO project_pull_requests(project_id,repository_id,number,github_id,url,title,state,draft,base_ref,head_sha,github_created_at,github_updated_at,observed_at,revision) VALUES($1,8,7,70,'old-url','old','open',false,'main','sha',now(),now(),now(),1)`, f.project); err != nil {
		t.Fatal(err)
	}

	tx := begin(t, f.db, pgx.TxOptions{})
	if _, err := tx.Exec(ctx, `SELECT id FROM projects WHERE id=$1 FOR UPDATE`, f.project); err != nil {
		t.Fatal(err)
	}
	dao := github.NewRepositorySwitch(tx, f.project)
	if _, err := dao.LockBinding(ctx); err != nil {
		t.Fatal(err)
	}
	current, err := github.NewReader(tx).Connection(ctx, f.project)
	if err != nil {
		t.Fatal(err)
	}
	decision, err := core.RepositorySwitch(current, &store.GitHubRepositoryTarget{RepositoryID: 9, FullName: "o/new"})
	if err != nil {
		t.Fatal(err)
	}
	if ok, err := dao.SaveSwitch(ctx, decision); err != nil || !ok {
		t.Fatalf("switch: %v %v", ok, err)
	}
	if err := dao.AdvanceImpact(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `UPDATE projects SET repo_url='https://github.com/o/new',repository_version=2 WHERE id=$1`, f.project); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}

	in := core.ProjectAppConnect{ProjectAppSelection: core.ProjectAppSelection{AppResourceID: f.app, GrantID: f.grant, AppVersion: 1, OwnershipVersion: 1}, Version: 4, InstallationID: 7, RepositoryVersion: 2}
	proof := core.InstallationCandidate{Installation: githubpr.InstallationObservation{ID: 7, AccountLogin: "o"}, Repository: githubpr.RepositoryObservation{ID: 9, FullName: "o/new"}}
	var connected core.ProjectAppStatus
	c, err := f.db.WriteGitHubProjectApp(ctx, f.project, f.p.UserID, f.app, func(d store.GitHubProjectAppWriteDAO) error {
		var e error
		connected, e = core.ManageProjectApp(ctx, d, f.p, "connect", in, 0, false, "https://github.com/o/new", proof)
		return e
	})
	if err != nil || c.Outcome != store.TransactionCommitted || !connected.Connection.Enabled || connected.Connection.SyncEnabled || connected.Connection.RepositoryID == nil || *connected.Connection.RepositoryID != 9 {
		t.Fatalf("reconnect=%+v completion=%+v err=%v", connected, c, err)
	}
	var oldClosed, newCount int
	if err := f.db.Pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM project_github_coverage WHERE project_id=$1 AND repository_id=8 AND ended_at IS NOT NULL),(SELECT count(*) FROM project_github_coverage WHERE project_id=$1 AND repository_id=9)`, f.project).Scan(&oldClosed, &newCount); err != nil || oldClosed != 1 || newCount != 0 {
		t.Fatalf("coverage after connect: old=%d new=%d err=%v", oldClosed, newCount, err)
	}
	c, err = f.db.WriteGitHubProjectApp(ctx, f.project, f.p.UserID, "", func(d store.GitHubProjectAppWriteDAO) error {
		_, e := core.ManageProjectApp(ctx, d, f.p, "sync", core.ProjectAppConnect{Version: 5}, 0, true, "", core.InstallationCandidate{})
		return e
	})
	if err != nil || c.Outcome != store.TransactionCommitted {
		t.Fatalf("enable sync: %+v %v", c, err)
	}
	if err := f.db.Pool.QueryRow(ctx, `SELECT count(*) FROM project_github_coverage WHERE project_id=$1 AND repository_id=9 AND ended_at IS NULL`, f.project).Scan(&newCount); err != nil || newCount != 1 {
		t.Fatalf("new coverage: %d %v", newCount, err)
	}
	if _, err := f.db.Pool.Exec(ctx, `INSERT INTO project_pull_requests(project_id,repository_id,number,github_id,url,title,state,draft,base_ref,head_sha,github_created_at,github_updated_at,observed_at,revision) VALUES($1,9,7,71,'new-url','new','open',false,'main','sha',now(),now(),now(),1)`, f.project); err != nil {
		t.Fatal(err)
	}
	read := github.NewReader(begin(t, f.db, pgx.TxOptions{AccessMode: pgx.ReadOnly}))
	newID := int64(9)
	for _, tc := range []struct {
		id     *int64
		title  string
		source int64
	}{{nil, "old", 8}, {&newID, "new", 9}} {
		pr, err := read.PullRequest(ctx, f.project, 7, tc.id)
		if err != nil || pr.Title != tc.title || pr.RepositoryID != tc.source {
			t.Fatalf("PR source %d: %+v %v", tc.source, pr, err)
		}
	}
}
