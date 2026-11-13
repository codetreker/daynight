package tag

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	coretag "github.com/codetreker/daynight/packages/daynight-server/internal/core/tag"
	authhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"
	authconfig "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth/config"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	service "github.com/codetreker/daynight/packages/daynight-server/internal/service/tag"
)

const projectID = "20000000-0000-4000-8000-000000000001"
const tagID = "30000000-0000-4000-8000-000000000001"
const collection = "/api/v1/projects/" + projectID + "/tags"

type operationMock struct {
	t       *testing.T
	list    func(context.Context, model.Principal, string, service.ListInput) (service.Page, error)
	get     func(context.Context, model.Principal, string, string) (service.Item, error)
	create  func(context.Context, model.Principal, string, string) (service.WriteResult, error)
	rename  func(context.Context, model.Principal, string, string, int64, string) (service.WriteResult, error)
	delete  func(context.Context, model.Principal, string, string, int64, bool) (service.WriteResult, error)
	resolve func(context.Context, model.Principal, string, []string) ([]model.TagReference, error)
}

func (m *operationMock) List(c context.Context, p model.Principal, project string, i service.ListInput) (service.Page, error) {
	if m.list == nil {
		m.t.Fatal("unexpected List")
	}
	return m.list(c, p, project, i)
}
func (m *operationMock) Get(c context.Context, p model.Principal, project, id string) (service.Item, error) {
	if m.get == nil {
		m.t.Fatal("unexpected Get")
	}
	return m.get(c, p, project, id)
}
func (m *operationMock) Create(c context.Context, p model.Principal, project, name string) (service.WriteResult, error) {
	if m.create == nil {
		m.t.Fatal("unexpected Create")
	}
	return m.create(c, p, project, name)
}
func (m *operationMock) Rename(c context.Context, p model.Principal, project, id string, v int64, name string) (service.WriteResult, error) {
	if m.rename == nil {
		m.t.Fatal("unexpected Rename")
	}
	return m.rename(c, p, project, id, v, name)
}
func (m *operationMock) Delete(c context.Context, p model.Principal, project, id string, v int64, confirm bool) (service.WriteResult, error) {
	if m.delete == nil {
		m.t.Fatal("unexpected Delete")
	}
	return m.delete(c, p, project, id, v, confirm)
}
func (m *operationMock) Resolve(c context.Context, p model.Principal, project string, ids []string) ([]model.TagReference, error) {
	if m.resolve == nil {
		m.t.Fatal("unexpected Resolve")
	}
	return m.resolve(c, p, project, ids)
}

type fixture struct {
	t         *testing.T
	ops       *operationMock
	handler   http.Handler
	logs      bytes.Buffer
	principal model.Principal
}
type marker struct{}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	f := &fixture{t: t, principal: model.Principal{UserID: "10000000-0000-4000-8000-000000000001", CredentialID: "10000000-0000-4000-8000-000000000002"}}
	f.ops = &operationMock{t: t}
	logger := slog.New(slog.NewJSONHandler(&f.logs, nil))
	auth, err := authhttp.NewRequestAuthentication(func(ctx context.Context, kind model.CredentialKind, secret string) (model.Principal, error) {
		if ctx.Value(marker{}) != f {
			t.Error("authentication lost context")
		}
		if kind != model.PATCredential || secret != "credential" {
			return model.Principal{}, authhttp.Failure()
		}
		return f.principal, nil
	}, authconfig.AuthSettings{PublicOrigin: "http://127.0.0.1:8787", AllowHTTPTestOrigin: true}, logger)
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	RegisterRoutes(mux, f.ops, auth, logger)
	f.handler = httpx.RequestLogging(logger, mux)
	return f
}
func (f *fixture) request(method, path, body string, authenticated bool) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	r = r.WithContext(context.WithValue(r.Context(), marker{}, f))
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("X-Request-ID", "tag-test")
	if authenticated {
		r.Header.Set("Authorization", "Bearer credential")
	}
	w := httptest.NewRecorder()
	f.handler.ServeHTTP(w, r)
	return w
}
func (f *fixture) check(ctx context.Context, p model.Principal, project string) {
	f.t.Helper()
	if ctx.Value(marker{}) != f || p != f.principal || project != projectID {
		f.t.Fatalf("context or identity lost: %v %+v %q", ctx, p, project)
	}
}
func decode[T any](t *testing.T, w *httptest.ResponseRecorder, status int) T {
	t.Helper()
	if w.Code != status {
		t.Fatalf("status=%d expected=%d body=%s", w.Code, status, w.Body)
	}
	var v T
	if err := json.Unmarshal(w.Body.Bytes(), &v); err != nil {
		t.Fatal(err)
	}
	return v
}
func item() service.Item {
	now := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	return service.Item{Tag: model.Tag{ID: tagID, ProjectID: projectID, Name: "Alpha", Version: 7, CreatedAt: now, UpdatedAt: now}, Usage: model.TagUsage{Tasks: 2, Goals: 1}}
}
func committed() service.WriteResult {
	return service.WriteResult{Item: item(), ProjectID: projectID, TagID: tagID, Deleted: true, Phase: "commit", Outcome: store.TransactionCommitted}
}

func TestRoutesProjectInputAndResponses(t *testing.T) {
	f := newFixture(t)
	cursor := "next"
	f.ops.list = func(c context.Context, p model.Principal, project string, i service.ListInput) (service.Page, error) {
		f.check(c, p, project)
		if i.Query != "Al" || i.Limit != 9 || i.Cursor != "prior" {
			t.Fatalf("list input=%+v", i)
		}
		return service.Page{Items: []service.Item{item()}, CatalogEpoch: "epoch", NextCursor: &cursor}, nil
	}
	page := decode[api.TagPage](t, f.request("GET", collection+"?query=Al&limit=9&cursor=prior", "", true), 200)
	if len(page.Items) != 1 || page.Items[0].Usage.Tasks != 2 || page.CatalogEpoch != "epoch" || page.NextCursor == nil || *page.NextCursor != "next" {
		t.Fatalf("page=%+v", page)
	}
	f.ops.get = func(c context.Context, p model.Principal, project, id string) (service.Item, error) {
		f.check(c, p, project)
		if id != tagID {
			t.Fatal(id)
		}
		return item(), nil
	}
	got := decode[api.Tag](t, f.request("GET", collection+"/"+tagID, "", true), 200)
	if got.ID != tagID || got.Version != 7 || got.Usage.Goals != 1 {
		t.Fatalf("tag=%+v", got)
	}
	f.ops.create = func(c context.Context, p model.Principal, project, name string) (service.WriteResult, error) {
		f.check(c, p, project)
		if name != "Alpha" {
			t.Fatal(name)
		}
		return committed(), nil
	}
	w := f.request("POST", collection, `{"name":"Alpha"}`, true)
	created := decode[api.Tag](t, w, 201)
	if created.ID != tagID || w.Header().Get("Location") != collection+"/"+tagID {
		t.Fatalf("creation: %+v %v", created, w.Header())
	}
	f.ops.rename = func(c context.Context, p model.Principal, project, id string, v int64, name string) (service.WriteResult, error) {
		f.check(c, p, project)
		if id != tagID || v != 7 || name != "Alpha" {
			t.Fatal(id, v, name)
		}
		return committed(), nil
	}
	decode[api.Tag](t, f.request("PATCH", collection+"/"+tagID, `{"version":7,"name":"Alpha"}`, true), 200)
	f.ops.delete = func(c context.Context, p model.Principal, project, id string, v int64, confirm bool) (service.WriteResult, error) {
		f.check(c, p, project)
		if id != tagID || v != 7 || !confirm {
			t.Fatal(id, v, confirm)
		}
		return committed(), nil
	}
	receipt := decode[api.TagDeletionReceipt](t, f.request("DELETE", collection+"/"+tagID, `{"version":7,"confirm":true}`, true), 200)
	if receipt.ProjectID != projectID || receipt.TagID != tagID || !receipt.Deleted {
		t.Fatalf("receipt=%+v", receipt)
	}
	f.ops.resolve = func(c context.Context, p model.Principal, project string, ids []string) ([]model.TagReference, error) {
		f.check(c, p, project)
		if len(ids) != 1 || ids[0] != tagID {
			t.Fatal(ids)
		}
		return []model.TagReference{{ID: tagID, Name: "<&"}}, nil
	}
	w = f.request("POST", collection+"/resolve", `{"tagIds":["`+tagID+`"]}`, true)
	if w.Code != 200 || w.Body.String() != `{"items":[{"id":"`+tagID+`","name":"\u003c\u0026"}]}`+"\n" {
		t.Fatalf("resolve=%d %s", w.Code, w.Body)
	}
}

func TestRejectsBeforeBusinessCalls(t *testing.T) {
	for _, tc := range []struct {
		method, path, body string
		status             int
		auth               bool
	}{
		{"POST", collection, `{"name":"a"}`, 401, false},
		{"POST", collection, `{"name":"a","extra":1}`, 400, true},
		{"POST", collection, `{"name":"\ud800"}`, 400, true},
		{"PATCH", collection + "/" + tagID, `{"version":0,"name":"a"}`, 400, true},
		{"DELETE", collection + "/" + tagID, `{"version":7}`, 400, true},
		{"DELETE", collection + "/" + tagID, `{"version":7,"confirm":false}`, 400, true},
		{"POST", collection + "/resolve", `{"tagIds":null}`, 400, true},
		{"POST", collection + "/resolve", `{"tagIds":[null]}`, 400, true},
		{"GET", collection + "?limit=101", "", 400, true},
		{"GET", collection + "?query=x&query=y", "", 400, true},
		{"GET", collection + "/not-an-id", "", 400, true},
		{"PUT", collection, "", 405, true},
	} {
		t.Run(tc.method+tc.path+tc.body, func(t *testing.T) {
			f := newFixture(t)
			w := f.request(tc.method, tc.path, tc.body, tc.auth)
			if w.Code != tc.status {
				t.Fatalf("status=%d want %d body=%s", w.Code, tc.status, w.Body)
			}
		})
	}
}

func TestErrorsAndUnknownCompletion(t *testing.T) {
	cases := []struct {
		code   string
		status int
	}{{"invalid_tag_name", 400}, {"tag_name_conflict", 409}, {"tag_not_found", 404}, {"catalog_changed", 409}, {"version_conflict", 409}, {"resource_limit_exceeded", 409}, {"permission_denied", 403}}
	for _, tc := range cases {
		t.Run(tc.code, func(t *testing.T) {
			f := newFixture(t)
			f.ops.get = func(context.Context, model.Principal, string, string) (service.Item, error) {
				return service.Item{}, &model.Fault{Code: tc.code, Message: "failure"}
			}
			v := decode[api.ErrorResponse](t, f.request("GET", collection+"/"+tagID, "", true), tc.status)
			if v.Error.Code != tc.code || v.Error.RequestID != "tag-test" {
				t.Fatalf("error=%+v", v)
			}
		})
	}
	f := newFixture(t)
	calls := 0
	f.ops.create = func(context.Context, model.Principal, string, string) (service.WriteResult, error) {
		calls++
		return service.WriteResult{Phase: "commit", Outcome: store.TransactionUnknown}, &store.TransactionError{Phase: "commit", Outcome: store.TransactionUnknown, CommitAttempted: true, Cause: errors.New("private")}
	}
	v := decode[api.ErrorResponse](t, f.request("POST", collection, `{"name":"a"}`, true), 503)
	if v.Error.Code != "write_outcome_unknown" || calls != 1 || !strings.Contains(f.logs.String(), `"tx_outcome":"unknown"`) || strings.Contains(f.logs.String(), "private") {
		t.Fatalf("result=%+v calls=%d logs=%s", v, calls, &f.logs)
	}
}

func TestCancellationReachesOperation(t *testing.T) {
	f := newFixture(t)
	started := make(chan struct{})
	done := make(chan struct{})
	f.ops.get = func(ctx context.Context, p model.Principal, project, id string) (service.Item, error) {
		f.check(ctx, p, project)
		close(started)
		<-ctx.Done()
		close(done)
		return service.Item{}, ctx.Err()
	}
	ctx, cancel := context.WithCancel(context.WithValue(context.Background(), marker{}, f))
	r := httptest.NewRequest("GET", collection+"/"+tagID, nil).WithContext(ctx)
	r.Header.Set("Authorization", "Bearer credential")
	finished := make(chan struct{})
	go func() { f.handler.ServeHTTP(httptest.NewRecorder(), r); close(finished) }()
	<-started
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("operation not canceled")
	}
	select {
	case <-finished:
	case <-time.After(time.Second):
		t.Fatal("handler did not exit")
	}
}

type failingWriter struct {
	header http.Header
	calls  int
}

func (w *failingWriter) Header() http.Header       { return w.header }
func (w *failingWriter) WriteHeader(int)           {}
func (w *failingWriter) Write([]byte) (int, error) { w.calls++; return 0, io.ErrClosedPipe }
func TestCommittedResponseFailureIsLoggedWithoutReplay(t *testing.T) {
	f := newFixture(t)
	calls := 0
	f.ops.create = func(context.Context, model.Principal, string, string) (service.WriteResult, error) {
		calls++
		return committed(), nil
	}
	r := httptest.NewRequest("POST", collection, strings.NewReader(`{"name":"a"}`))
	r = r.WithContext(context.WithValue(r.Context(), marker{}, f))
	r.Header.Set("Authorization", "Bearer credential")
	r.Header.Set("Content-Type", "application/json")
	w := &failingWriter{header: make(http.Header)}
	f.handler.ServeHTTP(w, r)
	if calls != 1 || w.calls != 1 || !strings.Contains(f.logs.String(), `"write_outcome":"unknown"`) || !strings.Contains(f.logs.String(), `"tx_outcome":"committed"`) {
		t.Fatalf("calls=%d writes=%d logs=%s", calls, w.calls, &f.logs)
	}
}

func TestNameConflictRequiresReliableRollback(t *testing.T) {
	conflict := coretag.Unique(fmt.Errorf("%w: %w", store.ErrTagNameConflict, &store.Error{Phase: "insert tag", DatabaseFailure: true, SQLState: "23505", Cause: errors.New("private")}))
	for _, tc := range []struct {
		name    string
		tx      store.TransactionError
		outcome store.TransactionOutcome
		cleanup bool
		status  int
		code    string
	}{
		{"operation refusal", store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, Cause: conflict}, store.TransactionNotCommitted, false, 409, "tag_name_conflict"},
		{"cleanup failed", store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, CleanupFailed: true, Cause: conflict}, store.TransactionNotCommitted, true, 500, "internal_error"},
		{"commit attempted", store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, CommitAttempted: true, Cause: conflict}, store.TransactionNotCommitted, false, 500, "internal_error"},
		{"unknown", store.TransactionError{Phase: "commit", Outcome: store.TransactionUnknown, CommitAttempted: true, Cause: conflict}, store.TransactionUnknown, false, 503, "write_outcome_unknown"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newFixture(t)
			f.ops.create = func(context.Context, model.Principal, string, string) (service.WriteResult, error) {
				return service.WriteResult{Outcome: tc.outcome, CleanupFailed: tc.cleanup, Phase: tc.tx.Phase}, &tc.tx
			}
			failure := decode[api.ErrorResponse](t, f.request("POST", collection, `{"name":"a"}`, true), tc.status)
			if failure.Error.Code != tc.code {
				t.Fatalf("error=%+v", failure)
			}
		})
	}
	f := newFixture(t)
	f.ops.create = func(context.Context, model.Principal, string, string) (service.WriteResult, error) {
		tx := &store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, Cause: conflict}
		extra := &store.Error{DatabaseFailure: true, SQLState: "08006", Cause: errors.New("private")}
		return service.WriteResult{Outcome: store.TransactionNotCommitted}, errors.Join(tx, extra)
	}
	got := decode[api.ErrorResponse](t, f.request("POST", collection, `{"name":"a"}`, true), 500)
	if got.Error.Code != "internal_error" {
		t.Fatalf("joined error classified as conflict: %+v", got)
	}
	f.ops.create = func(context.Context, model.Principal, string, string) (service.WriteResult, error) {
		tx := &store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, Cause: conflict}
		other := &store.TransactionError{Phase: "commit", Outcome: store.TransactionUnknown, CommitAttempted: true, Cause: errors.New("private")}
		return service.WriteResult{Outcome: store.TransactionNotCommitted}, errors.Join(tx, other)
	}
	got = decode[api.ErrorResponse](t, f.request("POST", collection, `{"name":"a"}`, true), 503)
	if got.Error.Code != "write_outcome_unknown" {
		t.Fatalf("conflicting completions lost: %+v", got)
	}
}

func TestOversizedRequestIsRejectedWithoutCall(t *testing.T) {
	f := newFixture(t)
	body := `{"name":"` + strings.Repeat("a", httpx.MaxJSONBody) + `"}`
	w := f.request("POST", collection, body, true)
	if w.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status=%d body=%s", w.Code, w.Body)
	}
}

func TestUnsupportedMethodsRequireAuthenticationAndAdvertiseAllowedMethods(t *testing.T) {
	for _, tc := range []struct {
		method string
		path   string
		allow  string
	}{
		{"PUT", collection, "GET, HEAD, POST"},
		{"POST", collection + "/" + tagID, "GET, HEAD, PATCH, DELETE"},
		{"PUT", collection + "/" + tagID, "GET, HEAD, PATCH, DELETE"},
		{"GET", collection + "/resolve", "POST"},
		{"PATCH", collection + "/resolve", "POST"},
		{"DELETE", collection + "/resolve", "POST"},
		{"PUT", collection + "/resolve", "POST"},
	} {
		t.Run(tc.method+" "+tc.path, func(t *testing.T) {
			f := newFixture(t)
			unauthenticated := f.request(tc.method, tc.path, "", false)
			failure := decode[api.ErrorResponse](t, unauthenticated, http.StatusUnauthorized)
			if failure.Error.Code != "unauthenticated" || unauthenticated.Header().Get("Allow") != "" {
				t.Fatalf("unauthenticated response=%+v headers=%v", failure, unauthenticated.Header())
			}
			w := f.request(tc.method, tc.path, "", true)
			failure = decode[api.ErrorResponse](t, w, http.StatusMethodNotAllowed)
			if failure.Error.Code != "method_not_allowed" || w.Header().Get("Allow") != tc.allow || w.Header().Get("Cache-Control") != "no-store" {
				t.Fatalf("method response=%+v headers=%v", failure, w.Header())
			}
		})
	}
}
