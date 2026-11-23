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

func TestPullRequestVisibilityUsesSameSourceAndSnapshot(t *testing.T) {
	db, project := dbFixture(t)
	ctx := t.Context()
	setup := begin(t, db, pgx.TxOptions{})
	insertPR(t, setup, project, 7, "open", "legacy", nil)
	mustExec(t, setup, `INSERT INTO project_github_repositories(project_id,repository_id,full_name) VALUES($1,40,'other/repo')`, project)
	mustExec(t, setup, `INSERT INTO project_pull_requests(project_id,repository_id,number,github_id,url,title,state,draft,base_ref,head_sha,github_created_at,github_updated_at,observed_at,revision) VALUES($1,40,8,80,'url','title','open',false,'main','sha',now(),now(),now(),1)`, project)
	if err := setup.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	tx := begin(t, db, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	reader := github.NewReader(tx)
	visibility, ok := reader.(store.GitHubPullRequestVisibilityReader)
	if !ok {
		t.Fatal("visibility capability missing")
	}
	source := int64(40)
	if err := visibility.RequireRepositoryVisible(ctx, project, source); err != nil {
		t.Fatal(err)
	}
	if err := visibility.RequireRepositoryVisible(ctx, project, 99); !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("missing repository: %v", err)
	}
	for _, tc := range []struct {
		project string
		number  int64
		source  *int64
		visible bool
	}{
		{project, 7, nil, true}, {project, 8, nil, false}, {project, 8, &source, true}, {project, 7, &source, false}, {uuid.NewString(), 7, nil, false},
	} {
		err := visibility.RequirePullRequestVisible(ctx, tc.project, tc.number, tc.source)
		if tc.visible && err != nil || !tc.visible && !errors.Is(err, model.ErrNotFound) {
			t.Fatalf("visibility %+v: %v", tc, err)
		}
	}
	writer := begin(t, db, pgx.TxOptions{})
	mustExec(t, writer, `DELETE FROM project_pull_requests WHERE project_id=$1 AND repository_id=30 AND number=7`, project)
	if err := writer.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if err := visibility.RequirePullRequestVisible(ctx, project, 7, nil); err != nil {
		t.Fatalf("snapshot visibility: %v", err)
	}
	if _, err := reader.PullRequest(ctx, project, 7, nil); err != nil {
		t.Fatalf("snapshot projection: %v", err)
	}
}
