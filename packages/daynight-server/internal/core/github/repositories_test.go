package github

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/githubpr"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func sourceFixture(ctx context.Context, repositoryID int64) *fixture {
	f := fixtureFor(ctx)
	f.repository = func(gotCtx context.Context, id string, source int64) (githubpr.Repository, error) {
		if gotCtx != ctx || id != projectID || source != repositoryID {
			panic("incorrect repository selection")
		}
		return githubpr.Repository{RepositoryID: source, FullName: "owner/source"}, nil
	}
	return f
}

func TestExplicitSourceReads(t *testing.T) {
	ctx := context.Background()
	source := int64(9007199254740993)
	f := sourceFixture(ctx, source)
	page, err := NewReader(f, true).List(ctx, principal, projectID, ListRequest{RepositoryID: &source, State: "all", Limit: 1})
	if err != nil || page.Repository == nil || page.Repository.RepositoryID != source || f.query.RepositoryID != &source || f.countsQuery.RepositoryID != &source {
		t.Fatalf("list=%+v query=%+v counts=%+v err=%v", page, f.query, f.countsQuery, err)
	}
	if !reflect.DeepEqual(f.trace, []string{"snapshot", "access", "connection", "repository", "counts", "list"}) {
		t.Fatal(f.trace)
	}
	f = sourceFixture(ctx, source)
	detail, err := NewReader(f, true).Detail(ctx, principal, projectID, 42, &source)
	if err != nil || detail.Repository == nil || detail.Repository.RepositoryID != source || f.detailRepositoryID != &source {
		t.Fatalf("detail=%+v err=%v", detail, err)
	}
	af := &authorsFixture{fixture: sourceFixture(ctx, source)}
	authors, err := NewReader(af, true).Authors(ctx, principal, projectID, AuthorsRequest{RepositoryID: &source, Limit: 1})
	if err != nil || authors.Repository == nil || authors.Repository.RepositoryID != source || af.query.RepositoryID != &source {
		t.Fatalf("authors=%+v query=%+v err=%v", authors, af.query, err)
	}
	sf := &statisticsFixture{fixture: sourceFixture(ctx, source), connection: githubpr.Connection{ProjectID: projectID}}
	req := validStatisticsRequest()
	req.RepositoryID = &source
	stats, err := NewReader(sf, true).Statistics(ctx, principal, projectID, req)
	if err != nil || stats.Repository == nil || stats.Repository.RepositoryID != source || sf.query.RepositoryID != &source {
		t.Fatalf("stats=%+v query=%+v err=%v", stats, sf.query, err)
	}
}

func TestSourceReadRefusals(t *testing.T) {
	ctx := context.Background()
	source := int64(42)
	cause := errors.New("source lookup failed")
	for _, operation := range []string{"list", "detail", "authors", "statistics"} {
		for _, lookupErr := range []error{model.ErrNotFound, cause} {
			t.Run(operation+lookupErr.Error(), func(t *testing.T) {
				f := fixtureFor(ctx)
				f.repository = func(context.Context, string, int64) (githubpr.Repository, error) {
					return githubpr.Repository{}, lookupErr
				}
				var err error
				switch operation {
				case "list":
					_, err = NewReader(f, true).List(ctx, principal, projectID, ListRequest{RepositoryID: &source, State: "all", Limit: 1})
				case "detail":
					_, err = NewReader(f, true).Detail(ctx, principal, projectID, 42, &source)
				case "authors":
					_, err = NewReader(&authorsFixture{fixture: f}, true).Authors(ctx, principal, projectID, AuthorsRequest{RepositoryID: &source, Limit: 1})
				case "statistics":
					req := validStatisticsRequest()
					req.RepositoryID = &source
					_, err = NewReader(&statisticsFixture{fixture: f}, true).Statistics(ctx, principal, projectID, req)
				}
				if !errors.Is(err, lookupErr) {
					t.Fatalf("lost cause: %v", err)
				}
				if lookupErr == model.ErrNotFound {
					faultCode(t, err, "not_found")
				}
				if !reflect.DeepEqual(f.trace, []string{"snapshot", "access", "connection", "repository"}) {
					t.Fatal(f.trace)
				}
			})
		}
	}
	f := fixtureFor(ctx)
	f.accessErr = &model.Fault{Code: "forbidden"}
	_, err := NewReader(f, true).List(ctx, principal, projectID, ListRequest{RepositoryID: &source, State: "all", Limit: 1})
	faultCode(t, err, "forbidden")
	if !reflect.DeepEqual(f.trace, []string{"snapshot", "access"}) {
		t.Fatal(f.trace)
	}
}

func TestRepositoryDirectorySnapshotAndPaging(t *testing.T) {
	ctx := context.Background()
	f := fixtureFor(ctx)
	f.repositories = func(gotCtx context.Context, q store.GitHubRepositoriesQuery) ([]githubpr.Repository, error) {
		if gotCtx != ctx || q.ProjectID != projectID || q.Limit != 1 || q.AfterRepositoryID != nil {
			t.Fatalf("query=%+v", q)
		}
		return []githubpr.Repository{{RepositoryID: 9007199254740993, FullName: "owner/old"}, {RepositoryID: 9007199254740994, FullName: "owner/current"}}, nil
	}
	page, err := NewReader(f, true).Repositories(ctx, principal, projectID, RepositoriesRequest{Limit: 1})
	if err != nil || len(page.Items) != 1 || page.Items[0].RepositoryID != 9007199254740993 || page.CurrentRepositoryID != nil || page.NextCursor == nil {
		t.Fatalf("page=%+v err=%v", page, err)
	}
	f.repositories = func(_ context.Context, q store.GitHubRepositoriesQuery) ([]githubpr.Repository, error) {
		if q.AfterRepositoryID == nil || *q.AfterRepositoryID != 9007199254740993 {
			t.Fatalf("query=%+v", q)
		}
		return nil, nil
	}
	last, err := NewReader(f, true).Repositories(ctx, principal, projectID, RepositoriesRequest{Limit: 1, Cursor: *page.NextCursor})
	if err != nil || last.Items == nil || len(last.Items) != 0 || last.NextCursor != nil {
		t.Fatalf("last=%+v err=%v", last, err)
	}
	for _, limit := range []int{0, 101} {
		_, err = NewReader(f, true).Repositories(ctx, principal, projectID, RepositoriesRequest{Limit: limit})
		faultCode(t, err, "invalid_input")
	}
	f = fixtureFor(ctx)
	f.accessErr = &model.Fault{Code: "forbidden"}
	_, err = NewReader(f, true).Repositories(ctx, principal, projectID, RepositoriesRequest{Limit: 1})
	faultCode(t, err, "forbidden")
	if !reflect.DeepEqual(f.trace, []string{"snapshot", "access"}) {
		t.Fatal(f.trace)
	}
}

func TestRepositoryDirectoryFailures(t *testing.T) {
	ctx := context.Background()
	cause := errors.New("directory failed")
	for _, setup := range []func(*fixture){
		func(f *fixture) { f.connectionErr = cause },
		func(f *fixture) {
			f.repositories = func(context.Context, store.GitHubRepositoriesQuery) ([]githubpr.Repository, error) { return nil, cause }
		},
		func(f *fixture) {
			f.completionErr = cause
			f.repositories = func(context.Context, store.GitHubRepositoriesQuery) ([]githubpr.Repository, error) { return nil, nil }
		},
	} {
		f := fixtureFor(ctx)
		setup(f)
		got, err := NewReader(f, true).Repositories(ctx, principal, projectID, RepositoriesRequest{Limit: 1})
		if !errors.Is(err, cause) || !reflect.DeepEqual(got, RepositoriesPage{}) {
			t.Fatalf("got=%+v err=%v", got, err)
		}
	}
	f := fixtureFor(ctx)
	if _, err := NewReader(f, true).Repositories(ctx, principal, "invalid", RepositoriesRequest{Limit: 1}); err == nil {
		t.Fatal("invalid project accepted")
	}
	_, err := NewReader(f, true).Repositories(ctx, principal, projectID, RepositoriesRequest{Limit: 1, Cursor: "invalid"})
	faultCode(t, err, "invalid_input")
	if len(f.trace) != 0 {
		t.Fatal(f.trace)
	}
	current := int64(9007199254740995)
	sf := &statisticsFixture{fixture: fixtureFor(ctx), connection: githubpr.Connection{RepositoryID: &current}}
	sf.repositories = func(context.Context, store.GitHubRepositoriesQuery) ([]githubpr.Repository, error) { return nil, nil }
	got, err := NewReader(sf, true).Repositories(ctx, principal, projectID, RepositoriesRequest{Limit: 100})
	if err != nil || got.CurrentRepositoryID == nil || *got.CurrentRepositoryID != current {
		t.Fatalf("got=%+v err=%v", got, err)
	}
}

func TestSourceIDValidation(t *testing.T) {
	ctx := context.Background()
	for _, source := range []int64{0, -1} {
		f := fixtureFor(ctx)
		_, err := NewReader(f, true).List(ctx, principal, projectID, ListRequest{RepositoryID: &source, State: "all", Limit: 1})
		faultCode(t, err, "invalid_input")
		_, err = NewReader(f, true).Detail(ctx, principal, projectID, 42, &source)
		faultCode(t, err, "invalid_input")
		_, err = NewReader(f, true).Authors(ctx, principal, projectID, AuthorsRequest{RepositoryID: &source, Limit: 1})
		faultCode(t, err, "invalid_input")
		req := validStatisticsRequest()
		req.RepositoryID = &source
		_, err = NewReader(f, true).Statistics(ctx, principal, projectID, req)
		faultCode(t, err, "invalid_input")
		if len(f.trace) != 0 {
			t.Fatal(f.trace)
		}
	}
}
