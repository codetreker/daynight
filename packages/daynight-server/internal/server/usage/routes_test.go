package usage

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/usage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	app "github.com/codetreker/daynight/packages/daynight-server/internal/service/usage"
)

type principalAuth struct{ principal model.Principal }

func (a principalAuth) Require(next httpx.AuthenticatedHandler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) { next(w, r, a.principal) }
}

type controlledOperations struct {
	operations
	t         *testing.T
	ctx       context.Context
	name      string
	principal model.Principal
	args      []any
	reply     any
	err       error
	calls     int
	onCall    func(context.Context)
}

func (s *controlledOperations) invoke(ctx context.Context, name string, p model.Principal, args ...any) {
	s.t.Helper()
	s.calls++
	if ctx != s.ctx || name != s.name || p != s.principal || !reflect.DeepEqual(args, s.args) {
		s.t.Errorf("operation propagation: %s %v %v", name, p, args)
	}
	if s.calls != 1 {
		s.t.Errorf("extra business operation: %s", name)
	}
	if s.onCall != nil {
		s.onCall(ctx)
	}
}
func (s *controlledOperations) Register(ctx context.Context, p model.Principal, input app.Registration) (app.RegistrationResult, error) {
	s.invoke(ctx, "register", p, input)
	r, _ := s.reply.(app.RegistrationResult)
	return r, s.err
}
func (s *controlledOperations) State(ctx context.Context, p model.Principal, id string) (model.UsageRecord, error) {
	s.invoke(ctx, "state", p, id)
	r, _ := s.reply.(model.UsageRecord)
	return r, s.err
}
func (s *controlledOperations) Rotate(ctx context.Context, p model.Principal, id string, input app.GrantRequest) (app.RegistrationResult, error) {
	s.invoke(ctx, "rotate", p, id, input)
	r, _ := s.reply.(app.RegistrationResult)
	return r, s.err
}
func (s *controlledOperations) Revoke(ctx context.Context, p model.Principal, id, version string) (model.UsageRecord, error) {
	s.invoke(ctx, "revoke", p, id, version)
	r, _ := s.reply.(model.UsageRecord)
	return r, s.err
}
func (s *controlledOperations) Batch(ctx context.Context, id, token string, input app.Batch) (app.BatchResult, error) {
	s.invoke(ctx, "batch", model.Principal{}, id, token, input)
	r, _ := s.reply.(app.BatchResult)
	return r, s.err
}
func (s *controlledOperations) Sources(ctx context.Context, id, token string, keys []string) (app.SourcesResult, error) {
	s.invoke(ctx, "sources", model.Principal{}, id, token, keys)
	r, _ := s.reply.(app.SourcesResult)
	return r, s.err
}
func (s *controlledOperations) TaskSummaries(ctx context.Context, p model.Principal, project string, ids []string) (app.Summaries, error) {
	s.invoke(ctx, "summaries", p, project, ids)
	r, _ := s.reply.(app.Summaries)
	return r, s.err
}
func (s *controlledOperations) TestSummary(ctx context.Context, p model.Principal, id string) (model.UsageSummary, error) {
	s.invoke(ctx, "test-summary", p, id)
	r, _ := s.reply.(model.UsageSummary)
	return r, s.err
}
func (s *controlledOperations) Records(ctx context.Context, p model.Principal, project, task, session string, input app.PageRequest) (app.RecordsPage, error) {
	s.invoke(ctx, "records", p, project, task, session, input)
	r, _ := s.reply.(app.RecordsPage)
	return r, s.err
}
func (s *controlledOperations) Aggregate(ctx context.Context, p model.Principal, project, kind, id, cursor string) (app.Aggregate, error) {
	s.invoke(ctx, "aggregate", p, project, kind, id, cursor)
	r, _ := s.reply.(app.Aggregate)
	return r, s.err
}

func TestUsageHTTPPropagatesOperationsAndEncodesResults(t *testing.T) {
	const project = "10000000-0000-4000-8000-000000000001"
	const task = "10000000-0000-4000-8000-000000000002"
	const state = "10000000-0000-4000-8000-000000000003"
	const session = "10000000-0000-4000-8000-000000000004"
	principal := model.Principal{UserID: "user", CredentialID: "credential", Kind: model.PATCredential}
	token := strings.Repeat("x", 43)
	now := time.Date(2026, 11, 18, 0, 0, 0, 0, time.UTC)
	record := model.UsageRecord{ID: state, SessionID: session, Metrics: model.UsageMetrics{Output: core.Ptr("9007199254740993")}, ReasonCodes: []string{}, GrantHash: []byte("private-hash"), ParentCredentialID: core.Ptr("private-parent"), ObservedAt: now, CreatedAt: now, UpdatedAt: now}
	summary := model.UsageSummary{ETag: "summary-etag", MeasurementRecords: "1", Metrics: map[string]model.UsageMetricSummary{"outputTokens": {Known: core.Ptr("9007199254740993"), ContributingRecords: "1", UnknownRecords: "0"}}, ObservedAt: now}
	summaries := app.Summaries{Items: []app.SummaryItem{{TaskID: task, Summary: summary}}, ETag: "batch-etag", ObservedAt: now}
	registration := app.Registration{Protocol: core.Protocol, StateID: state, SessionID: session, Generation: "1", ControllerInstanceID: project, ConnectionEpoch: "2", NativeSessionID: "native", ProfileID: "profile", ProviderVersion: "version", RegistrationID: task}
	rotation := app.GrantRequest{ExpectedRowVersion: "7", SessionID: session, Generation: "1", ControllerInstanceID: project, ConnectionEpoch: "2"}
	body := func(v any) string {
		b, err := json.Marshal(v)
		if err != nil {
			t.Fatal(err)
		}
		return string(b)
	}
	event := model.UsageEvent{EventID: task, Kind: "execution_state", StateSequence: "1", CollectionState: "collecting", ReasonCodes: []string{}, ObservedAt: "2026-11-18T00:00:00Z"}
	eventJSON := `{"eventId":"` + task + `","kind":"execution_state","stateSequence":"1","collectionState":"collecting","capability":null,"reasonCodes":[],"nativeStartedAt":null,"nativeEndedAt":null,"observedAt":"2026-11-18T00:00:00Z","seal":false}`
	cases := []struct {
		name, method, url, body, operation string
		args                               []any
		reply                              any
		status                             int
		fragment, etag                     string
		grant                              bool
	}{
		{"registration", "POST", "/api/usage/v1/registrations", body(registration), "register", []any{registration}, app.RegistrationResult{State: record, Grant: &app.Grant{Token: token, ExpiresAt: now}, Created: true}, 201, `"grant":{"token"`, "", false},
		{"state", "GET", "/api/usage/v1/states/" + state, "", "state", []any{state}, record, 200, `"outputTokens":"9007199254740993"`, "", false},
		{"rotation", "POST", "/api/usage/v1/states/" + state + "/grant", body(rotation), "rotate", []any{state, rotation}, app.RegistrationResult{State: record}, 200, `"state":`, "", false},
		{"revoke", "POST", "/api/usage/v1/states/" + state + "/revoke", `{"expectedRowVersion":"7"}`, "revoke", []any{state, "7"}, record, 200, `"state":`, "", false},
		{"batch", "POST", "/api/usage/v1/states/" + state + "/batches", `{"protocol":"daynight.usage.v1","batchId":"` + project + `","events":[` + eventJSON + `]}`, "batch", []any{state, token, app.Batch{Protocol: core.Protocol, BatchID: project, Events: []model.UsageEvent{event}}}, app.BatchResult{Protocol: core.Protocol, BatchID: project, Results: []app.EventResult{}, ObservedAt: now}, 200, `"results":[]`, "", true},
		{"sources", "GET", "/api/usage/v1/states/" + state + "/sources?key=one&key=two", "", "sources", []any{state, token, []string{"one", "two"}}, app.SourcesResult{Items: []app.SourceState{}, MissingKeys: []string{"one", "two"}}, 200, `"missingKeys":["one","two"]`, "", true},
		{"task-summary", "GET", "/api/projects/" + project + "/tasks/" + task + "/usage/v1/summary", "", "summaries", []any{project, []string{task}}, summaries, 200, `"known":"9007199254740993"`, "summary-etag", false},
		{"task-summaries", "POST", "/api/projects/" + project + "/usage/v1/task-summaries", `{"taskIds":["` + task + `"]}`, "summaries", []any{project, []string{task}}, summaries, 200, `"taskId":"` + task + `"`, "batch-etag", false},
		{"test-summary", "GET", "/api/test-sessions/" + session + "/usage/v1/summary", "", "test-summary", []any{session}, summary, 200, `"known":"9007199254740993"`, "summary-etag", false},
		{"task-records", "GET", "/api/projects/" + project + "/tasks/" + task + "/usage/v1/records?kind=measurement&limit=2&stateId=" + state + "&model=model&provider=copilot&aggregationRole=counted&cursor=cursor", "", "records", []any{project, task, "", app.PageRequest{Kind: "measurement", Limit: 2, StateID: state, Model: "model", Provider: "copilot", Role: "counted", Cursor: "cursor"}}, app.RecordsPage{Items: []model.UsageRecord{record}, ObservedAt: now, SnapshotToken: "snapshot"}, 200, `"snapshotToken":"snapshot"`, "", false},
		{"test-records", "GET", "/api/test-sessions/" + session + "/usage/v1/records?kind=execution_state", "", "records", []any{"", "", session, app.PageRequest{Kind: "execution_state", Limit: 100}}, app.RecordsPage{Items: []model.UsageRecord{record}}, 200, `"items":[`, "", false},
		{"chain", "GET", "/api/projects/" + project + "/usage/v1/aggregates/chain/" + task + "?cursor=cursor", "", "aggregate", []any{project, "chain", task, "cursor"}, app.Aggregate{Scope: "chain", ScopeID: task}, 200, `"scope":"chain"`, "", false},
		{"goal", "GET", "/api/projects/" + project + "/usage/v1/aggregates/goal/" + task, "", "aggregate", []any{project, "goal", task, ""}, app.Aggregate{Scope: "goal", ScopeID: task}, 200, `"scope":"goal"`, "", false},
	}
	for _, tc := range cases {
		for _, mode := range []string{"success", "refusal", "not-modified"} {
			if mode == "not-modified" && tc.etag == "" {
				continue
			}
			t.Run(tc.name+"/"+mode, func(t *testing.T) {
				ctx := t.Context()
				p := principal
				if tc.grant {
					p = model.Principal{}
				}
				service := &controlledOperations{t: t, ctx: ctx, name: tc.operation, principal: p, args: tc.args, reply: tc.reply}
				want := tc.status
				if mode == "refusal" {
					service.err = core.Fault("usage_changed")
					want = 409
				}
				if mode == "not-modified" {
					want = 304
				}
				mux := http.NewServeMux()
				registerRoutes(mux, service, principalAuth{principal}, slog.New(slog.NewTextHandler(io.Discard, nil)))
				r := httptest.NewRequest(tc.method, tc.url, strings.NewReader(tc.body)).WithContext(ctx)
				if tc.body != "" {
					r.Header.Set("Content-Type", "application/json")
				}
				if tc.grant {
					r.Header.Set("Authorization", "Bearer "+token)
				}
				if mode == "not-modified" {
					r.Header.Set("If-None-Match", `"`+tc.etag+`"`)
				}
				w := httptest.NewRecorder()
				mux.ServeHTTP(w, r)
				if w.Code != want || service.calls != 1 {
					t.Fatalf("status=%d calls=%d body=%s", w.Code, service.calls, w.Body.String())
				}
				if mode == "success" && (!strings.Contains(w.Body.String(), tc.fragment) || !strings.HasSuffix(w.Body.String(), "\n")) {
					t.Fatal(w.Body.String())
				}
				if mode == "not-modified" && w.Body.Len() != 0 {
					t.Fatal("304 carried a response body")
				}
				if mode == "refusal" && !strings.Contains(w.Body.String(), `"code":"usage_changed"`) {
					t.Fatal(w.Body.String())
				}
				if strings.Contains(w.Body.String(), "private-hash") || strings.Contains(w.Body.String(), "private-parent") {
					t.Fatal("projection leaked grant material")
				}
				if mode != "refusal" && tc.etag != "" && w.Header().Get("ETag") != `"`+tc.etag+`"` {
					t.Fatal(w.Header())
				}
			})
		}
	}
}

func TestUsageHTTPRefusesMalformedInputBeforeBusinessOperation(t *testing.T) {
	const id = "10000000-0000-4000-8000-000000000001"
	for _, tc := range []struct {
		method, url, body, media string
		status                   int
	}{
		{"POST", "/api/usage/v1/registrations", "{}", "text/plain", 400},
		{"POST", "/api/usage/v1/registrations", `{"protocol":"x","protocol":"y"}`, "application/json", 400},
		{"POST", "/api/usage/v1/states/" + id + "/grant", "{", "application/json", 400},
		{"POST", "/api/usage/v1/states/" + id + "/revoke", `{"expectedRowVersion":1}`, "application/json", 400},
		{"POST", "/api/usage/v1/states/" + id + "/batches", `{"events":[{"kind":"measurement","padding":"` + strings.Repeat("x", 16*1024) + `"}]}`, "application/json", 413},
		{"GET", "/api/usage/v1/states/not-a-uuid", "", "", 404},
		{"POST", "/api/usage/v1/states/not-a-uuid/grant", "{}", "application/json", 404},
		{"POST", "/api/usage/v1/states/not-a-uuid/revoke", "{}", "application/json", 404},
		{"GET", "/api/usage/v1/states/not-a-uuid/sources", "", "", 404},
		{"GET", "/api/projects/" + id + "/tasks/not-a-uuid/usage/v1/summary", "", "", 404},
		{"GET", "/api/projects/not-a-uuid/tasks/" + id + "/usage/v1/summary", "", "", 404},
		{"POST", "/api/projects/not-a-uuid/usage/v1/task-summaries", "{}", "application/json", 404},
		{"POST", "/api/projects/" + id + "/usage/v1/task-summaries", "{", "application/json", 400},
		{"GET", "/api/test-sessions/not-a-uuid/usage/v1/summary", "", "", 404},
		{"GET", "/api/test-sessions/not-a-uuid/usage/v1/records", "", "", 404},
		{"GET", "/api/test-sessions/" + id + "/usage/v1/records?limit=invalid", "", "", 400},
		{"GET", "/api/projects/not-a-uuid/usage/v1/aggregates/chain/" + id, "", "", 404},
		{"GET", "/api/projects/" + id + "/usage/v1/aggregates/goal/not-a-uuid", "", "", 404},
	} {
		t.Run(tc.method+" "+tc.url, func(t *testing.T) {
			service := &controlledOperations{t: t}
			mux := http.NewServeMux()
			registerRoutes(mux, service, fixedAuth{}, slog.New(slog.NewTextHandler(io.Discard, nil)))
			r := httptest.NewRequest(tc.method, tc.url, strings.NewReader(tc.body))
			r.Header.Set("Content-Type", tc.media)
			w := httptest.NewRecorder()
			mux.ServeHTTP(w, r)
			if w.Code != tc.status || service.calls != 0 {
				t.Fatal(w.Code, service.calls, w.Body.String())
			}
		})
	}
}

func TestUsageHTTPErrorStatusAndRedaction(t *testing.T) {
	h := handler{logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
	for _, tc := range []struct {
		err    error
		status int
		code   string
	}{
		{core.Fault("invalid_grant"), 401, "invalid_grant"},
		{core.Fault("permission_revoked"), 403, "permission_revoked"},
		{core.Fault("aggregate_scope_restricted"), 403, "aggregate_scope_restricted"},
		{model.ErrNotFound, 404, "resource_unavailable"},
		{core.Fault("origin_unavailable"), 410, "origin_unavailable"},
		{core.Fault("upload_expired"), 410, "upload_expired"},
		{core.Fault("unsupported_scope"), 422, "unsupported_scope"},
		{core.Fault("aggregate_scope_too_large"), 422, "aggregate_scope_too_large"},
		{core.Fault("write_disabled"), 501, "write_disabled"},
		{core.Fault("write_outcome_unknown"), 503, "write_outcome_unknown"},
		{core.Fault("write_not_committed"), 503, "write_not_committed"},
		{&model.UsageFault{Code: "source_conflict", EventID: "event", SourceKey: "source", CurrentRevision: core.Ptr("7"), CurrentBodyHash: "hash", DiagnosticCommitted: true, RowVersion: "9"}, 409, "source_conflict"},
		{errors.New("private credential details"), 500, ""},
	} {
		w := httptest.NewRecorder()
		h.fail(w, httptest.NewRequest("GET", "/", nil), tc.err)
		if w.Code != tc.status || tc.code != "" && !strings.Contains(w.Body.String(), `"code":"`+tc.code+`"`) {
			t.Fatal(w.Code, w.Body.String())
		}
		if strings.Contains(w.Body.String(), "private credential details") {
			t.Fatal("internal error leaked")
		}
	}
}

func TestUsagePaginationQueryValidation(t *testing.T) {
	const id = "10000000-0000-4000-8000-000000000001"
	principal := model.Principal{UserID: "reader"}
	for _, route := range []struct {
		name, path, op string
		args           []any
	}{
		{"task records", "/api/projects/" + id + "/tasks/" + id + "/usage/v1/records", "records", []any{id, id, "", app.PageRequest{Limit: 100}}},
		{"test records", "/api/test-sessions/" + id + "/usage/v1/records", "records", []any{"", "", id, app.PageRequest{Limit: 100}}},
		{"chain", "/api/projects/" + id + "/usage/v1/aggregates/chain/" + id, "aggregate", []any{id, "chain", id, ""}},
		{"goal", "/api/projects/" + id + "/usage/v1/aggregates/goal/" + id, "aggregate", []any{id, "goal", id, ""}},
	} {
		for _, tc := range []struct {
			name, query, code string
			calls             int
		}{
			{"absent", "", "", 1},
			{"empty", "?cursor=", "", 1},
			{"malformed escape", "?cursor=secret&bad=%xx", "invalid_filter", 0},
			{"semicolon", "?cursor=secret&bad=a;b", "invalid_filter", 0},
			{"duplicates", "?cursor=secret&cursor=", "invalid_cursor", 0},
			{"encoded duplicate", "?cursor=&%63ursor=secret", "invalid_cursor", 0},
		} {
			t.Run(route.name+"/"+tc.name, func(t *testing.T) {
				ctx := t.Context()
				service := &controlledOperations{t: t, ctx: ctx, name: route.op, principal: principal, args: route.args}
				mux := http.NewServeMux()
				registerRoutes(mux, service, principalAuth{principal}, slog.New(slog.NewTextHandler(io.Discard, nil)))
				w := httptest.NewRecorder()
				mux.ServeHTTP(w, httptest.NewRequest("GET", route.path+tc.query, nil).WithContext(ctx))
				want := http.StatusOK
				if tc.code != "" {
					want = http.StatusBadRequest
				}
				if w.Code != want || service.calls != tc.calls || tc.code != "" && !strings.Contains(w.Body.String(), `"code":"`+tc.code+`"`) || strings.Contains(w.Body.String(), "secret") {
					t.Fatalf("status=%d calls=%d body=%s", w.Code, service.calls, w.Body.String())
				}
			})
		}
	}
}

func TestUsagePaginationChecksAuthenticationAndResourceIDBeforeQuery(t *testing.T) {
	const id = "10000000-0000-4000-8000-000000000001"
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	for _, path := range []string{
		"/api/test-sessions/not-a-uuid/usage/v1/records?cursor=a&cursor=b",
		"/api/projects/" + id + "/usage/v1/aggregates/goal/not-a-uuid?bad=%xx",
	} {
		service := &controlledOperations{t: t}
		mux := http.NewServeMux()
		registerRoutes(mux, service, fixedAuth{}, logger)
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, httptest.NewRequest("GET", path, nil))
		if w.Code != 404 || service.calls != 0 {
			t.Fatal(w.Code, service.calls, w.Body.String())
		}
		calls := 0
		mux = http.NewServeMux()
		registerRoutes(mux, service, rejectingAuth{&calls}, logger)
		w = httptest.NewRecorder()
		mux.ServeHTTP(w, httptest.NewRequest("GET", path, nil))
		if w.Code != 401 || calls != 1 || service.calls != 0 {
			t.Fatal(w.Code, calls, service.calls)
		}
	}
}
