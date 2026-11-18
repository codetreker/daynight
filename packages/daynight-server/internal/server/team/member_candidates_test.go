package team

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

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/team"
	authhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"
	authconfig "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth/config"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
)

type candidateOperations struct {
	TeamOperations
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
		return model.Principal{UserID: directActor, CredentialID: directTarget, Kind: kind}, nil
	}, authconfig.AuthSettings{PublicOrigin: "https://daynight.example"}, logger)
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	RegisterRoutes(mux, op, &authhttp.Authentication{RequestAuthentication: auth}, logger)
	return httpx.RequestLogging(logger, mux)
}

const candidateBody = `{"expectedUserId":"` + directActor + `","query":"private-search","limit":7,"cursor":"private-cursor"}`

func candidateRequest(body string) *http.Request {
	r := httptest.NewRequest(http.MethodPost, "/api/v1/teams/"+directTeam+"/member-candidates/search", strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Authorization", "Bearer valid")
	r.Header.Set("X-Request-ID", "project-test")
	return r
}

func TestCandidateSearchProtocolAndCapacity(t *testing.T) {
	name, avatar, cursor := "Same name", strings.Repeat("<", 512*1024), "next"
	calls := 0
	op := candidateOperations{search: func(ctx context.Context, p model.Principal, id string, input core.CandidateSearchInput) (core.CandidatePage, error) {
		calls++
		if p.UserID != directActor || p.CredentialID != directTarget || p.Kind != model.PATCredential || id != directTeam || input.ExpectedUserID != directActor || input.Query != "private-search" || input.Limit == nil || *input.Limit != 7 || input.Cursor == nil || *input.Cursor != "private-cursor" {
			t.Fatalf("principal=%+v id=%q input=%+v", p, id, input)
		}
		return core.CandidatePage{Items: []model.UserCandidate{{UserID: directTarget, Profile: model.ProjectParticipantProfile{Name: &name, AvatarURL: &avatar}}}, NextCursor: &cursor}, nil
	}}
	h := candidateHTTP(t, op, slog.New(slog.NewTextHandler(io.Discard, nil)))
	w := httptest.NewRecorder()
	h.ServeHTTP(w, candidateRequest(candidateBody))
	var page api.TeamMemberCandidatePage
	if err := json.Unmarshal(w.Body.Bytes(), &page); err != nil {
		t.Fatal(err)
	}
	if calls != 1 || w.Code != 200 || w.Header().Get("Cache-Control") != "no-store" || w.Header().Get("Daynight-User-ID") != directActor || page.ActorRole != "admin" || page.NextCursor == nil || *page.NextCursor != cursor || len(page.Items) != 1 || page.Items[0].UserID != directTarget || page.Items[0].Profile.Email != nil || page.Items[0].Profile.AvatarURL == nil || *page.Items[0].Profile.AvatarURL != avatar {
		t.Fatalf("calls=%d status=%d headers=%v page=%+v", calls, w.Code, w.Header(), page)
	}
	if !strings.Contains(w.Body.String(), `"email":null`) || strings.Contains(w.Body.String(), "private-search") || strings.Contains(w.Body.String(), "private-cursor") {
		t.Fatal("response contains unexpected fields")
	}
}

func TestCandidateSearchRejectsMalformedRequests(t *testing.T) {
	cases := []struct{ body, query, media string }{
		{`{}`, "", "application/json"},
		{`{"expectedUserId":"` + directActor + `"}`, "", "application/json"},
		{`{"expectedUserId":null,"query":"x"}`, "", "application/json"},
		{`{"expectedUserId":"` + directActor + `","query":null}`, "", "application/json"},
		{`{"expectedUserId":"` + directActor + `","query":"x","limit":null}`, "", "application/json"},
		{`{"expectedUserId":"` + directActor + `","query":"x","limit":1.0}`, "", "application/json"},
		{`{"expectedUserId":"` + directActor + `","query":"x","cursor":null}`, "", "application/json"},
		{`{"expectedUserId":"` + directActor + `","query":"x","query":"secret"}`, "", "application/json"},
		{`{"expectedUserId":"` + directActor + `","query":"x","unknown":true}`, "", "application/json"},
		{`{"expectedUserId":"` + directActor + `","query":"\ud800"}`, "", "application/json"},
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
		{&model.Fault{Code: "not_found", Message: "Team was not found."}, 404, "not_found"},
		{&model.Fault{Code: "personal_team_immutable", Message: "personal"}, 409, "personal_team_immutable"},
		{&store.Error{DatabaseFailure: true, Cause: errors.New("private-search private-cursor")}, 500, "internal_error"},
		{&store.TransactionError{Phase: "cleanup", Outcome: store.TransactionUnknown, CleanupFailed: true, Cause: errors.New("private-search private-cursor")}, 500, "internal_error"},
	} {
		var logs bytes.Buffer
		h := candidateHTTP(t, candidateOperations{search: func(context.Context, model.Principal, string, core.CandidateSearchInput) (core.CandidatePage, error) {
			return core.CandidatePage{}, tc.err
		}}, slog.New(slog.NewJSONHandler(&logs, nil)))
		w := httptest.NewRecorder()
		h.ServeHTTP(w, candidateRequest(candidateBody))
		assertProjectError(t, w, tc.status, tc.code)
		if strings.Contains(logs.String()+w.Body.String(), "private-search") || strings.Contains(logs.String()+w.Body.String(), "private-cursor") || !strings.Contains(logs.String(), `"component":"member_candidate_search"`) || !strings.Contains(logs.String(), `"phase":"search"`) {
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
