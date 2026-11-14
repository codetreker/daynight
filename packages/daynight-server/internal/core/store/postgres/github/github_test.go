package github_test

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/githubpr"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/github"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

func dbFixture(t *testing.T) (*postgres.Store, string) {
	t.Helper()
	db, err := postgres.Open(t.Context(), testutil.ScopedDatabaseURL(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(db.Close)
	return db, uuid.NewString()
}
func begin(t *testing.T, db *postgres.Store, opts pgx.TxOptions) pgx.Tx {
	t.Helper()
	tx, err := db.Pool.BeginTx(t.Context(), opts)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = tx.Rollback(context.Background()) })
	return tx
}
func mustExec(t *testing.T, tx pgx.Tx, sql string, args ...any) {
	t.Helper()
	if _, err := tx.Exec(t.Context(), sql, args...); err != nil {
		t.Fatal(err)
	}
}
func ptr[T any](v T) *T { return &v }

func TestConfigurationDefaultsAndConditionalWrites(t *testing.T) {
	db, id := dbFixture(t)
	tx := begin(t, db, pgx.TxOptions{})
	ctx := t.Context()
	reader, writer := github.NewReader(tx), github.NewWriter(tx, id)
	virtual, err := reader.Connection(ctx, id)
	if err != nil || !reflect.DeepEqual(virtual, githubpr.DefaultConnection(id)) {
		t.Fatalf("virtual: %+v, %v", virtual, err)
	}
	if got, err := writer.Connection(ctx); err != nil || !reflect.DeepEqual(got, virtual) {
		t.Fatalf("write-scope virtual resource: %+v, %v", got, err)
	}
	clock, err := writer.ObservedAt(ctx)
	if err != nil || clock.Before(time.Now().Add(-time.Minute)) || clock.After(time.Now().Add(time.Minute)) {
		t.Fatalf("database clock: %v, %v", clock, err)
	}
	var rows int
	if err = tx.QueryRow(ctx, `SELECT count(*) FROM project_github WHERE project_id=$1`, id).Scan(&rows); err != nil || rows != 0 {
		t.Fatalf("read wrote a row: %d %v", rows, err)
	}
	now := time.Now().UTC().Truncate(time.Microsecond)
	write := store.GitHubConfigurationWrite{ExpectedVersion: 1, Version: 2, Generation: 1, Revision: 1, Enabled: true, SyncEnabled: true,
		AppID: ptr(int64(123)), InstallationID: ptr(int64(456)), RepositoryID: ptr(int64(789)), InstallationAccountLogin: ptr("owner"), RepositoryFullName: ptr("owner/repo"), RepositoryPrivate: ptr(true), PollIntervalMinutes: 17, AccessState: "available", AccessCheckedAt: &now, NextPollAt: &now}
	if ok, err := writer.SaveConfiguration(ctx, write); err != nil || !ok {
		t.Fatalf("create: %v %v", ok, err)
	}
	if ok, err := writer.SaveConfiguration(ctx, write); err != nil || ok {
		t.Fatalf("stale create: %v %v", ok, err)
	}
	got, err := writer.Connection(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if got.Version != 2 || got.Generation != 1 || got.Revision != 1 || !got.Enabled || !got.SyncEnabled || *got.AppID != 123 || *got.InstallationID != 456 || *got.RepositoryID != 789 || *got.InstallationAccountLogin != "owner" || *got.RepositoryFullName != "owner/repo" || !*got.RepositoryPrivate || got.PollIntervalMinutes != 17 || got.AccessState != "available" || !got.AccessCheckedAt.Equal(now) || !got.NextPollAt.Equal(now) || got.CreatedAt == nil || got.UpdatedAt == nil || got.ClaimToken != nil {
		t.Fatalf("stored configuration: %+v", got)
	}
	mustExec(t, tx, `UPDATE project_github SET poll_error_code='retained', last_webhook_success_at=$2, not_before=$2 WHERE project_id=$1`, id, now)
	write.ExpectedVersion, write.Version, write.PollIntervalMinutes = 2, 3, 20
	if ok, err := writer.SaveConfiguration(ctx, write); err != nil || !ok {
		t.Fatalf("update: %v %v", ok, err)
	}
	if ok, err := writer.SaveConfiguration(ctx, write); err != nil || ok {
		t.Fatalf("stale update: %v %v", ok, err)
	}
	got, err = reader.Connection(ctx, id)
	if err != nil || got.Version != 3 || got.PollIntervalMinutes != 20 || got.PollErrorCode == nil || *got.PollErrorCode != "retained" || got.LastWebhookSuccessAt == nil || !got.LastWebhookSuccessAt.Equal(now) || got.NotBefore == nil || !got.NotBefore.Equal(now) {
		t.Fatalf("updated configuration: %+v, %v", got, err)
	}
	write.ExpectedVersion, write.Version, write.Generation = 3, 4, 2
	if ok, err := writer.SaveConfiguration(ctx, write); err != nil || !ok {
		t.Fatalf("new generation: %v %v", ok, err)
	}
	got, err = reader.Connection(ctx, id)
	if err != nil || got.NotBefore == nil || !got.NotBefore.Equal(now) || got.PollErrorCode == nil || got.LastWebhookSuccessAt == nil {
		t.Fatalf("new generation retained facts: %+v, %v", got, err)
	}
	if err = tx.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	again := begin(t, db, pgx.TxOptions{})
	got, err = github.NewReader(again).Connection(ctx, id)
	if err != nil || !reflect.DeepEqual(got, githubpr.DefaultConnection(id)) {
		t.Fatalf("rollback: %+v %v", got, err)
	}
}

func insertPR(t *testing.T, tx pgx.Tx, id string, n int, state, title string, body *string) {
	t.Helper()
	mustExec(t, tx, `INSERT INTO project_pull_requests (project_id,number,github_id,url,title,state,draft,base_ref,head_sha,github_created_at,github_updated_at,description,observed_at,revision) VALUES ($1,$2,$2,$3,$4,$5,false,'main','abcdef',now(),now(),$6,now(),1)`, id, n, fmt.Sprintf("https://example.test/%d", n), title, state, body)
}
func numbers(items []githubpr.PullRequestSummary) []int64 {
	out := make([]int64, 0, len(items))
	for _, p := range items {
		out = append(out, p.Number)
	}
	return out
}

func waitForLock(t *testing.T, db *postgres.Store, pid int) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		var waiting bool
		if err := db.Pool.QueryRow(t.Context(), `SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND wait_event_type='Lock')`, pid).Scan(&waiting); err != nil {
			t.Fatal(err)
		}
		if waiting {
			return
		}
		if time.Now().After(deadline) {
			t.Fatal("write did not reach the PostgreSQL lock wait")
		}
		time.Sleep(10 * time.Millisecond)
	}
}
func TestPullRequestReadsPagingAndSnapshot(t *testing.T) {
	db, id := dbFixture(t)
	ctx := t.Context()
	setup := begin(t, db, pgx.TxOptions{})
	body := "  中文\n%_\\ markdown\n"
	empty := ""
	insertPR(t, setup, id, 9, "open", `Percent % and underscore _ backslash \`, &body)
	insertPR(t, setup, id, 8, "open", "number eight", &empty)
	insertPR(t, setup, id, 7, "open", "seven", nil)
	insertPR(t, setup, id, 6, "closed", "closed", nil)
	insertPR(t, setup, id, 5, "merged", "merged", nil)
	other := uuid.NewString()
	insertPR(t, setup, other, 50, "open", "other", nil)
	mustExec(t, setup, `SAVEPOINT unique_pr`)
	_, duplicateErr := setup.Exec(ctx, `INSERT INTO project_pull_requests (project_id,number,github_id,url,title,state,draft,base_ref,head_sha,github_created_at,github_updated_at,observed_at,revision) VALUES ($1,9,99,'url','duplicate','open',false,'main','sha',now(),now(),now(),1)`, id)
	var pgErr *pgconn.PgError
	if !errors.As(duplicateErr, &pgErr) || pgErr.Code != "23505" {
		t.Fatalf("same Project and PR number: %v", duplicateErr)
	}
	mustExec(t, setup, `ROLLBACK TO SAVEPOINT unique_pr`)
	insertPR(t, setup, other, 9, "open", "same number in another project", nil)
	if err := setup.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	tx := begin(t, db, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	r := github.NewReader(tx)
	detail, err := r.PullRequest(ctx, id, 9)
	if err != nil || detail.Description == nil || *detail.Description != body || detail.AuthorID != nil || detail.AuthorLogin != nil || detail.HeadRepositoryID != nil || detail.HeadRepositoryFullName != nil || detail.HeadRef != nil {
		t.Fatalf("detail: %+v %v", detail, err)
	}
	emptyDetail, err := r.PullRequest(ctx, id, 8)
	if err != nil || emptyDetail.Description == nil || *emptyDetail.Description != "" {
		t.Fatalf("empty: %+v %v", emptyDetail, err)
	}
	nullDetail, err := r.PullRequest(ctx, id, 7)
	if err != nil || nullDetail.Description != nil {
		t.Fatalf("null: %+v %v", nullDetail, err)
	}
	if _, err = r.PullRequest(ctx, other, 8); !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("missing: %v", err)
	}
	counts, err := r.PullRequestCounts(ctx, id)
	if err != nil || counts != (store.GitHubPRCounts{Active: 3, Closed: 1, Merged: 1, All: 5}) {
		t.Fatalf("counts: %+v %v", counts, err)
	}
	q := store.GitHubPRQuery{ProjectID: id, State: "active", Limit: 2}
	first, err := r.PullRequests(ctx, q)
	if err != nil || !reflect.DeepEqual(numbers(first.Items), []int64{9, 8}) || first.Total != 3 || !first.HasMore || first.UpperNumber == nil || *first.UpperNumber != 9 {
		t.Fatalf("first: %+v %v", first, err)
	}
	q.UpperNumber, q.AnchorNumber = first.UpperNumber, ptr(int64(8))
	second, err := r.PullRequests(ctx, q)
	if err != nil || !reflect.DeepEqual(numbers(second.Items), []int64{7}) || second.HasMore {
		t.Fatalf("second: %+v %v", second, err)
	}
	q.Previous, q.AnchorNumber = true, ptr(int64(7))
	previous, err := r.PullRequests(ctx, q)
	if err != nil || !reflect.DeepEqual(numbers(previous.Items), []int64{9, 8}) {
		t.Fatalf("previous: %+v %v", previous, err)
	}
	for _, test := range []struct {
		q    string
		want []int64
	}{{"%", []int64{9}}, {"_", []int64{9}}, {"\\", []int64{9}}, {"#8", []int64{8}}, {"PERCENT", []int64{9}}, {"' OR true --", []int64{}}} {
		page, err := r.PullRequests(ctx, store.GitHubPRQuery{ProjectID: id, State: "all", Query: test.q, Limit: 10})
		if err != nil || !reflect.DeepEqual(numbers(page.Items), test.want) || page.Total != int64(len(test.want)) {
			t.Fatalf("search %q: %+v %v", test.q, page, err)
		}
	}
	newtx := begin(t, db, pgx.TxOptions{})
	insertPR(t, newtx, id, 10, "open", "new", nil)
	if err = newtx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	counts, err = r.PullRequestCounts(ctx, id)
	if err != nil || counts.Active != 3 {
		t.Fatalf("snapshot count changed: %+v %v", counts, err)
	}
	q.Previous, q.AnchorNumber = false, ptr(int64(8))
	page, err := r.PullRequests(ctx, q)
	if err != nil || page.Total != 3 || !reflect.DeepEqual(numbers(page.Items), []int64{7}) {
		t.Fatalf("snapshot page changed: %+v %v", page, err)
	}
	fresh := begin(t, db, pgx.TxOptions{AccessMode: pgx.ReadOnly})
	q.AnchorNumber = nil
	q.Limit = 10
	page, err = github.NewReader(fresh).PullRequests(ctx, q)
	if err != nil || !reflect.DeepEqual(numbers(page.Items), []int64{9, 8, 7}) || page.Total != 4 {
		t.Fatalf("upper bound: %+v %v", page, err)
	}
	cancel, cancelFn := context.WithCancel(ctx)
	cancelFn()
	if _, err = github.NewReader(fresh).PullRequestCounts(cancel, id); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancel: %v", err)
	}
}

func TestConfigurationCancellationDuringLockWait(t *testing.T) {
	db, id := dbFixture(t)
	ctx := t.Context()
	setup := begin(t, db, pgx.TxOptions{})
	mustExec(t, setup, `INSERT INTO project_github(project_id,version) VALUES ($1,2)`, id)
	if err := setup.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	blocker := begin(t, db, pgx.TxOptions{})
	mustExec(t, blocker, `UPDATE project_github SET version=version WHERE project_id=$1`, id)
	waiter := begin(t, db, pgx.TxOptions{})
	var pid int
	if err := waiter.QueryRow(ctx, `SELECT pg_backend_pid()`).Scan(&pid); err != nil {
		t.Fatal(err)
	}
	operationCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	result := make(chan error, 1)
	go func() {
		_, err := github.NewWriter(waiter, id).Connection(operationCtx)
		result <- err
	}()
	waitForLock(t, db, pid)
	cancel()
	select {
	case err := <-result:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("lock wait cancellation: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("cancelled write did not exit")
	}
	_ = waiter.Rollback(context.Background())
	if err := blocker.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	var version int64
	if err := db.Pool.QueryRow(ctx, `SELECT version FROM project_github WHERE project_id=$1`, id).Scan(&version); err != nil || version != 2 {
		t.Fatalf("pool recovery or cancelled write: version=%d, error=%v", version, err)
	}
	clockTx := begin(t, db, pgx.TxOptions{})
	cancelled, cancelClock := context.WithCancel(ctx)
	cancelClock()
	if _, err := github.NewWriter(clockTx, id).ObservedAt(cancelled); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled database clock: %v", err)
	}
}

func TestManagementReadSerializesBroadcast(t *testing.T) {
	db, id := dbFixture(t)
	ctx := t.Context()
	setup := begin(t, db, pgx.TxOptions{})
	mustExec(t, setup, `INSERT INTO project_github(project_id,version,revision,enabled) VALUES ($1,2,4,true)`, id)
	if err := setup.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	management := begin(t, db, pgx.TxOptions{})
	writer := github.NewWriter(management, id)
	before, err := writer.Connection(ctx)
	if err != nil || before.Revision != 4 {
		t.Fatalf("management read: %+v %v", before, err)
	}
	broadcast := begin(t, db, pgx.TxOptions{})
	var pid int
	if err := broadcast.QueryRow(ctx, `SELECT pg_backend_pid()`).Scan(&pid); err != nil {
		t.Fatal(err)
	}
	result := make(chan error, 1)
	go func() {
		_, err := broadcast.Exec(ctx, `UPDATE project_github SET revision=revision+1, next_access_check_at=statement_timestamp() WHERE project_id=$1 AND enabled`, id)
		result <- err
	}()
	waitForLock(t, db, pid)
	ok, err := writer.SaveConfiguration(ctx, store.GitHubConfigurationWrite{ExpectedVersion: before.Version, Version: 3, Revision: before.Revision + 1, Enabled: true, PollIntervalMinutes: 5, AccessState: "unknown"})
	if err != nil || !ok {
		t.Fatalf("management write: %v %v", ok, err)
	}
	if err := management.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-result:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("broadcast did not resume after management commit")
	}
	if err := broadcast.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	read := begin(t, db, pgx.TxOptions{AccessMode: pgx.ReadOnly})
	after, err := github.NewReader(read).Connection(ctx, id)
	if err != nil || after.Version != 3 || after.Revision != 6 || after.NextAccessCheckAt == nil {
		t.Fatalf("serialized results: %+v %v", after, err)
	}
}

func TestPullRequestKeysetTraversalAcrossSnapshots(t *testing.T) {
	db, id := dbFixture(t)
	ctx := t.Context()
	setup := begin(t, db, pgx.TxOptions{})
	for n := 1; n <= 12; n++ {
		state := "closed"
		if n%2 == 0 {
			state = "open"
		}
		insertPR(t, setup, id, n, state, fmt.Sprintf("PR %d", n), nil)
	}
	if err := setup.Commit(ctx); err != nil {
		t.Fatal(err)
	}

	// Each page is read in its own snapshot, as it is for separate API calls.
	read := func(q store.GitHubPRQuery) store.GitHubPRPage {
		t.Helper()
		tx := begin(t, db, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
		page, err := github.NewReader(tx).PullRequests(ctx, q)
		if err != nil {
			t.Fatal(err)
		}
		if err := tx.Commit(ctx); err != nil {
			t.Fatal(err)
		}
		return page
	}
	q := store.GitHubPRQuery{ProjectID: id, State: "active", Limit: 2}
	first := read(q)
	if !reflect.DeepEqual(numbers(first.Items), []int64{12, 10}) || first.Total != 6 || !first.HasMore || first.UpperNumber == nil || *first.UpperNumber != 12 {
		t.Fatalf("first page: %+v", first)
	}
	newer := begin(t, db, pgx.TxOptions{})
	insertPR(t, newer, id, 13, "open", "newly observed", nil)
	if err := newer.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	q.UpperNumber, q.AnchorNumber = first.UpperNumber, ptr(int64(10))
	second := read(q)
	if !reflect.DeepEqual(numbers(second.Items), []int64{8, 6}) || second.Total != 7 || !second.HasMore {
		t.Fatalf("second page: %+v", second)
	}
	q.AnchorNumber = ptr(int64(6))
	third := read(q)
	if !reflect.DeepEqual(numbers(third.Items), []int64{4, 2}) || third.Total != 7 || third.HasMore {
		t.Fatalf("third page: %+v", third)
	}
	q.Previous, q.AnchorNumber = true, ptr(int64(4))
	back := read(q)
	if !reflect.DeepEqual(numbers(back.Items), []int64{8, 6}) || !back.HasMore {
		t.Fatalf("previous page: %+v", back)
	}
	q.AnchorNumber = ptr(int64(8))
	back = read(q)
	if !reflect.DeepEqual(numbers(back.Items), []int64{12, 10}) || back.HasMore {
		t.Fatalf("first page restored: %+v", back)
	}
	closed := read(store.GitHubPRQuery{ProjectID: id, State: "closed", Limit: 100})
	if !reflect.DeepEqual(numbers(closed.Items), []int64{11, 9, 7, 5, 3, 1}) || closed.Total != 6 || closed.HasMore {
		t.Fatalf("closed page: %+v", closed)
	}
}
