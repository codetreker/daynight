package github_test

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/github"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func TestPullRequestStatisticsSegmentsAndSnapshot(t *testing.T) {
	db, project := dbFixture(t)
	ctx := t.Context()
	start := time.Date(2026, 3, 1, 0, 0, 0, 0, time.UTC)
	author := int64(9007199254740997)
	setup := begin(t, db, pgx.TxOptions{})
	insert := func(id string, number int, at time.Time, state string, authorID *int64, login *string, observed time.Time, revision int) {
		t.Helper()
		ensureLegacySource(t, setup, id)
		mustExec(t, setup, `INSERT INTO project_pull_requests
		 (project_id,repository_id,number,github_id,url,title,state,draft,base_ref,head_sha,github_created_at,github_updated_at,author_id,author_login,observed_at,revision)
		 VALUES ($1,30,$2,$2,'url','title',$3,$3='open','main','sha',$4,$4,$5,$6,$7,$8)`, id, number, state, at, authorID, login, observed, revision)
	}
	insert(project, 1, start.Add(-time.Millisecond), "open", &author, ptr("old"), start, 1)
	insert(project, 2, start, "open", &author, ptr("older"), start.Add(time.Hour), 1)
	insert(project, 3, start.Add(time.Hour), "merged", nil, nil, start, 1)
	insert(project, 4, start.Add(2*time.Hour), "closed", &author, ptr("renamed"), start.Add(time.Hour), 2)
	insert(project, 5, start.Add(3*time.Hour), "closed", nil, nil, start, 1)
	insert(project, 6, start.Add(4*time.Hour), "open", &author, ptr("winner"), start.Add(time.Hour), 2)
	insert(uuid.NewString(), 1, start, "open", &author, ptr("other project"), start.Add(5*time.Hour), 5)
	if err := setup.Commit(ctx); err != nil {
		t.Fatal(err)
	}

	tx := begin(t, db, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	r := github.NewReader(tx)
	q := store.GitHubPRStatisticsQuery{ProjectID: project, AuthorID: &author,
		Boundaries:  []time.Time{start, start.Add(time.Hour), start.Add(2 * time.Hour), start.Add(3 * time.Hour), start.Add(4 * time.Hour)},
		DateIndices: []int32{0, -1, 0, 2, -1}}
	read := func() store.GitHubPRStatistics {
		t.Helper()
		got, err := r.PullRequestStatistics(ctx, q)
		if err != nil {
			t.Fatal(err)
		}
		return got
	}
	check := func(got store.GitHubPRStatistics) {
		t.Helper()
		if got.Author == nil || got.Author.ID != author || got.Author.Login != "winner" {
			t.Fatalf("author: %+v", got.Author)
		}
		buckets := make(map[int32]store.GitHubPRStatisticsBucket)
		for _, b := range got.Buckets {
			k := int32(-1)
			if b.DateIndex != nil {
				k = *b.DateIndex
			}
			buckets[k] = b
		}
		want := map[int32]store.GitHubPRStatisticsBucket{
			-1: {Total: 3, AuthorTotal: 2, HasAuthors: true},
			0:  {DateIndex: ptr(int32(0)), Total: 2, AuthorTotal: 2, HasAuthors: true},
			2:  {DateIndex: ptr(int32(2)), Total: 1},
		}
		if !reflect.DeepEqual(buckets, want) {
			t.Fatalf("buckets: got %+v, want %+v", buckets, want)
		}
	}
	check(read())
	change := begin(t, db, pgx.TxOptions{})
	mustExec(t, change, `UPDATE project_pull_requests SET author_login='newer', observed_at=$3 WHERE project_id=$1 AND number=$2`, project, 1, start.Add(10*time.Hour))
	if err := change.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	check(read())
	fresh := begin(t, db, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	got, err := github.NewReader(fresh).PullRequestStatistics(ctx, q)
	if err != nil || got.Author == nil || got.Author.Login != "newer" {
		t.Fatalf("fresh snapshot: %+v, %v", got, err)
	}
	missing := int64(42)
	q.AuthorID = &missing
	got, err = github.NewReader(fresh).PullRequestStatistics(ctx, q)
	if err != nil || got.Author != nil {
		t.Fatalf("missing author: %+v, %v", got, err)
	}
	for _, b := range got.Buckets {
		if b.AuthorTotal != 0 {
			t.Fatalf("missing author bucket: %+v", b)
		}
	}
	q.ProjectID = uuid.NewString()
	got, err = github.NewReader(fresh).PullRequestStatistics(ctx, q)
	if err != nil || len(got.Buckets) != 0 || got.Author != nil {
		t.Fatalf("empty project: %+v, %v", got, err)
	}
}

func TestPullRequestStatisticsCancellationDuringLockWait(t *testing.T) {
	db, project := dbFixture(t)
	ctx := t.Context()
	blocker := begin(t, db, pgx.TxOptions{})
	mustExec(t, blocker, `LOCK TABLE project_pull_requests IN ACCESS EXCLUSIVE MODE`)
	reader := begin(t, db, pgx.TxOptions{AccessMode: pgx.ReadOnly})
	var pid int
	if err := reader.QueryRow(ctx, `SELECT pg_backend_pid()`).Scan(&pid); err != nil {
		t.Fatal(err)
	}
	operation, cancel := context.WithCancel(ctx)
	defer cancel()
	result := make(chan error, 1)
	go func() {
		start := time.Date(2026, 3, 1, 0, 0, 0, 0, time.UTC)
		_, err := github.NewReader(reader).PullRequestStatistics(operation, store.GitHubPRStatisticsQuery{ProjectID: project, Boundaries: []time.Time{start, start.Add(time.Hour)}, DateIndices: []int32{0, -1}})
		result <- err
	}()
	waitForLock(t, db, pid)
	cancel()
	select {
	case err := <-result:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("cancel: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("cancelled query did not exit")
	}
	_ = reader.Rollback(context.Background())
	if err := blocker.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	var count int64
	if err := db.Pool.QueryRow(ctx, `SELECT count(*) FROM project_pull_requests WHERE project_id=$1`, project).Scan(&count); err != nil || count != 0 {
		t.Fatalf("pool recovery: %d %v", count, err)
	}
}

func TestPullRequestStatisticsRejectsMissingSelectedAuthorLogin(t *testing.T) {
	db, project := dbFixture(t)
	ctx := t.Context()
	setup := begin(t, db, pgx.TxOptions{})
	start := time.Date(2026, 3, 1, 0, 0, 0, 0, time.UTC)
	ensureLegacySource(t, setup, project)
	mustExec(t, setup, `INSERT INTO project_pull_requests
	 (project_id,repository_id,number,github_id,url,title,state,draft,base_ref,head_sha,github_created_at,github_updated_at,author_id,observed_at,revision)
	 VALUES ($1,30,1,1,'url','title','open',false,'main','sha',$2,$2,42,$2,1)`, project, start)
	if err := setup.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	tx := begin(t, db, pgx.TxOptions{AccessMode: pgx.ReadOnly})
	author := int64(42)
	_, err := github.NewReader(tx).PullRequestStatistics(ctx, store.GitHubPRStatisticsQuery{
		ProjectID: project, AuthorID: &author, Boundaries: []time.Time{start, start.Add(time.Hour)}, DateIndices: []int32{0, -1},
	})
	if err == nil {
		t.Fatal("selected author with missing saved login was accepted")
	}
}

func TestStatisticsConnectionSourceInSnapshot(t *testing.T) {
	db, project := dbFixture(t)
	ctx := t.Context()
	setup := begin(t, db, pgx.TxOptions{})
	ensureLegacySource(t, setup, project)
	mustExec(t, setup, `UPDATE project_github SET repository_id=40 WHERE project_id=$1`, project)
	if err := setup.Commit(ctx); err != nil {
		t.Fatal(err)
	}

	tx := begin(t, db, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	reader := github.NewReader(tx)
	connection, err := reader.Connection(ctx, project)
	if err != nil || connection.LegacyRepositoryID == nil || *connection.LegacyRepositoryID != 30 || connection.RepositoryID == nil || *connection.RepositoryID != 40 {
		t.Fatalf("initial sources: %+v, %v", connection, err)
	}
	change := begin(t, db, pgx.TxOptions{})
	mustExec(t, change, `UPDATE project_github SET repository_id=30 WHERE project_id=$1`, project)
	if err := change.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	connection, err = reader.Connection(ctx, project)
	if err != nil || connection.LegacyRepositoryID == nil || *connection.LegacyRepositoryID != 30 || connection.RepositoryID == nil || *connection.RepositoryID != 40 {
		t.Fatalf("snapshot sources changed: %+v, %v", connection, err)
	}
	fresh := begin(t, db, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	connection, err = github.NewReader(fresh).Connection(ctx, project)
	if err != nil || connection.LegacyRepositoryID == nil || *connection.LegacyRepositoryID != 30 || connection.RepositoryID == nil || *connection.RepositoryID != 30 {
		t.Fatalf("fresh sources: %+v, %v", connection, err)
	}
}
