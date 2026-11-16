package team

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
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	coreteam "github.com/codetreker/daynight/packages/daynight-server/internal/core/team"
	authhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"
	authconfig "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth/config"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	teamservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/team"
)

const resolveBody = `{"expectedUserId":"` + directActor + `","user":{"externalUserId":"private:external-key"}}`

func resolveHTTP(t *testing.T, operation func(context.Context, model.Principal, string, coreteam.ResolveTeamMember) (*model.TeamMember, error), logger *slog.Logger) http.Handler {
	t.Helper()
	auth, err := authhttp.NewRequestAuthentication(func(_ context.Context, kind model.CredentialKind, value string) (model.Principal, error) {
		if value != "valid" {
			return model.Principal{}, authhttp.Failure()
		}
		return model.Principal{UserID: directActor, CredentialID: "40000000-0000-4000-8000-000000000001", Kind: kind}, nil
	}, authconfig.AuthSettings{PublicOrigin: "https://daynight.example"}, logger)
	if err != nil {
		t.Fatal(err)
	}
	h := &teamHandler{resolveMember: operation, logger: logger}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/v1/teams/{teamId}/members/resolve", auth.Require(h.resolveDirectMember))
	return httpx.RequestLogging(logger, mux)
}

func resolveRequest(body string) *http.Request {
	r := httptest.NewRequest(http.MethodPost, "/api/v1/teams/"+directTeam+"/members/resolve", strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Authorization", "Bearer valid")
	r.Header.Set("X-Request-ID", "project-test")
	return r
}

func TestResolveMemberProtocol(t *testing.T) {
	for _, present := range []bool{false, true} {
		for _, cookie := range []bool{false, true} {
			calls := 0
			now := time.Date(2026, 11, 13, 0, 0, 0, 0, time.FixedZone("offset", 3600))
			member := model.TeamMember{TeamID: directTeam, UserID: directTarget, Role: model.ProjectMemberRole, Version: math.MaxInt64, CreatedAt: now, UpdatedAt: now}
			deadline := time.Now().Add(time.Second)
			ctx, cancel := context.WithDeadline(context.Background(), deadline)
			h := resolveHTTP(t, func(got context.Context, p model.Principal, id string, input coreteam.ResolveTeamMember) (*model.TeamMember, error) {
				calls++
				actual, ok := got.Deadline()
				kind := model.PATCredential
				if cookie {
					kind = model.SessionCredential
				}
				if !ok || !actual.Equal(deadline) || p.UserID != directActor || p.Kind != kind || p.CredentialID == "" || id != directTeam || input.ExpectedUserID != directActor || input.ExternalUserID != "private:external-key" {
					t.Fatalf("context/principal/input mismatch: %v %v %s %+v", actual, p, id, input)
				}
				if present {
					return &member, nil
				}
				return nil, nil
			}, slog.New(slog.NewTextHandler(io.Discard, nil)))
			r := resolveRequest(resolveBody).WithContext(ctx)
			if cookie {
				r.Header.Del("Authorization")
				r.AddCookie(&http.Cookie{Name: "__Host-daynight_session", Value: "valid"})
				r.Header.Set("Origin", "https://daynight.example")
			}
			w := httptest.NewRecorder()
			h.ServeHTTP(w, r)
			cancel()
			var got api.ResolveTeamMemberResponse
			if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
				t.Fatal(err)
			}
			if calls != 1 || w.Code != 200 || got.ActorRole != "admin" || (got.Membership != nil) != present || w.Header().Get("Daynight-User-ID") != directActor || w.Header().Get("Cache-Control") != "no-store" || w.Body.Len() > httpx.MaxJSONBody || strings.Contains(w.Body.String(), "private:external-key") {
				t.Fatalf("calls=%d response=%s headers=%v", calls, w.Body.String(), w.Header())
			}
			if present && (got.Membership.UserID != directTarget || got.Membership.Version != math.MaxInt64 || got.Membership.Role != "member" || got.Membership.CreatedAt.Location() != time.UTC || !got.Membership.CreatedAt.Equal(now) || !strings.Contains(w.Body.String(), `"version":9223372036854775807`)) {
				t.Fatalf("membership=%+v body=%s", got.Membership, w.Body.String())
			}
			if !present && !strings.Contains(w.Body.String(), `"membership":null`) {
				t.Fatalf("body=%s", w.Body.String())
			}
		}
	}
}

func TestResolveMemberRejectsMalformedRequestsBeforeOperation(t *testing.T) {
	cases := []struct{ body, query, media string }{
		{`{}`, "", "application/json"},
		{`{"expectedUserId":"` + directActor + `"}`, "", "application/json"},
		{strings.Replace(resolveBody, `"user":{"externalUserId":"private:external-key"}`, `"user":null`, 1), "", "application/json"},
		{strings.Replace(resolveBody, `"externalUserId":"private:external-key"`, `"externalUserId":false`, 1), "", "application/json"},
		{strings.Replace(resolveBody, `"expectedUserId":"`+directActor+`"`, `"expectedUserId":null`, 1), "", "application/json"},
		{strings.Replace(resolveBody, `"user":`, `"role":"member","user":`, 1), "", "application/json"},
		{strings.Replace(resolveBody, `"user":`, `"expectedUserId":"`+directActor+`","user":`, 1), "", "application/json"},
		{strings.Replace(resolveBody, `"externalUserId":"private:external-key"`, `"externalUserId":"private:external-key","profile":null`, 1), "", "application/json"},
		{strings.Replace(resolveBody, `"externalUserId":"private:external-key"`, `"externalUserId":"private:external-key","externalUserId":"other"`, 1), "", "application/json"},
		{strings.Replace(resolveBody, `private:external-key`, `\ud800`, 1), "", "application/json"},
		{strings.Replace(resolveBody, directActor, `\ud800`, 1), "", "application/json"},
		{resolveBody, "version=1", "application/json"},
		{resolveBody, "", "text/plain"},
		{strings.Repeat(" ", 1<<20) + resolveBody, "", "application/json"},
	}
	for i, tc := range cases {
		t.Run(string(rune('a'+i)), func(t *testing.T) {
			calls := 0
			var logs bytes.Buffer
			h := resolveHTTP(t, func(context.Context, model.Principal, string, coreteam.ResolveTeamMember) (*model.TeamMember, error) {
				calls++
				return nil, nil
			}, slog.New(slog.NewJSONHandler(&logs, nil)))
			r := resolveRequest(tc.body)
			r.URL.RawQuery = tc.query
			r.Header.Set("Content-Type", tc.media)
			w := httptest.NewRecorder()
			h.ServeHTTP(w, r)
			status, code := 400, "invalid_input"
			if len(tc.body) > 1<<20 {
				status, code = 413, "payload_too_large"
			}
			assertProjectError(t, w, status, code)
			if calls != 0 || strings.Contains(w.Body.String()+logs.String(), "private:external-key") {
				t.Fatalf("calls=%d body=%s logs=%s", calls, w.Body.String(), logs.String())
			}
		})
	}
}

func TestResolveMemberErrorsDoNotProduceSuccess(t *testing.T) {
	for _, tc := range []struct {
		name   string
		err    error
		status int
		code   string
	}{
		{"forbidden", &model.Fault{Code: "forbidden", Message: "Team administrator access is required."}, 403, "forbidden"},
		{"mismatch", &model.Fault{Code: "identity_mismatch", Message: "Actor mismatch."}, 409, "identity_mismatch"},
		{"personal", &model.Fault{Code: "personal_team_immutable", Message: "Personal Team."}, 409, "personal_team_immutable"},
		{"missing", &store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, Cause: &store.Error{MissingRow: true, Cause: model.ErrNotFound}}, 404, "not_found"},
		{"revoked", &store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, Cause: model.Unauthenticated(model.ErrNotFound)}, 401, "unauthenticated"},
		{"database", &store.Error{DatabaseFailure: true, Cause: errors.New("private:external-key")}, 500, "internal_error"},
		{"completion", &store.TransactionError{Phase: "commit", Outcome: store.TransactionUnknown, CommitAttempted: true, Cause: errors.New("private:external-key")}, 500, "internal_error"},
		{"cleanup", &store.TransactionError{Phase: "cleanup", Outcome: store.TransactionUnknown, CleanupFailed: true, Cause: errors.New("private:external-key")}, 500, "internal_error"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			calls := 0
			var logs bytes.Buffer
			h := resolveHTTP(t, func(context.Context, model.Principal, string, coreteam.ResolveTeamMember) (*model.TeamMember, error) {
				calls++
				return &model.TeamMember{UserID: directTarget}, tc.err
			}, slog.New(slog.NewJSONHandler(&logs, nil)))
			w := httptest.NewRecorder()
			h.ServeHTTP(w, resolveRequest(resolveBody))
			assertProjectError(t, w, tc.status, tc.code)
			if calls != 1 || strings.Contains(w.Body.String()+logs.String(), "private:external-key") || strings.Contains(w.Body.String(), `"membership"`) {
				t.Fatalf("calls=%d body=%s logs=%s", calls, w.Body.String(), logs.String())
			}
		})
	}
}

func TestResolveMemberAuthenticationAndRoute(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	calls := 0
	auth, err := authhttp.NewRequestAuthentication(func(context.Context, model.CredentialKind, string) (model.Principal, error) {
		calls++
		return model.Principal{}, authhttp.Failure()
	}, authconfig.AuthSettings{PublicOrigin: "https://daynight.example"}, logger)
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	RegisterRoutes(mux, nil, &authhttp.Authentication{RequestAuthentication: auth}, logger)
	RegisterDirectMemberRoutes(mux, &teamservice.DirectMembers{}, &authhttp.Authentication{RequestAuthentication: auth}, logger)
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, resolveRequest(resolveBody))
	if calls != 1 || w.Code != http.StatusUnauthorized || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("calls=%d status=%d headers=%v", calls, w.Code, w.Header())
	}
	valid, err := authhttp.NewRequestAuthentication(func(_ context.Context, kind model.CredentialKind, _ string) (model.Principal, error) {
		return model.Principal{UserID: directActor, Kind: kind}, nil
	}, authconfig.AuthSettings{PublicOrigin: "https://daynight.example"}, logger)
	if err != nil {
		t.Fatal(err)
	}
	mux = http.NewServeMux()
	RegisterRoutes(mux, nil, &authhttp.Authentication{RequestAuthentication: valid}, logger)
	RegisterDirectMemberRoutes(mux, &teamservice.DirectMembers{}, &authhttp.Authentication{RequestAuthentication: valid}, logger)
	for _, method := range []string{"GET", "HEAD", "PATCH", "DELETE", "PUT", "OPTIONS"} {
		r := resolveRequest(resolveBody)
		r.Method = method
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, r)
		if w.Code != http.StatusMethodNotAllowed || w.Header().Get("Allow") != "POST" || w.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("method=%s status=%d headers=%v", method, w.Code, w.Header())
		}
	}
	w = httptest.NewRecorder()
	mux.ServeHTTP(w, resolveRequest(`{"expectedUserId":"`+directActor+`","user":{"externalUserId":"private:external-key","profile":null}}`))
	if w.Code != http.StatusBadRequest || strings.Contains(w.Body.String(), "private:external-key") {
		t.Fatalf("POST status=%d body=%s", w.Code, w.Body.String())
	}
}

func TestResolveMemberResponseCapacity(t *testing.T) {
	latest := time.Date(9999, 12, 31, 23, 59, 59, 999999999, time.UTC)
	member := model.TeamMember{TeamID: directTeam, UserID: directTarget, Role: model.ProjectMemberRole, Version: math.MaxInt64, CreatedAt: latest, UpdatedAt: latest}
	h := resolveHTTP(t, func(context.Context, model.Principal, string, coreteam.ResolveTeamMember) (*model.TeamMember, error) {
		return &member, nil
	}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	w := httptest.NewRecorder()
	h.ServeHTTP(w, resolveRequest(resolveBody))
	var result map[string]json.RawMessage
	if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(result["membership"], &fields); err != nil {
		t.Fatal(err)
	}
	if w.Code != 200 || w.Body.Len() > 512 || len(result) != 2 || len(fields) != 6 || strings.Contains(w.Body.String(), "external") || strings.Contains(w.Body.String(), "profile") {
		t.Fatalf("status=%d bytes=%d body=%s", w.Code, w.Body.Len(), w.Body.String())
	}
}

func TestResolveMemberCancellationAndResponseLoss(t *testing.T) {
	for _, mode := range []string{"cancel_operation", "cancel_response", "writer_error", "short_write"} {
		t.Run(mode, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			calls := 0
			var logs bytes.Buffer
			h := resolveHTTP(t, func(got context.Context, _ model.Principal, _ string, _ coreteam.ResolveTeamMember) (*model.TeamMember, error) {
				calls++
				if mode == "cancel_operation" {
					cancel()
					<-got.Done()
					return nil, got.Err()
				}
				if mode == "cancel_response" {
					cancel()
				}
				return nil, nil
			}, slog.New(slog.NewJSONHandler(&logs, nil)))
			w := &threadFailingWriter{ResponseRecorder: httptest.NewRecorder(), short: mode == "short_write"}
			h.ServeHTTP(w, resolveRequest(resolveBody).WithContext(ctx))
			if calls != 1 || w.Body.Len() != 0 {
				t.Fatalf("calls=%d body=%s", calls, w.Body.String())
			}
			if mode == "cancel_operation" || mode == "cancel_response" {
				if w.calls != 0 {
					t.Fatalf("canceled response wrote %d times", w.calls)
				}
			} else if w.Code != 200 || w.calls != 1 || !strings.Contains(logs.String(), `"phase":"response"`) {
				t.Fatalf("status=%d writes=%d logs=%s", w.Code, w.calls, logs.String())
			}
		})
	}
}
