package github

import (
	"context"
	"errors"
	"math"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/githubpr"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type statisticsFixture struct {
	*fixture
	connection githubpr.Connection
	data       store.GitHubPRStatistics
	query      store.GitHubPRStatisticsQuery
	err        error
}

func (f *statisticsFixture) ReadSnapshot(ctx context.Context, fn func(store.SnapshotScope) error) error {
	f.trace = append(f.trace, "snapshot")
	if ctx != f.wantCtx {
		panic("context changed")
	}
	if err := fn(f); err != nil {
		return err
	}
	return f.completionErr
}
func (f *statisticsFixture) GitHubDAO() store.GitHubReadDAO { return f }
func (f *statisticsFixture) Connection(ctx context.Context, id string) (githubpr.Connection, error) {
	f.trace = append(f.trace, "connection")
	if ctx != f.wantCtx || id != projectID {
		panic("wrong connection")
	}
	return f.connection, f.connectionErr
}
func (f *statisticsFixture) PullRequestStatistics(ctx context.Context, q store.GitHubPRStatisticsQuery) (store.GitHubPRStatistics, error) {
	f.trace = append(f.trace, "statistics")
	if ctx != f.wantCtx {
		panic("wrong context")
	}
	f.query = q
	return f.data, f.err
}
func segment(index int, date string) StatisticsSegment {
	t, _ := time.Parse(time.RFC3339, date)
	return StatisticsSegment{index, t.UnixMilli()}
}
func validStatisticsRequest() StatisticsRequest {
	return StatisticsRequest{EndDate: "2026-03-08", Window: []StatisticsSegment{segment(0, "2026-02-07T00:00:00Z"), segment(1, "2026-02-08T00:00:00Z"), segment(-1, "2026-02-09T00:00:00Z")}}
}
func index(v int32) *int32 { return &v }
func TestStatisticsSnapshotAndProjection(t *testing.T) {
	ctx := context.Background()
	author := int64(9007199254740993)
	f := &statisticsFixture{fixture: fixtureFor(ctx), connection: githubpr.Connection{ProjectID: projectID, Revision: 9}, data: store.GitHubPRStatistics{Buckets: []store.GitHubPRStatisticsBucket{{DateIndex: index(0), Total: 2, AuthorTotal: 1, HasAuthors: true}, {Total: 3}, {DateIndex: index(1), Total: 1, AuthorTotal: 1}}, Author: &githubpr.Author{ID: author, Login: "new"}}}
	req := validStatisticsRequest()
	req.AuthorID = &author
	got, err := NewReader(f, false).Statistics(ctx, principal, projectID, req)
	if err != nil || got.ProjectTotal != 6 || got.Availability != "ready" || !got.HasAuthors || got.Daily[0] != 2 || got.Daily[1] != 1 || got.Daily[29] != 0 || got.AuthorDaily == nil || got.AuthorDaily[0] != 1 || got.Author.Login != "new" {
		t.Fatalf("got %+v, %v", got, err)
	}
	if !reflect.DeepEqual(f.trace, []string{"snapshot", "access", "connection", "statistics"}) || f.query.ProjectID != projectID || !reflect.DeepEqual(f.query.DateIndices, []int32{0, 1, -1}) || f.query.AuthorID != &author {
		t.Fatalf("trace=%v query=%+v", f.trace, f.query)
	}
	f = &statisticsFixture{fixture: fixtureFor(ctx), connection: githubpr.Connection{ProjectID: projectID}}
	got, err = NewReader(f, false).Statistics(ctx, principal, projectID, validStatisticsRequest())
	if err != nil || got.AuthorID != nil || got.Author != nil || got.AuthorDaily != nil || got.Availability != "not_connected" {
		t.Fatalf("empty=%+v err=%v", got, err)
	}
}
func TestStatisticsValidation(t *testing.T) {
	for name, change := range map[string]func(*StatisticsRequest){
		"date": func(r *StatisticsRequest) { r.EndDate = "2026-02-30" }, "year": func(r *StatisticsRequest) { r.EndDate = "0001-01-01" }, "missing": func(r *StatisticsRequest) { r.Window = nil }, "terminal": func(r *StatisticsRequest) { r.Window[2].DateIndex = 2 }, "duplicate": func(r *StatisticsRequest) { r.Window[1].DateIndex = 0 }, "order": func(r *StatisticsRequest) { r.Window[1].StartMillis = r.Window[0].StartMillis }, "range": func(r *StatisticsRequest) { r.Window[0] = segment(0, "2026-02-05T00:00:00Z") }, "index": func(r *StatisticsRequest) { r.Window[0].DateIndex = 30 }, "unnamed": func(r *StatisticsRequest) {
			r.Window = []StatisticsSegment{segment(-1, "2026-02-07T00:00:00Z"), segment(-1, "2026-02-08T00:00:00Z")}
		}, "author": func(r *StatisticsRequest) { v := int64(0); r.AuthorID = &v },
	} {
		t.Run(name, func(t *testing.T) {
			r := validStatisticsRequest()
			change(&r)
			f := &statisticsFixture{fixture: fixtureFor(context.Background())}
			_, err := NewReader(f, true).Statistics(context.Background(), principal, projectID, r)
			faultCode(t, err, "invalid_input")
			if len(f.trace) != 0 {
				t.Fatal(f.trace)
			}
		})
	}
	r := validStatisticsRequest()
	r.Window = []StatisticsSegment{segment(0, "2026-02-07T00:00:00Z"), segment(-1, "2026-02-07T06:00:00Z"), segment(0, "2026-02-07T12:00:00Z"), segment(-1, "2026-02-08T00:00:00Z")}
	if _, err := statisticsQuery(r); err != nil {
		t.Fatal(err)
	}
}
func TestStatisticsAvailability(t *testing.T) {
	id := int64(1)
	now := time.Now()
	generation := int64(2)
	connected := githubpr.Connection{InstallationID: &id, RepositoryID: &id, LegacyRepositoryID: &id, Enabled: true, SyncEnabled: true, Generation: 2}
	for _, tc := range []struct {
		name      string
		c         githubpr.Connection
		available bool
		total     int64
		want      string
	}{
		{"saved", githubpr.Connection{}, false, 1, "ready"}, {"missing", githubpr.Connection{}, false, 0, "not_connected"}, {"initializing", connected, true, 0, "initializing"}, {"disabled service", connected, false, 0, "no_saved_data"}, {"different source", func() githubpr.Connection { c := connected; other := int64(2); c.RepositoryID = &other; return c }(), true, 0, "no_saved_data"}, {"different source completed", func() githubpr.Connection {
			c := connected
			other := int64(2)
			c.RepositoryID = &other
			c.LastFullGeneration = &generation
			c.LastFullSuccessAt = &now
			return c
		}(), true, 0, "no_saved_data"}, {"unbound legacy", func() githubpr.Connection { c := connected; c.LegacyRepositoryID = nil; return c }(), true, 0, "no_saved_data"}, {"success", func() githubpr.Connection {
			c := connected
			c.LastFullGeneration = &generation
			c.LastFullSuccessAt = &now
			return c
		}(), true, 0, "ready"}, {"disabled sync", func() githubpr.Connection { c := connected; c.SyncEnabled = false; return c }(), true, 0, "no_saved_data"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := statisticsAvailability(tc.c, tc.available, tc.total); got != tc.want {
				t.Fatalf("got %s want %s", got, tc.want)
			}
		})
	}
}

func TestHistoricalSourceAvailability(t *testing.T) {
	current, historical := int64(1), int64(2)
	generation := int64(3)
	now := time.Now()
	connection := githubpr.Connection{InstallationID: &current, RepositoryID: &current, LegacyRepositoryID: &historical, Enabled: true, SyncEnabled: true, Generation: generation}
	if got := sourceStatisticsAvailability(connection, &current, true, 0); got != "initializing" {
		t.Fatalf("current=%s", got)
	}
	if got := sourceStatisticsAvailability(connection, &historical, true, 0); got != "no_saved_data" {
		t.Fatalf("historical=%s", got)
	}
	connection.LastFullGeneration, connection.LastFullSuccessAt = &generation, &now
	if got := sourceStatisticsAvailability(connection, &historical, true, 0); got != "no_saved_data" {
		t.Fatalf("historical borrowed success: %s", got)
	}
	connection.InstallationID = nil
	if got := statisticsAvailability(connection, true, 0); got != "not_connected" {
		t.Fatalf("implicit availability changed: %s", got)
	}
	if got := sourceStatisticsAvailability(connection, &historical, true, 0); got != "no_saved_data" {
		t.Fatalf("historical borrowed connection: %s", got)
	}
	if got := sourceStatisticsAvailability(connection, &historical, true, 1); got != "ready" {
		t.Fatalf("saved historical=%s", got)
	}
}
func TestStatisticsFailures(t *testing.T) {
	ctx := context.Background()
	cause := errors.New("failure")
	for _, tc := range []struct {
		name  string
		setup func(*statisticsFixture)
	}{
		{"access", func(f *statisticsFixture) { f.accessErr = cause }}, {"connection", func(f *statisticsFixture) { f.connectionErr = cause }}, {"query", func(f *statisticsFixture) { f.err = cause }}, {"completion", func(f *statisticsFixture) { f.completionErr = cause }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := &statisticsFixture{fixture: fixtureFor(ctx)}
			tc.setup(f)
			got, err := NewReader(f, true).Statistics(ctx, principal, projectID, validStatisticsRequest())
			if !errors.Is(err, cause) || !reflect.DeepEqual(got, Statistics{}) {
				t.Fatalf("got %+v %v", got, err)
			}
		})
	}
	for _, b := range [][]store.GitHubPRStatisticsBucket{{{DateIndex: index(30)}}, {{Total: -1}}, {{Total: math.MaxInt64}, {DateIndex: index(0), Total: 1}}, {{DateIndex: index(1)}, {DateIndex: index(1)}}} {
		f := &statisticsFixture{fixture: fixtureFor(ctx), data: store.GitHubPRStatistics{Buckets: b}}
		if _, err := NewReader(f, true).Statistics(ctx, principal, projectID, validStatisticsRequest()); err == nil {
			t.Fatalf("accepted %+v", b)
		}
	}
}

func TestStatisticsRefusesProjectAccessBeforeReadingFacts(t *testing.T) {
	ctx := context.Background()
	for _, tc := range []struct {
		name string
		err  error
		code string
	}{
		{"forbidden", &model.Fault{Code: "forbidden"}, "forbidden"},
		{"missing", model.ErrNotFound, "not_found"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := &statisticsFixture{fixture: fixtureFor(ctx)}
			f.accessErr = tc.err
			_, err := NewReader(f, true).Statistics(ctx, principal, projectID, validStatisticsRequest())
			faultCode(t, err, tc.code)
			if !reflect.DeepEqual(f.trace, []string{"snapshot", "access"}) {
				t.Fatalf("unexpected reads: %v", f.trace)
			}
		})
	}
}
