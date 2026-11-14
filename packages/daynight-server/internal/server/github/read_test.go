package github

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	coregithub "github.com/codetreker/daynight/packages/daynight-server/internal/core/github"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/githubpr"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
)

const projectID = "11111111-1111-4111-8111-111111111111"
const userID = "22222222-2222-4222-8222-222222222222"

type authStub struct{}

func (authStub) Require(f httpx.AuthenticatedHandler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Daynight-User-ID", userID)
		f(w, r, model.Principal{UserID: userID})
	}
}

type readerStub struct {
	calls  int
	input  coregithub.ListRequest
	number int64
	id     string
	ctx    context.Context
	status coregithub.Status
	page   coregithub.Page
	detail coregithub.Detail
	err    error
}

func (s *readerStub) Get(ctx context.Context, p model.Principal, id string) (coregithub.Status, error) {
	s.calls++
	s.id = id
	s.ctx = ctx
	return s.status, s.err
}
func (s *readerStub) List(ctx context.Context, p model.Principal, id string, in coregithub.ListRequest) (coregithub.Page, error) {
	s.calls++
	s.id = id
	s.ctx = ctx
	s.input = in
	return s.page, s.err
}
func (s *readerStub) Detail(ctx context.Context, p model.Principal, id string, n int64) (coregithub.Detail, error) {
	s.calls++
	s.id = id
	s.ctx = ctx
	s.number = n
	return s.detail, s.err
}
func newMux(s *readerStub) *http.ServeMux {
	m := http.NewServeMux()
	RegisterReadRoutes(m, s, authStub{}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	return m
}
func call(m *http.ServeMux, method, path string) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	m.ServeHTTP(w, httptest.NewRequest(method, path, nil))
	return w
}
func pointer[T any](v T) *T { return &v }
func fixture() (githubpr.Connection, githubpr.PullRequestSummary) {
	t := time.Date(2026, 1, 1, 4, 0, 0, 123, time.FixedZone("x", 3600))
	return githubpr.Connection{ProjectID: projectID, Version: 9007199254740993, Revision: 9, Generation: 3, Enabled: true, SyncEnabled: true, InstallationID: pointer(int64(43)), InstallationAccountLogin: pointer("owner"), RepositoryID: pointer(int64(9007199254740995)), RepositoryFullName: pointer("owner/repo"), RepositoryPrivate: pointer(true), PollIntervalMinutes: 5, AccessState: "available", ClaimKind: pointer("poll"), LastFullGeneration: pointer(int64(2)), LastPollAttemptAt: &t, PollErrorCode: pointer("failure"), PollErrorMessage: pointer("failed"), PollErrorAt: &t}, githubpr.PullRequestSummary{Number: 9007199254740993, GitHubID: 9007199254740994, Title: "title", URL: "https://example.test", State: "open", BaseRef: "main", HeadSHA: "abc", GitHubCreatedAt: t, GitHubUpdatedAt: t, ObservedAt: t, Revision: 9}
}
func TestReadResponses(t *testing.T) {
	c, pr := fixture()
	s := &readerStub{status: coregithub.Status{Connection: c, ServiceAvailable: false}, page: coregithub.Page{Connection: c, Items: []githubpr.PullRequestSummary{pr}, Total: 1, Counts: store.GitHubPRCounts{Active: 1, All: 1}}, detail: coregithub.Detail{Connection: c, PullRequest: githubpr.PullRequest{PullRequestSummary: pr, Description: pointer("")}}}
	m := newMux(s)
	w := call(m, "GET", "/api/v1/projects/"+projectID+"/github")
	var status api.GitHubStatus
	if e := json.Unmarshal(w.Body.Bytes(), &status); e != nil || w.Code != 200 {
		t.Fatalf("status %d %s %v", w.Code, w.Body, e)
	}
	if status.Version != "9007199254740993" || status.Connection != "connected" || status.ServiceAvailable || !status.Initializing || !status.Poll.Running || status.Poll.Error == nil || status.Webhook.Error != nil || status.Repository.ID != "9007199254740995" || status.Poll.LastAttemptAt.Location() != time.UTC {
		t.Fatalf("status: %+v", status)
	}
	w = call(m, "GET", "/api/v1/projects/"+projectID+"/pull-requests?state=all&q=%23hello&limit=6&cursor=token")
	var page api.PullRequestPage
	if e := json.Unmarshal(w.Body.Bytes(), &page); e != nil || w.Code != 200 {
		t.Fatalf("page %d %s %v", w.Code, w.Body, e)
	}
	if s.input.State != "all" || s.input.Query != "#hello" || s.input.Limit != 6 || s.input.Cursor != "token" || page.Total != "1" || page.Counts.Active != "1" || page.Items[0].Number != "9007199254740993" || page.Items[0].Author != nil || page.Items[0].Head.RepositoryID != nil || strings.Contains(w.Body.String(), "description") {
		t.Fatalf("page %s input %+v", w.Body, s.input)
	}
	w = call(m, "GET", "/api/v1/projects/"+projectID+"/pull-requests/9007199254740993")
	if w.Code != 200 || s.number != 9007199254740993 || !strings.Contains(w.Body.String(), `"description":""`) {
		t.Fatalf("detail %d %s", w.Code, w.Body)
	}
	if w.Header().Get("Daynight-User-ID") != userID || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatal(w.Header())
	}
	s.page.Items = nil
	w = call(m, "GET", "/api/v1/projects/"+projectID+"/pull-requests?q=")
	if s.input.State != "active" || s.input.Limit != 20 || !strings.Contains(w.Body.String(), `"items":[]`) || !strings.Contains(w.Body.String(), `"nextCursor":null`) {
		t.Fatalf("empty %s %+v", w.Body, s.input)
	}
}
func TestProtocolRejectsBeforeReading(t *testing.T) {
	s := &readerStub{}
	m := newMux(s)
	base := "/api/v1/projects/" + projectID
	for _, path := range []string{base + "/github?x=1", base + "/pull-requests?state=bad", base + "/pull-requests?state=", base + "/pull-requests?limit=0", base + "/pull-requests?limit=101", base + "/pull-requests?limit=x", base + "/pull-requests?limit=01", base + "/pull-requests?q=%00", base + "/pull-requests?q=" + strings.Repeat("a", 1025), base + "/pull-requests?cursor=", base + "/pull-requests?state=all&state=all", base + "/pull-requests?other=x", base + "/pull-requests?q=%FF", base + "/pull-requests?q=%GG", base + "/pull-requests/0", base + "/pull-requests/01", base + "/pull-requests/-1", base + "/pull-requests/9223372036854775808", "/api/v1/projects/invalid/github"} {
		w := call(m, "GET", path)
		if w.Code != 400 || s.calls != 0 {
			t.Errorf("%q: %d %s calls %d", path, w.Code, w.Body, s.calls)
		}
	}
	w := call(m, "GET", base+"/pull-requests?q="+strings.Repeat("a", 70000))
	if w.Code != http.StatusRequestURITooLong || s.calls != 0 {
		t.Fatalf("long query: %d", w.Code)
	}
	w = call(m, "POST", base+"/github")
	if w.Code != 405 || w.Header().Get("Allow") != "GET, HEAD" || s.calls != 0 {
		t.Fatalf("method %d %v", w.Code, w.Header())
	}
}
func TestErrorsAndProjection(t *testing.T) {
	c, pr := fixture()
	s := &readerStub{err: &model.Fault{Code: "not_found", Message: "not found"}}
	m := newMux(s)
	w := call(m, "GET", "/api/v1/projects/"+projectID+"/pull-requests/5")
	if w.Code != 404 || s.calls != 1 {
		t.Fatalf("error %d %s", w.Code, w.Body)
	}
	s.err = errors.New("database failure")
	w = call(m, "GET", "/api/v1/projects/"+projectID+"/github")
	if w.Code != 500 || strings.Contains(w.Body.String(), "database failure") {
		t.Fatal(w.Body)
	}
	for _, tc := range []struct {
		c    githubpr.Connection
		want string
	}{{githubpr.DefaultConnection(projectID), "not_connected"}, {func() githubpr.Connection { x := c; x.Enabled = false; return x }(), "disconnected"}, {func() githubpr.Connection { x := c; x.AccessState = "unavailable"; return x }(), "unavailable"}} {
		got, err := statusResponse(coregithub.Status{Connection: tc.c})
		if err != nil || got.Connection != tc.want {
			t.Fatalf("connection %+v %v", got, err)
		}
	}
	c.LastFullGeneration = &c.Generation
	c.ClaimKind = pointer("webhook")
	c.PollErrorCode = nil
	c.PollErrorMessage = nil
	c.PollErrorAt = nil
	got, err := statusResponse(coregithub.Status{Connection: c})
	if err != nil || got.Initializing || got.Poll.Running || !got.Webhook.Running {
		t.Fatalf("state %+v %v", got, err)
	}
	for _, broken := range []githubpr.Connection{func() githubpr.Connection { x := c; x.InstallationAccountLogin = nil; return x }(), func() githubpr.Connection { x := c; x.RepositoryFullName = nil; return x }(), func() githubpr.Connection { x := c; x.WebhookErrorCode = pointer("x"); return x }()} {
		if _, err := statusResponse(coregithub.Status{Connection: broken}); err == nil {
			t.Fatal("accepted incomplete state")
		}
	}
	pr.AuthorID = pointer(int64(3))
	if _, err := summaryResponse(c, pr); err == nil {
		t.Fatal("accepted incomplete author")
	}
	pr.AuthorLogin = pointer("name")
	pr.HeadRepositoryID = pointer(int64(4))
	out, err := summaryResponse(c, pr)
	if err != nil || out.Author.ID != "3" || *out.Head.RepositoryID != "4" {
		t.Fatal(out, err)
	}
	c.RepositoryID = nil
	if _, err := summaryResponse(c, pr); err == nil {
		t.Fatal("accepted missing base")
	}
	if _, err := pageResponse(coregithub.Page{Connection: c, Items: []githubpr.PullRequestSummary{pr}}); err == nil {
		t.Fatal("accepted missing base page")
	}
}

type blockingReader struct {
	readerStub
	started chan struct{}
	stopped chan struct{}
}

func (s *blockingReader) Get(ctx context.Context, p model.Principal, id string) (coregithub.Status, error) {
	close(s.started)
	<-ctx.Done()
	close(s.stopped)
	return coregithub.Status{}, ctx.Err()
}
func TestCancellationReachesRead(t *testing.T) {
	reader := &blockingReader{started: make(chan struct{}), stopped: make(chan struct{})}
	mux := http.NewServeMux()
	RegisterReadRoutes(mux, reader, authStub{}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	ctx, cancel := context.WithCancel(context.Background())
	req := httptest.NewRequest("GET", "/api/v1/projects/"+projectID+"/github", nil).WithContext(ctx)
	w := httptest.NewRecorder()
	finished := make(chan struct{})
	go func() { mux.ServeHTTP(w, req); close(finished) }()
	select {
	case <-reader.started:
	case <-time.After(time.Second):
		t.Fatal("read did not start")
	}
	cancel()
	select {
	case <-reader.stopped:
	case <-time.After(time.Second):
		t.Fatal("read did not receive cancellation")
	}
	select {
	case <-finished:
	case <-time.After(time.Second):
		t.Fatal("handler did not return")
	}
	if w.Body.Len() != 0 {
		t.Fatalf("cancelled response: %s", w.Body)
	}
}

func TestNextAttemptReflectsPersistedSchedule(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	earlier, later := now.Add(time.Minute), now.Add(5*time.Minute)
	for _, tc := range []struct {
		name                          string
		state                         string
		poll, access, notBefore, want *time.Time
	}{
		{"poll", "available", &earlier, &later, nil, &earlier},
		{"access recovery", "unavailable", &earlier, &later, nil, &later},
		{"limit after poll", "available", &earlier, nil, &later, &later},
		{"limit before recovery", "unavailable", nil, &later, &earlier, &later},
		{"limit does not schedule", "available", nil, &earlier, &later, nil},
		{"recovery without schedule", "unavailable", &earlier, nil, &later, nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c := githubpr.Connection{SyncEnabled: true, AccessState: tc.state, NextPollAt: tc.poll, NextAccessCheckAt: tc.access, NotBefore: tc.notBefore}
			got := nextAttempt(c)
			if (got == nil) != (tc.want == nil) || (got != nil && !got.Equal(*tc.want)) {
				t.Fatalf("got %v, want %v", got, tc.want)
			}
		})
	}
}

func TestDisabledSyncStatusRetainsHistory(t *testing.T) {
	c, _ := fixture()
	c.SyncEnabled = false
	now := time.Now()
	c.NextPollAt = &now
	got, err := statusResponse(coregithub.Status{Connection: c})
	if err != nil || got.SyncEnabled || got.Initializing || got.Poll.Running || got.Webhook.Running || got.Poll.NextAttemptAt != nil || got.Poll.LastAttemptAt == nil || got.Poll.Error == nil {
		t.Fatalf("disabled status: %+v, %v", got, err)
	}
}

func TestUnknownRepositoryVisibility(t *testing.T) {
	c, _ := fixture()
	c.RepositoryPrivate = nil
	s := &readerStub{status: coregithub.Status{Connection: c}}
	w := call(newMux(s), "GET", "/api/v1/projects/"+projectID+"/github")
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"private":null`) {
		t.Fatalf("status %d: %s", w.Code, w.Body)
	}
}
