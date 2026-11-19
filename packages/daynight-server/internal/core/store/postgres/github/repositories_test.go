package github_test

import (
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/githubpr"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/github"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func TestRepositoryReadsKeepSourcesAndProjectsSeparate(t *testing.T) {
	db, project := dbFixture(t)
	ctx := t.Context()
	setup := begin(t, db, pgx.TxOptions{})
	other := uuid.NewString()
	source := int64(9007199254740993)
	ensureLegacySource(t, setup, project)
	mustExec(t, setup, `INSERT INTO project_github_repositories(project_id,repository_id,full_name) VALUES($1,$2,'new/repository'),($1,40,'empty/repository'),($3,99,'other/project')`, project, source, other)
	mustExec(t, setup, `UPDATE project_github SET repository_id=$2,repository_full_name='new/repository' WHERE project_id=$1`, project, source)
	insertPR(t, setup, project, 7, "open", "legacy", ptr("legacy body"))
	mustExec(t, setup, `UPDATE project_pull_requests SET author_id=1,author_login='legacy-author' WHERE project_id=$1`, project)
	mustExec(t, setup, `INSERT INTO project_pull_requests(project_id,repository_id,number,github_id,url,title,state,draft,base_ref,head_sha,github_created_at,github_updated_at,description,observed_at,revision,author_id,author_login)
 VALUES($1,$2,7,70,'new-url','new','merged',false,'main','sha','2026-03-01','2026-03-01','new body','2026-03-01',2,2,'new-author'),($1,$2,6,60,'another-url','another','closed',false,'main','sha','2026-03-01','2026-03-01',NULL,'2026-03-01',2,2,'new-author')`, project, source)
	if err := setup.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	tx := begin(t, db, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	reader := github.NewReader(tx)
	repositories, err := reader.Repositories(ctx, store.GitHubRepositoriesQuery{ProjectID: project, Limit: 1})
	if err != nil || !reflect.DeepEqual(repositories, []githubpr.Repository{{RepositoryID: 30, FullName: "owner/repo"}, {RepositoryID: 40, FullName: "empty/repository"}}) {
		t.Fatalf("directory first page: %+v %v", repositories, err)
	}
	repositories, err = reader.Repositories(ctx, store.GitHubRepositoriesQuery{ProjectID: project, Limit: 100, AfterRepositoryID: ptr(int64(40))})
	if err != nil || !reflect.DeepEqual(repositories, []githubpr.Repository{{RepositoryID: source, FullName: "new/repository"}}) {
		t.Fatalf("directory second page: %+v %v", repositories, err)
	}
	selected, err := reader.Repository(ctx, project, source)
	if err != nil || selected.RepositoryID != source || selected.FullName != "new/repository" {
		t.Fatalf("source: %+v %v", selected, err)
	}
	if _, err := reader.Repository(ctx, other, source); !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("cross-project source: %v", err)
	}
	empty, err := reader.Repositories(ctx, store.GitHubRepositoriesQuery{ProjectID: uuid.NewString(), Limit: 100})
	if err != nil || empty == nil || len(empty) != 0 {
		t.Fatalf("empty directory: %+v %v", empty, err)
	}
	legacy, err := reader.PullRequest(ctx, project, 7, nil)
	if err != nil || legacy.Title != "legacy" || legacy.RepositoryID != 30 {
		t.Fatalf("implicit detail: %+v %v", legacy, err)
	}
	current, err := reader.PullRequest(ctx, project, 7, &source)
	if err != nil || current.Title != "new" || current.RepositoryID != source || current.RepositoryFullName != "new/repository" || current.Description == nil || *current.Description != "new body" {
		t.Fatalf("explicit detail: %+v %v", current, err)
	}
	for _, test := range []struct {
		source                 *int64
		total                  int64
		author                 int64
		login                  string
		active, closed, merged int64
	}{{nil, 1, 1, "legacy-author", 1, 0, 0}, {&source, 2, 2, "new-author", 0, 1, 1}} {
		page, err := reader.PullRequests(ctx, store.GitHubPRQuery{ProjectID: project, RepositoryID: test.source, State: "all", Limit: 100})
		if err != nil || page.Total != test.total || int64(len(page.Items)) != test.total {
			t.Fatalf("list: %+v %v", page, err)
		}
		counts, err := reader.PullRequestCounts(ctx, store.GitHubPRCountsQuery{ProjectID: project, RepositoryID: test.source})
		if err != nil || counts != (store.GitHubPRCounts{Active: test.active, Closed: test.closed, Merged: test.merged, All: test.total, ProjectTotal: test.total}) {
			t.Fatalf("counts: %+v %v", counts, err)
		}
		authors, err := reader.Authors(ctx, store.GitHubAuthorQuery{ProjectID: project, RepositoryID: test.source, Limit: 100})
		if err != nil || len(authors.Items) != 1 || authors.Items[0].ID != test.author || authors.Items[0].Login != test.login {
			t.Fatalf("authors: %+v %v", authors, err)
		}
		start := time.Date(2026, 3, 1, 0, 0, 0, 0, time.UTC)
		statistics, err := reader.PullRequestStatistics(ctx, store.GitHubPRStatisticsQuery{ProjectID: project, RepositoryID: test.source, AuthorID: &test.author, Boundaries: []time.Time{start, start.Add(24 * time.Hour)}, DateIndices: []int32{0, -1}})
		var total int64
		for _, bucket := range statistics.Buckets {
			total += bucket.Total
		}
		if err != nil || total != test.total || statistics.Author == nil || statistics.Author.ID != test.author || statistics.Author.Login != test.login {
			t.Fatalf("statistics: %+v %v", statistics, err)
		}
	}
}
