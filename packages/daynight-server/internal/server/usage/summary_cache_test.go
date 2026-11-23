package usage

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	app "github.com/codetreker/daynight/packages/daynight-server/internal/service/usage"
)

// Equal empty summaries isolate selection identity from changes in usage facts.
type emptySummaryScope struct {
	store.UsageDAO
	now   time.Time
	reads int
}

type emptySummaryStore struct{ dao *emptySummaryScope }
type emptySummaryReadScope struct{ dao *emptySummaryScope }
type emptySummaryCredential struct{ store.SessionDAO }

func (s emptySummaryStore) ReadUsage(ctx context.Context, read func(store.UsageScope) error) error {
	s.dao.reads++
	return read(emptySummaryReadScope{s.dao})
}
func (emptySummaryStore) WriteUsage(context.Context, func(store.UsageScope) error) (store.Completion, error) {
	panic("unexpected usage write")
}
func (s emptySummaryReadScope) UsageDAO() store.UsageDAO            { return s.dao }
func (emptySummaryReadScope) SessionDAO() store.SessionDAO          { return emptySummaryCredential{} }
func (s *emptySummaryScope) Now(context.Context) (time.Time, error) { return s.now, nil }
func (emptySummaryCredential) ReadCredential(context.Context, model.Principal, time.Time) error {
	return nil
}
func (*emptySummaryScope) ProjectAccess(_ context.Context, _ string, project string, _ bool) (model.ProjectAccess, error) {
	return model.ProjectAccess{ProjectID: project, Role: model.ProjectAdmin}, nil
}
func (*emptySummaryScope) PermissionEpoch(context.Context, string, string) (string, error) {
	return "epoch", nil
}
func (*emptySummaryScope) Tasks(_ context.Context, _ string, ids []string) ([]store.UsageMember, error) {
	members := make([]store.UsageMember, len(ids))
	for i, id := range ids {
		members[i].ID = id
	}
	return members, nil
}
func (*emptySummaryScope) TaskMetrics(context.Context, store.UsageFilter) (map[string]model.UsageSummary, error) {
	return nil, nil
}
func (*emptySummaryScope) Executions(context.Context, store.UsageFilter) ([]store.UsageExecution, error) {
	return nil, nil
}

func TestBatchSummaryConditionalRequestsBindOrderedTaskSelection(t *testing.T) {
	const project = "10000000-0000-4000-8000-000000000001"
	const a = "10000000-0000-4000-8000-000000000002"
	const b = "10000000-0000-4000-8000-000000000003"
	scope := &emptySummaryScope{now: time.Date(2026, 11, 18, 3, 0, 0, 0, time.UTC)}
	service, err := app.New(emptySummaryStore{scope}, app.Options{})
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	RegisterRoutes(mux, service, fixedAuth{}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	request := func(ids []string, etag string) *httptest.ResponseRecorder {
		t.Helper()
		body, err := json.Marshal(map[string]any{"taskIds": ids})
		if err != nil {
			t.Fatal(err)
		}
		r := httptest.NewRequest("POST", "/api/projects/"+project+"/usage/v1/task-summaries", strings.NewReader(string(body)))
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("If-None-Match", etag)
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, r)
		return w
	}
	previous := ""
	for _, ids := range [][]string{{a}, {b}, {a, b}, {b, a}} {
		w := request(ids, previous)
		if w.Code != http.StatusOK {
			t.Fatalf("selection %v: %d %s", ids, w.Code, w.Body.String())
		}
		var result app.Summaries
		if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
			t.Fatal(err)
		}
		gotIDs := []string{}
		for _, item := range result.Items {
			gotIDs = append(gotIDs, item.TaskID)
		}
		if !reflect.DeepEqual(gotIDs, ids) {
			t.Fatalf("selection %v returned %v", ids, gotIDs)
		}
		etag := w.Header().Get("ETag")
		if etag == "" || etag == previous {
			t.Fatalf("selection %v reused ETag %q", ids, etag)
		}
		scope.now = scope.now.Add(time.Second)
		unchanged := request(ids, etag)
		if unchanged.Code != http.StatusNotModified || unchanged.Body.Len() != 0 || unchanged.Header().Get("ETag") != etag {
			t.Fatalf("unchanged selection %v: %d %s", ids, unchanged.Code, unchanged.Body.String())
		}
		previous = etag
	}
	if scope.reads != 8 {
		t.Fatalf("conditional requests skipped reads: %d", scope.reads)
	}
}
