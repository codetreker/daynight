package github_test

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/githubpr"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/github"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func TestAuthorsCanonicalSearchAndPagination(t *testing.T) {
	db, project := dbFixture(t)
	ctx := t.Context()
	setup := begin(t, db, pgx.TxOptions{})
	observed := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	insert := func(project string, number int, state string, id *int64, login *string, at time.Time, revision int64) {
		t.Helper()
		ensureLegacySource(t, setup, project)
		mustExec(t, setup, `INSERT INTO project_pull_requests
		 (project_id,repository_id,number,github_id,url,title,state,draft,base_ref,head_sha,github_created_at,github_updated_at,author_id,author_login,observed_at,revision)
		 VALUES ($1,30,$2,$2,'url','title',$3,false,'main','sha',$4,$4,$5,$6,$4,$7)`, project, number, state, at, id, login, revision)
	}
	// An older alias must not match, even though its PR number and revision are higher.
	insert(project, 50, "open", ptr(int64(1)), ptr("OldAlias"), observed, 20)
	insert(project, 1, "closed", ptr(int64(1)), ptr("renamed"), observed.Add(time.Second), 1)
	// Ties use revision first and then number.
	insert(project, 2, "open", ptr(int64(2)), ptr("not-revision"), observed, 1)
	insert(project, 3, "merged", ptr(int64(2)), ptr("not-number"), observed, 2)
	insert(project, 4, "closed", ptr(int64(2)), ptr("Same"), observed, 2)
	insert(project, 5, "open", ptr(int64(3)), ptr("same"), observed, 1)
	insert(project, 6, "merged", ptr(int64(4)), ptr("bot[bot]"), observed, 1)
	insert(project, 7, "closed", ptr(int64(5)), ptr("Percent%_"), observed, 1)
	insert(project, 8, "open", nil, nil, observed, 1)
	insert(uuid.NewString(), 1, "open", ptr(int64(6)), ptr("outside"), observed, 1)
	if err := setup.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	tx := begin(t, db, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	r := github.NewReader(tx)
	query := store.GitHubAuthorQuery{ProjectID: project, Limit: 2}
	var got []githubpr.Author
	for {
		page, err := r.Authors(ctx, query)
		if err != nil {
			t.Fatal(err)
		}
		got = append(got, page.Items...)
		if !page.HasMore {
			break
		}
		if len(page.Items) != 2 {
			t.Fatalf("nonterminal page: %+v", page)
		}
		last := page.Items[len(page.Items)-1]
		query.AnchorNameKey, query.AnchorAuthorID = &last.NameKey, &last.ID
	}
	want := []githubpr.Author{
		{ID: 4, Login: "bot[bot]", NameKey: "bot[bot]"},
		{ID: 5, Login: "Percent%_", NameKey: "percent%_"},
		{ID: 1, Login: "renamed", NameKey: "renamed"},
		{ID: 2, Login: "Same", NameKey: "same", LoginAmbiguous: true},
		{ID: 3, Login: "same", NameKey: "same", LoginAmbiguous: true},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("traversal: got %+v, want %+v", got, want)
	}
	for _, test := range []struct {
		query string
		want  []githubpr.Author
	}{
		{"OLDALIAS", []githubpr.Author{}},
		{"not-revision", []githubpr.Author{}},
		{"not-number", []githubpr.Author{}},
		{"%_", want[1:2]},
		{"BOT", want[0:1]},
		{"sAmE", want[3:5]},
		{"outside", []githubpr.Author{}},
	} {
		page, err := r.Authors(ctx, store.GitHubAuthorQuery{ProjectID: project, Query: test.query, Limit: 100})
		if err != nil || page.HasMore || !reflect.DeepEqual(page.Items, test.want) {
			t.Errorf("search %q: %+v, %v; want %+v", test.query, page, err, test.want)
		}
	}
	// An invalid saved identity is not silently discarded by a search.
	invalid := begin(t, db, pgx.TxOptions{})
	ensureLegacySource(t, invalid, project)
	mustExec(t, invalid, `INSERT INTO project_pull_requests
	 (project_id,repository_id,number,github_id,url,title,state,draft,base_ref,head_sha,github_created_at,github_updated_at,author_id,observed_at,revision)
	 VALUES ($1,30,100,100,'url','title','open',false,'main','sha',$2,$2,100,$2,1)`, project, observed)
	if err := invalid.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if page, err := r.Authors(ctx, store.GitHubAuthorQuery{ProjectID: project, Limit: 100}); err != nil || !reflect.DeepEqual(page.Items, want) {
		t.Fatalf("repeatable-read snapshot changed: %+v, %v", page, err)
	}
	fresh := begin(t, db, pgx.TxOptions{AccessMode: pgx.ReadOnly})
	if _, err := github.NewReader(fresh).Authors(ctx, store.GitHubAuthorQuery{ProjectID: project, Query: "unmatched", Limit: 2}); err == nil {
		t.Fatal("missing login was silently filtered")
	}
	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	if _, err := r.Authors(cancelled, store.GitHubAuthorQuery{ProjectID: project, Limit: 2}); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancellation: %v", err)
	}
}
