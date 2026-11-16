package github

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"math"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/github"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/githubpr"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	authhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"
	authconfig "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth/config"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	service "github.com/codetreker/daynight/packages/daynight-server/internal/service/github"
)

const appPath = "/api/v1/github/apps"
const appID = "33333333-3333-4333-8333-333333333333"
const appBody = `{"id":"` + appID + `","name":" Example ","githubAppId":"9007199254740993","privateKeyPem":"private-key","webhookSecret":" webhook secret ","expectedUserId":"` + userID + `"}`

type appOps struct {
	t      *testing.T
	create func(context.Context, model.Principal, core.CreateAppInput) (core.AppMetadata, error)
	get    func(context.Context, model.Principal, string) (core.AppMetadata, error)
	list   func(context.Context, model.Principal, core.ListAppsInput) (core.AppPage, error)
}

func (s appOps) CreateApp(ctx context.Context, p model.Principal, in core.CreateAppInput) (core.AppMetadata, error) {
	if s.create == nil {
		s.t.Fatal("unexpected create")
	}
	return s.create(ctx, p, in)
}
func (s appOps) GetApp(ctx context.Context, p model.Principal, id string) (core.AppMetadata, error) {
	if s.get == nil {
		s.t.Fatal("unexpected get")
	}
	return s.get(ctx, p, id)
}
func (s appOps) ListApps(ctx context.Context, p model.Principal, in core.ListAppsInput) (core.AppPage, error) {
	if s.list == nil {
		s.t.Fatal("unexpected list")
	}
	return s.list(ctx, p, in)
}
func appMux(t *testing.T, ops AppOperations, log io.Writer) http.Handler {
	t.Helper()
	logger := slog.New(slog.NewTextHandler(log, nil))
	auth, err := authhttp.NewRequestAuthentication(func(_ context.Context, kind model.CredentialKind, value string) (model.Principal, error) {
		if value != "valid" {
			return model.Principal{}, authhttp.Failure()
		}
		return model.Principal{Kind: kind, UserID: userID, CredentialID: projectID}, nil
	}, authconfig.AuthSettings{PublicOrigin: "https://daynight.example"}, logger)
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	RegisterAppRoutes(mux, ops, auth, "https://daynight.example", logger)
	return httpx.RequestLogging(logger, mux)
}
func appRequest(method, path, body string) *http.Request {
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	r.Header.Set("Authorization", "Bearer valid")
	r.Header.Set("Content-Type", "application/json")
	return r
}
func appMetadata() core.AppMetadata {
	t := time.Date(2026, 11, 1, 0, 0, 0, 0, time.FixedZone("offset", 3600))
	return core.AppMetadata{ID: appID, GitHubAppID: 9007199254740993, Name: " Example ", GitHubName: "Remote", GitHubSlug: "remote", Version: math.MaxInt64, Administrators: 2, AuthorizedTeams: 3, ConnectedProjects: 4, CreatedAt: t, UpdatedAt: t}
}
func TestAppCreateProtocol(t *testing.T) {
	calls := 0
	var logs bytes.Buffer
	ops := appOps{t: t, create: func(ctx context.Context, p model.Principal, in core.CreateAppInput) (core.AppMetadata, error) {
		calls++
		deadline, ok := ctx.Deadline()
		if !ok || time.Until(deadline) <= 0 || time.Until(deadline) > appWriteBudget || p.UserID != userID || p.Kind != model.PATCredential || in.ID != appID || in.Name != " Example " || in.GitHubAppID != 9007199254740993 || in.PrivateKeyPEM != "private-key" || in.WebhookSecret != " webhook secret " || in.ExpectedUserID != userID {
			t.Fatalf("input=%+v principal=%+v deadline=%v", in, p, deadline)
		}
		return appMetadata(), nil
	}}
	h := appMux(t, ops, &logs)
	r := appRequest("POST", appPath, appBody)
	r.Host = "attacker.example"
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	var got api.GitHubApp
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if calls != 1 || w.Code != 201 || w.Header().Get("Location") != appPath+"/"+appID || w.Header().Get("Cache-Control") != "no-store" || w.Header().Get("Daynight-User-ID") != userID || got.GitHubAppID != "9007199254740993" || got.Version != "9223372036854775807" || got.Administrators != "2" || got.AuthorizedTeams != "3" || got.ConnectedProjects != "4" || got.WebhookURL != "https://daynight.example"+appPath+"/"+appID+"/webhook" || got.CreatedAt.Location() != time.UTC {
		t.Fatalf("status=%d header=%v body=%s", w.Code, w.Header(), w.Body)
	}
	if strings.Contains(w.Body.String(), "private-key") || strings.Contains(w.Body.String(), "webhook secret") || strings.Contains(logs.String(), "private-key") || strings.Contains(logs.String(), "webhook secret") {
		t.Fatal("secret exposed")
	}
}
func TestAppListGetProtocol(t *testing.T) {
	calls := 0
	next := "next-cursor"
	h := appMux(t, appOps{t: t, list: func(_ context.Context, p model.Principal, in core.ListAppsInput) (core.AppPage, error) {
		calls++
		if p.UserID != userID || (calls == 1 && (in.Limit != 25 || in.Cursor != "")) || (calls == 2 && (in.Limit != 100 || in.Cursor != "opaque")) {
			t.Fatalf("list: %+v %+v", p, in)
		}
		return core.AppPage{Items: []core.AppMetadata{appMetadata()}, NextCursor: &next}, nil
	}, get: func(_ context.Context, p model.Principal, id string) (core.AppMetadata, error) {
		calls++
		if p.UserID != userID || id != appID {
			t.Fatalf("get: %+v %s", p, id)
		}
		return appMetadata(), nil
	}}, io.Discard)
	for _, path := range []string{appPath, appPath + "?limit=100&cursor=opaque", appPath + "/" + strings.ToUpper(appID)} {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, appRequest("GET", path, ""))
		if w.Code != 200 || w.Header().Get("Cache-Control") != "no-store" || !strings.Contains(w.Body.String(), `"githubAppId":"9007199254740993"`) {
			t.Fatalf("%s: %d %s", path, w.Code, w.Body)
		}
	}
	if calls != 3 {
		t.Fatal(calls)
	}
}
func TestAppInputRefusalsAndAuthentication(t *testing.T) {
	h := appMux(t, appOps{t: t}, io.Discard)
	bad := []struct {
		method, path, body string
		status             int
	}{
		{"POST", appPath, `{`, 400},
		{"POST", appPath, strings.Replace(appBody, `"name":" Example "`, `"name":"\ud800"`, 1), 400},
		{"POST", appPath, strings.Replace(appBody, `"name":" Example "`, `"name":"\u2003"`, 1), 400},
		{"POST", appPath, strings.Replace(appBody, `"name":" Example "`, `"name":"\u0000"`, 1), 400},
		{"POST", appPath, strings.Replace(appBody, `"githubAppId":"9007199254740993"`, `"githubAppId":"01"`, 1), 400},
		{"POST", appPath, strings.Replace(appBody, `"privateKeyPem":"private-key"`, `"privateKeyPem":null`, 1), 400},
		{"POST", appPath, strings.Replace(appBody, `"webhookSecret":" webhook secret "`, `"webhookSecret":""`, 1), 400},
		{"POST", appPath, strings.Replace(appBody, `"webhookSecret":" webhook secret "`, `"webhookSecret":"`+strings.Repeat("a", 4097)+`"`, 1), 400},
		{"POST", appPath, strings.Replace(appBody, `"privateKeyPem":"private-key"`, `"privateKeyPem":"`+strings.Repeat("a", 65537)+`"`, 1), 400},
		{"POST", appPath, strings.TrimSuffix(appBody, "}") + `,"extra":true}`, 400},
		{"POST", appPath, strings.TrimSuffix(appBody, "}") + `,"name":"again"}`, 400},
		{"POST", appPath, strings.Repeat(" ", appWriteBytes+1), 413},
		{"POST", appPath + "?extra=1", appBody, 400},
		{"GET", appPath + "?limit=101", "", 400},
		{"GET", appPath + "?limit=01", "", 400},
		{"GET", appPath + "?limit=1&limit=2", "", 400},
		{"GET", appPath + "/wrong", "", 400},
		{"GET", appPath + "/" + appID + "?x=1", "", 400},
		{"PATCH", appPath + "/" + appID, "", 405},
	}
	for _, tc := range bad {
		t.Run(tc.method+tc.path+strconvTestName(tc.body), func(t *testing.T) {
			w := httptest.NewRecorder()
			h.ServeHTTP(w, appRequest(tc.method, tc.path, tc.body))
			if w.Code != tc.status {
				t.Fatalf("status=%d expected=%d body=%s", w.Code, tc.status, w.Body)
			}
		})
	}
	r := appRequest("POST", appPath, appBody)
	r.Header.Del("Authorization")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 401 {
		t.Fatalf("unauthenticated: %d %s", w.Code, w.Body)
	}
}
func strconvTestName(s string) string {
	if len(s) > 40 {
		return s[:40]
	}
	return s
}
func TestAppErrorsAndDeadline(t *testing.T) {
	for _, tc := range []struct {
		err    error
		code   string
		status int
	}{
		{&service.ManagementError{Code: "github_app_already_registered", Message: "registered"}, "github_app_already_registered", 409},
		{&service.ManagementError{Code: "github_app_id_conflict", Message: "ID used"}, "github_app_id_conflict", 409},
		{&service.ManagementError{Code: "github_app_credentials_invalid", Message: "invalid credentials"}, "github_app_credentials_invalid", 422},
		{&service.ManagementError{Code: "github_unavailable", Message: "unavailable"}, "github_unavailable", 502},
		{&service.ManagementError{Code: "github_write_outcome_unknown", Message: "unknown"}, "github_write_outcome_unknown", 503},
		{&model.Fault{Code: "not_found", Message: "not found"}, "not_found", 404},
	} {
		t.Run(tc.code, func(t *testing.T) {
			calls := 0
			h := appMux(t, appOps{t: t, create: func(context.Context, model.Principal, core.CreateAppInput) (core.AppMetadata, error) {
				calls++
				return core.AppMetadata{}, tc.err
			}}, io.Discard)
			w := httptest.NewRecorder()
			h.ServeHTTP(w, appRequest("POST", appPath, appBody))
			if w.Code != tc.status || calls != 1 || !strings.Contains(w.Body.String(), `"code":"`+tc.code+`"`) {
				t.Fatalf("%d %s calls %d", w.Code, w.Body, calls)
			}
			if tc.code == "github_write_outcome_unknown" && !strings.Contains(w.Body.String(), `"writeOutcome":"unknown"`) {
				t.Fatal(w.Body)
			}
		})
	}
	deadline := time.Now().Add(2 * time.Second)
	ctx, cancel := context.WithDeadline(context.Background(), deadline)
	defer cancel()
	h := appMux(t, appOps{t: t, create: func(ctx context.Context, _ model.Principal, _ core.CreateAppInput) (core.AppMetadata, error) {
		if got, ok := ctx.Deadline(); !ok || !got.Equal(deadline) {
			t.Fatalf("deadline: %v", got)
		}
		return core.AppMetadata{}, errors.New("failure")
	}}, io.Discard)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, appRequest("POST", appPath, appBody).WithContext(ctx))
	if w.Code != 500 {
		t.Fatal(w.Code)
	}
}

type appShortWriter struct {
	header         http.Header
	status, writes int
}

func (w *appShortWriter) Header() http.Header         { return w.header }
func (w *appShortWriter) WriteHeader(status int)      { w.status = status }
func (w *appShortWriter) Write(p []byte) (int, error) { w.writes++; return len(p) / 2, nil }

func TestAppCreateResponseFailureAndCancellation(t *testing.T) {
	var logs bytes.Buffer
	calls := 0
	h := appMux(t, appOps{t: t, create: func(context.Context, model.Principal, core.CreateAppInput) (core.AppMetadata, error) {
		calls++
		return appMetadata(), nil
	}}, &logs)
	w := &appShortWriter{header: make(http.Header)}
	h.ServeHTTP(w, appRequest("POST", appPath, appBody))
	if calls != 1 || w.status != 201 || w.writes != 1 || !strings.Contains(logs.String(), "write_outcome_unknown") || strings.Contains(logs.String(), "private-key") {
		t.Fatalf("calls=%d status=%d writes=%d logs=%s", calls, w.status, w.writes, logs.String())
	}

	started := make(chan struct{})
	finished := make(chan struct{})
	h = appMux(t, appOps{t: t, create: func(ctx context.Context, _ model.Principal, _ core.CreateAppInput) (core.AppMetadata, error) {
		close(started)
		<-ctx.Done()
		return core.AppMetadata{}, ctx.Err()
	}}, io.Discard)
	ctx, cancel := context.WithCancel(context.Background())
	recorder := httptest.NewRecorder()
	go func() {
		defer close(finished)
		h.ServeHTTP(recorder, appRequest("POST", appPath, appBody).WithContext(ctx))
	}()
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("operation did not start")
	}
	cancel()
	select {
	case <-finished:
	case <-time.After(time.Second):
		t.Fatal("operation did not exit")
	}
	if recorder.Body.Len() != 0 {
		t.Fatalf("canceled response: %s", recorder.Body)
	}
}

func TestAppCreateCancelledAfterCommitHasNoLocation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	var logs bytes.Buffer
	calls := 0
	h := appMux(t, appOps{t: t, create: func(context.Context, model.Principal, core.CreateAppInput) (core.AppMetadata, error) {
		calls++
		cancel()
		return appMetadata(), nil
	}}, &logs)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, appRequest("POST", appPath, appBody).WithContext(ctx))
	if calls != 1 || w.Header().Get("Location") != "" || w.Body.Len() != 0 || !strings.Contains(logs.String(), "write_outcome_unknown") {
		t.Fatalf("calls=%d headers=%v body=%s logs=%s", calls, w.Header(), w.Body, logs.String())
	}
}

func TestAppCreateEncodingFailureHasNoLocation(t *testing.T) {
	var logs bytes.Buffer
	h := appMux(t, appOps{t: t, create: func(context.Context, model.Principal, core.CreateAppInput) (core.AppMetadata, error) {
		v := appMetadata()
		v.CreatedAt = time.Date(10000, 1, 1, 0, 0, 0, 0, time.UTC)
		return v, nil
	}}, &logs)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, appRequest("POST", appPath, appBody))
	if w.Code != http.StatusServiceUnavailable || w.Header().Get("Location") != "" || !strings.Contains(w.Body.String(), "write_outcome_unknown") {
		t.Fatalf("status=%d headers=%v body=%s", w.Code, w.Header(), w.Body)
	}
}

// appHiddenStore exercises the real manager's read callback without simulating persistence.
type appHiddenStore struct {
	t           *testing.T
	reads, gets int
}

func (s *appHiddenStore) WriteGitHubApp(context.Context, func(store.GitHubAppWriteDAO) error) (store.Completion, error) {
	s.t.Fatal("unexpected write")
	return store.Completion{}, nil
}
func (s *appHiddenStore) ReadGitHubApps(ctx context.Context, f func(store.GitHubAppReadDAO) error) error {
	s.reads++
	if deadline, ok := ctx.Deadline(); !ok || time.Until(deadline) <= 0 || time.Until(deadline) > core.OperationTimeout {
		s.t.Fatalf("read deadline: %v", deadline)
	}
	return f(s)
}
func (s *appHiddenStore) Get(_ context.Context, id, actor string) (githubpr.AppMetadata, error) {
	s.gets++
	if id != appID || actor != userID {
		s.t.Fatalf("get id=%s actor=%s", id, actor)
	}
	return githubpr.AppMetadata{}, model.ErrNotFound
}
func (s *appHiddenStore) List(context.Context, store.GitHubAppQuery) (store.GitHubAppPage, error) {
	s.t.Fatal("unexpected list")
	return store.GitHubAppPage{}, nil
}
func TestAppGetHiddenForNonAdministrator(t *testing.T) {
	db := &appHiddenStore{t: t}
	h := appMux(t, service.NewAppManager(db), io.Discard)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, appRequest(http.MethodGet, appPath+"/"+appID, ""))
	var result api.ErrorResponse
	if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if db.reads != 1 || db.gets != 1 || w.Code != http.StatusNotFound || result.Error.Code != "not_found" || w.Header().Get("Cache-Control") != "no-store" || strings.Contains(w.Body.String(), appID) || strings.Contains(w.Body.String(), "githubAppId") || strings.Contains(w.Body.String(), "webhookUrl") {
		t.Fatalf("reads=%d gets=%d status=%d headers=%v body=%s", db.reads, db.gets, w.Code, w.Header(), w.Body)
	}
}

type appCancelAfterHeader struct {
	*httptest.ResponseRecorder
	cancel context.CancelFunc
	writes int
}

func (w *appCancelAfterHeader) WriteHeader(status int) {
	w.ResponseRecorder.WriteHeader(status)
	w.cancel()
}

func (w *appCancelAfterHeader) Write(data []byte) (int, error) {
	w.writes++
	return w.ResponseRecorder.Write(data)
}

func TestAppCreateCancelledAfterResponseHeader(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var logs bytes.Buffer
	calls := 0
	h := appMux(t, appOps{t: t, create: func(context.Context, model.Principal, core.CreateAppInput) (core.AppMetadata, error) {
		calls++
		return appMetadata(), nil
	}}, &logs)
	w := &appCancelAfterHeader{ResponseRecorder: httptest.NewRecorder(), cancel: cancel}
	h.ServeHTTP(w, appRequest(http.MethodPost, appPath, appBody).WithContext(ctx))
	if calls != 1 || w.Code != http.StatusCreated || w.writes != 0 || w.Body.Len() != 0 || !strings.Contains(logs.String(), "write_outcome_unknown") {
		t.Fatalf("calls=%d status=%d writes=%d body=%s logs=%s", calls, w.Code, w.writes, w.Body, logs.String())
	}
}
