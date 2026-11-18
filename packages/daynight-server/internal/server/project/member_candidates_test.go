package project

import (
	"bytes"
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
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/oauth"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	authhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"
	authconfig "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth/config"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
)

const candidateActor = "10000000-0000-4000-8000-000000000001"
const candidateTarget = "10000000-0000-4000-8000-000000000002"
const candidateProject = "20000000-0000-4000-8000-000000000001"

type candidateOperations struct {
	MembershipOperations
	search func(context.Context, model.Principal, string, core.CandidateSearchInput) (core.CandidatePage, error)
}

func (o candidateOperations) SearchMemberCandidates(ctx context.Context, p model.Principal, id string, input core.CandidateSearchInput) (core.CandidatePage, error) {
	return o.search(ctx, p, id, input)
}

func candidateHTTP(t *testing.T, op candidateOperations, logger *slog.Logger) http.Handler {
	t.Helper()
	auth, err := authhttp.NewRequestAuthentication(func(_ context.Context, kind model.CredentialKind, value string) (model.Principal, error) {
		if value != "valid" {
			return model.Principal{}, authhttp.Failure()
		}
		return model.Principal{UserID: candidateActor, CredentialID: candidateTarget, Kind: kind}, nil
	}, authconfig.AuthSettings{PublicOrigin: "https://daynight.example"}, logger)
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	NewMembershipRoutes(op, auth, logger).RegisterRoutes(mux)
	return httpx.RequestLogging(logger, mux)
}

const candidateBody = `{"expectedUserId":"` + candidateActor + `","query":"private-search","limit":7,"cursor":"private-cursor"}`

func candidateRequest(body string) *http.Request {
	r := httptest.NewRequest(http.MethodPost, "/api/v1/projects/"+candidateProject+"/member-candidates/search", strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Authorization", "Bearer valid")
	r.Header.Set("X-Request-ID", "project-test")
	return r
}

func TestCandidateSearchProtocolAndCapacity(t *testing.T) {
	name, email, avatar, cursor := "Private Same name", "private-profile@example.test", strings.Repeat("<", 512*1024), "next"
	var logs bytes.Buffer
	calls := 0
	op := candidateOperations{search: func(ctx context.Context, p model.Principal, id string, input core.CandidateSearchInput) (core.CandidatePage, error) {
		calls++
		if p.UserID != candidateActor || p.CredentialID != candidateTarget || p.Kind != model.PATCredential || id != candidateProject || input.ExpectedUserID != candidateActor || input.Query != "private-search" || input.Limit == nil || *input.Limit != 7 || input.Cursor == nil || *input.Cursor != "private-cursor" {
			t.Fatalf("principal=%+v id=%q input=%+v", p, id, input)
		}
		return core.CandidatePage{Items: []model.UserCandidate{{UserID: candidateTarget, Profile: model.ProjectParticipantProfile{Name: &name, Email: &email, AvatarURL: &avatar}}, {UserID: candidateActor}}, NextCursor: &cursor}, nil
	}}
	h := candidateHTTP(t, op, slog.New(slog.NewJSONHandler(&logs, nil)))
	w := httptest.NewRecorder()
	h.ServeHTTP(w, candidateRequest(candidateBody))
	var page api.ProjectMemberCandidatePage
	if err := json.Unmarshal(w.Body.Bytes(), &page); err != nil {
		t.Fatal(err)
	}
	if calls != 1 || w.Code != 200 || w.Header().Get("Cache-Control") != "no-store" || w.Header().Get("Daynight-User-ID") != candidateActor || page.ActorRole != "admin" || page.NextCursor == nil || *page.NextCursor != cursor || len(page.Items) != 2 || page.Items[0].UserID != candidateTarget || page.Items[0].Profile.Email == nil || *page.Items[0].Profile.Email != email || page.Items[0].Profile.AvatarURL == nil || *page.Items[0].Profile.AvatarURL != avatar || page.Items[1].Profile.Name != nil || page.Items[1].Profile.Email != nil || page.Items[1].Profile.AvatarURL != nil {
		t.Fatalf("calls=%d status=%d headers=%v page=%+v", calls, w.Code, w.Header(), page)
	}
	if !strings.Contains(w.Body.String(), `"email":null`) || strings.Contains(w.Body.String(), "private-search") || strings.Contains(w.Body.String(), "private-cursor") {
		t.Fatal("response contains unexpected fields")
	}
	for _, sensitive := range []string{name, email, avatar, "private-search", "private-cursor"} {
		if strings.Contains(logs.String(), sensitive) {
			t.Fatalf("sensitive candidate data appeared in logs: %s", logs.String())
		}
	}
}

func TestCandidateSearchRejectsMalformedRequests(t *testing.T) {
	cases := []struct{ body, query, media string }{
		{`{}`, "", "application/json"},
		{`{"expectedUserId":"` + candidateActor + `"}`, "", "application/json"},
		{`{"expectedUserId":null,"query":"x"}`, "", "application/json"},
		{`{"expectedUserId":"` + candidateActor + `","query":null}`, "", "application/json"},
		{`{"expectedUserId":"` + candidateActor + `","query":"x","limit":null}`, "", "application/json"},
		{`{"expectedUserId":"` + candidateActor + `","query":"x","limit":1.0}`, "", "application/json"},
		{`{"expectedUserId":"` + candidateActor + `","query":"x","cursor":null}`, "", "application/json"},
		{`{"expectedUserId":"` + candidateActor + `","query":"x","query":"secret"}`, "", "application/json"},
		{`{"expectedUserId":"` + candidateActor + `","query":"x","unknown":true}`, "", "application/json"},
		{`{"expectedUserId":"` + candidateActor + `","query":"\ud800"}`, "", "application/json"},
		{candidateBody, "extra=private-search", "application/json"},
		{candidateBody, "", "text/plain"},
		{strings.Repeat(" ", 1<<20) + candidateBody, "", "application/json"},
	}
	for _, tc := range cases {
		calls := 0
		var logs bytes.Buffer
		h := candidateHTTP(t, candidateOperations{search: func(context.Context, model.Principal, string, core.CandidateSearchInput) (core.CandidatePage, error) {
			calls++
			return core.CandidatePage{}, nil
		}}, slog.New(slog.NewJSONHandler(&logs, nil)))
		r := candidateRequest(tc.body)
		r.URL.RawQuery = tc.query
		r.Header.Set("Content-Type", tc.media)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		status, code := 400, "invalid_input"
		if len(tc.body) > 1<<20 {
			status, code = 413, "payload_too_large"
		}
		assertProjectError(t, w, status, code)
		if calls != 0 || w.Header().Get("Cache-Control") != "no-store" || strings.Contains(w.Body.String()+logs.String(), "private-search") || strings.Contains(w.Body.String()+logs.String(), "private-cursor") {
			t.Fatalf("calls=%d body=%s logs=%s", calls, w.Body.String(), logs.String())
		}
	}
}

func TestCandidateSearchErrorRedactionAndMethods(t *testing.T) {
	for _, tc := range []struct {
		err    error
		status int
		code   string
	}{
		{&model.Fault{Code: "forbidden", Message: "forbidden"}, 403, "forbidden"},
		{&model.Fault{Code: "identity_mismatch", Message: "mismatch"}, 409, "identity_mismatch"},
		{model.Unauthenticated(model.ErrNotFound), 401, "unauthenticated"},
		{&model.Fault{Code: "not_found", Message: "Project was not found."}, 404, "not_found"},
		{&store.Error{DatabaseFailure: true, Cause: errors.New("private-search private-cursor")}, 500, "internal_error"},
		{&store.TransactionError{Phase: "cleanup", Outcome: store.TransactionUnknown, CleanupFailed: true, Cause: errors.New("private-search private-cursor")}, 500, "internal_error"},
	} {
		var logs bytes.Buffer
		h := candidateHTTP(t, candidateOperations{search: func(context.Context, model.Principal, string, core.CandidateSearchInput) (core.CandidatePage, error) {
			name := "private-profile-name"
			return core.CandidatePage{Items: []model.UserCandidate{{UserID: candidateTarget, Profile: model.ProjectParticipantProfile{Name: &name}}}}, tc.err
		}}, slog.New(slog.NewJSONHandler(&logs, nil)))
		w := httptest.NewRecorder()
		h.ServeHTTP(w, candidateRequest(candidateBody))
		assertProjectError(t, w, tc.status, tc.code)
		if strings.Contains(logs.String()+w.Body.String(), "private-search") || strings.Contains(logs.String()+w.Body.String(), "private-cursor") || strings.Contains(logs.String()+w.Body.String(), "private-profile-name") || !strings.Contains(logs.String(), `"component":"member_candidate_search"`) || !strings.Contains(logs.String(), `"phase":"search"`) {
			t.Fatalf("body=%s logs=%s", w.Body.String(), logs.String())
		}
	}
	h := candidateHTTP(t, candidateOperations{}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	for _, method := range []string{"GET", "HEAD", "PATCH", "DELETE", "PUT", "OPTIONS"} {
		r := candidateRequest(candidateBody)
		r.Method = method
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != http.StatusMethodNotAllowed || w.Header().Get("Allow") != "POST" || w.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("method=%s status=%d headers=%v", method, w.Code, w.Header())
		}
	}
}

type candidateFailingWriter struct{ *httptest.ResponseRecorder }

func (w candidateFailingWriter) Write([]byte) (int, error) {
	return 0, &httpx.RuntimeError{Component: "private-component", Phase: "private-phase", Cause: &store.Error{DatabaseFailure: true, Phase: "private-query private-cursor"}}
}

func TestCandidateSearchResponseFailureAndRuntimeDiagnosticsAreRedacted(t *testing.T) {
	for _, tc := range []struct {
		name         string
		body         string
		operationErr error
	}{
		{"success-response", candidateBody, nil},
		{"error-response", candidateBody, &httpx.RuntimeError{Component: "private-component", Phase: "private-phase", Cause: &store.Error{DatabaseFailure: true, Phase: "private-query private-cursor"}}},
		{"body-error-response", strings.Repeat(" ", 1<<20) + candidateBody, nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var logs bytes.Buffer
			h := candidateHTTP(t, candidateOperations{search: func(context.Context, model.Principal, string, core.CandidateSearchInput) (core.CandidatePage, error) {
				return core.CandidatePage{}, tc.operationErr
			}}, slog.New(slog.NewJSONHandler(&logs, nil)))
			w := candidateFailingWriter{httptest.NewRecorder()}
			h.ServeHTTP(w, candidateRequest(tc.body))
			for _, secret := range []string{"private-component", "private-phase", "private-query", "private-cursor", "private-search"} {
				if strings.Contains(logs.String(), secret) {
					t.Fatalf("leaked %q in logs: %s", secret, logs.String())
				}
			}
			if !strings.Contains(logs.String(), `"component":"member_candidate_search"`) || !strings.Contains(logs.String(), `"phase":"response"`) {
				t.Fatalf("missing response classification: %s", logs.String())
			}
		})
	}
}

func TestCandidateSearchAuthenticationRejectsBeforeDirectoryOperation(t *testing.T) {
	for _, test := range []struct {
		name   string
		change func(*http.Request)
		status int
		code   string
	}{
		{"missing", func(r *http.Request) { r.Header.Del("Authorization") }, 401, "unauthenticated"},
		{"invalid", func(r *http.Request) { r.Header.Set("Authorization", "Bearer revoked") }, 401, "unauthenticated"},
		{"cookie-origin", func(r *http.Request) {
			r.Header.Del("Authorization")
			r.AddCookie(&http.Cookie{Name: "__Host-daynight_session", Value: "valid"})
			r.Header.Set("Origin", "https://different.example")
		}, 403, "forbidden"},
	} {
		t.Run(test.name, func(t *testing.T) {
			calls := 0
			h := candidateHTTP(t, candidateOperations{search: func(context.Context, model.Principal, string, core.CandidateSearchInput) (core.CandidatePage, error) {
				calls++
				return core.CandidatePage{}, nil
			}}, slog.New(slog.NewTextHandler(io.Discard, nil)))
			r := candidateRequest(candidateBody)
			test.change(r)
			w := httptest.NewRecorder()
			h.ServeHTTP(w, r)
			assertProjectError(t, w, test.status, test.code)
			if calls != 0 || w.Header().Get("Daynight-User-ID") != "" || w.Header().Get("Cache-Control") != "no-store" {
				t.Fatalf("calls=%d headers=%v", calls, w.Header())
			}
		})
	}
}

func TestCandidateSearchUsesAPIAccessVerifier(t *testing.T) {
	for _, rejected := range []bool{false, true} {
		h := newHTTPHarness(t)
		h.Principal.Kind = model.OAuthCredential
		verified := 0
		h.Auth.BindAPIAccess(func(ctx context.Context, token string) (store.OAuthAccessIdentity, error) {
			verified++
			if ctx.Value(requestMarker{}) != h || token != oauth.APIAccessPrefix+"candidate-search" {
				t.Fatalf("verifier context=%v token=%q", ctx, token)
			}
			if rejected {
				return store.OAuthAccessIdentity{}, authhttp.Failure()
			}
			return store.OAuthAccessIdentity{Principal: h.Principal}, nil
		}, "https://application.example")
		h.Memberships.SearchMemberCandidatesFunc = func(_ context.Context, _ model.Principal, id string, input core.CandidateSearchInput) (core.CandidatePage, error) {
			if id != h.Project.ID || input.ExpectedUserID != h.Principal.UserID {
				t.Fatalf("id=%q input=%+v", id, input)
			}
			return core.CandidatePage{}, nil
		}
		r := h.request("POST", "/api/v1/projects/"+h.Project.ID+"/member-candidates/search", candidateBody)
		r.Header.Set("Authorization", "Bearer "+oauth.APIAccessPrefix+"candidate-search")
		w := httptest.NewRecorder()
		h.Handler.ServeHTTP(w, r)
		if verified != 1 {
			t.Fatalf("verifier calls=%d", verified)
		}
		if rejected {
			assertProjectError(t, w, 401, "unauthenticated")
			h.assertCalls(map[string]int{})
		} else {
			page := decodeResponse[api.ProjectMemberCandidatePage](t, w, 200)
			if page.Items == nil || page.NextCursor != nil || page.ActorRole != "admin" {
				t.Fatalf("empty page=%+v", page)
			}
			h.assertCalls(map[string]int{"SearchMemberCandidates": 1})
		}
	}
}

func TestCandidateSearchCancellationReachesOperation(t *testing.T) {
	started, finished := make(chan struct{}), make(chan struct{})
	h := candidateHTTP(t, candidateOperations{search: func(ctx context.Context, _ model.Principal, _ string, _ core.CandidateSearchInput) (core.CandidatePage, error) {
		close(started)
		<-ctx.Done()
		return core.CandidatePage{}, ctx.Err()
	}}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	r := candidateRequest(candidateBody).WithContext(ctx)
	w := httptest.NewRecorder()
	go func() {
		defer close(finished)
		h.ServeHTTP(w, r)
	}()
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("search operation did not start")
	}
	cancel()
	select {
	case <-finished:
	case <-time.After(5 * time.Second):
		t.Fatal("search operation did not exit after cancellation")
	}
	if w.Body.Len() != 0 {
		t.Fatalf("canceled search published a response: %s", w.Body.String())
	}
}
