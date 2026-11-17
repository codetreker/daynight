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

const existingBody = `{"expectedUserId":"` + directActor + `"}`

type existingOperation func(context.Context, model.Principal, string, string, string) (coreteam.ExistingMemberResult, error)

func existingHTTP(t *testing.T, op existingOperation, logger *slog.Logger) http.Handler {
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
	h := &teamHandler{addExistingMember: op, logger: logger}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/v1/teams/{teamId}/members/{userId}", auth.Require(h.addExistingTeamMember))
	return httpx.RequestLogging(logger, mux)
}

func existingRequest(body string) *http.Request {
	r := httptest.NewRequest(http.MethodPost, "/api/v1/teams/"+directTeam+"/members/"+directTarget, strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Authorization", "Bearer valid")
	r.Header.Set("X-Request-ID", "project-test")
	return r
}

func TestExistingMemberReceiptAndContext(t *testing.T) {
	for _, added := range []bool{false, true} {
		name, email := "Real name", "real@example.com"
		timestamp := time.Date(2026, 11, 17, 1, 2, 3, 0, time.FixedZone("offset", 3600))
		member := model.TeamMember{TeamID: directTeam, UserID: directTarget, Role: model.ProjectAdmin, Version: 9007199254740993, CreatedAt: timestamp, UpdatedAt: timestamp}
		deadline := time.Now().Add(time.Second)
		ctx, cancel := context.WithDeadline(context.Background(), deadline)
		calls := 0
		h := existingHTTP(t, func(got context.Context, p model.Principal, id, target, expected string) (coreteam.ExistingMemberResult, error) {
			calls++
			d, ok := got.Deadline()
			if !ok || !d.Equal(deadline) || p.UserID != directActor || p.Kind != model.PATCredential || p.CredentialID == "" || id != directTeam || target != directTarget || expected != directActor {
				t.Fatalf("operation context or arguments: %v %+v %s %s %s", d, p, id, target, expected)
			}
			return coreteam.ExistingMemberResult{Membership: model.TeamMemberProfile{Membership: member, Profile: model.ProjectParticipantProfile{Name: &name, Email: &email}}, Added: added}, nil
		}, slog.New(slog.NewTextHandler(io.Discard, nil)))
		w := httptest.NewRecorder()
		h.ServeHTTP(w, existingRequest(existingBody).WithContext(ctx))
		cancel()
		var receipt api.AddExistingTeamMemberReceipt
		if err := json.Unmarshal(w.Body.Bytes(), &receipt); err != nil {
			t.Fatal(err)
		}
		if calls != 1 || w.Code != 200 || w.Header().Get("Cache-Control") != "no-store" || receipt.Added != added || receipt.ActorRole != "admin" || receipt.Membership.Role != "admin" || receipt.Membership.UserID != directTarget || receipt.Membership.Version != member.Version || !receipt.Membership.CreatedAt.Equal(timestamp) || receipt.Membership.CreatedAt.Location() != time.UTC || *receipt.Membership.Profile.Name != name || *receipt.Membership.Profile.Email != email || receipt.Membership.Profile.AvatarURL != nil {
			t.Fatalf("calls=%d response=%s", calls, w.Body.String())
		}
	}
}

func TestExistingMemberRejectsMalformedRequests(t *testing.T) {
	cases := []struct {
		body, query, media string
		force              bool
	}{
		{`{}`, "", "application/json", false},
		{`{"expectedUserId":null}`, "", "application/json", false},
		{`{"expectedUserId":false}`, "", "application/json", false},
		{`{"expectedUserId":"\ud800"}`, "", "application/json", false},
		{`{"expectedUserId":"x","expectedUserId":"y"}`, "", "application/json", false},
		{`{"expectedUserId":"x","role":"member"}`, "", "application/json", false},
		{`{"expectedUserId":"x","profile":null}`, "", "application/json", false},
		{existingBody + `{}`, "", "application/json", false},
		{existingBody, "other=1", "application/json", false},
		{existingBody, "", "application/json", true},
		{existingBody, "", "text/plain", false},
		{strings.Repeat(" ", 1<<20) + existingBody, "", "application/json", false},
	}
	for i, tc := range cases {
		t.Run(string(rune('a'+i)), func(t *testing.T) {
			h := existingHTTP(t, func(context.Context, model.Principal, string, string, string) (coreteam.ExistingMemberResult, error) {
				t.Fatal("invalid input reached operation")
				return coreteam.ExistingMemberResult{}, nil
			}, slog.New(slog.NewTextHandler(io.Discard, nil)))
			r := existingRequest(tc.body)
			r.URL.RawQuery = tc.query
			r.URL.ForceQuery = tc.force
			r.Header.Set("Content-Type", tc.media)
			w := httptest.NewRecorder()
			h.ServeHTTP(w, r)
			status, code := 400, "invalid_input"
			if len(tc.body) > 1<<20 {
				status, code = 413, "payload_too_large"
			}
			assertProjectError(t, w, status, code)
		})
	}
}

func TestExistingMemberErrorsAndCompletionPriority(t *testing.T) {
	missing := &model.Fault{Code: "user_not_found", Message: "User was not found.", Cause: model.ErrNotFound}
	tx := &store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, Cause: missing}
	unknown := &store.TransactionError{Phase: "commit", Outcome: store.TransactionUnknown, CommitAttempted: true, Cause: errors.New("private commit")}
	cleanup := &store.TransactionError{Phase: "cleanup", Outcome: store.TransactionUnknown, CleanupFailed: true, Cause: errors.New("private cleanup")}
	for _, tc := range []struct {
		name   string
		err    error
		status int
		code   string
	}{
		{"user", tx, 404, "user_not_found"}, {"team", &store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, Cause: model.ErrNotFound}, 404, "not_found"},
		{"credential", &store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, Cause: model.Unauthenticated(model.ErrNotFound)}, 401, "unauthenticated"},
		{"unknown", errors.Join(tx, unknown), 503, "write_outcome_unknown"}, {"cleanup", errors.Join(tx, cleanup), 500, "internal_error"},
		{"database", errors.Join(tx, &store.Error{DatabaseFailure: true, Cause: errors.New("private database")}), 500, "internal_error"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			calls := 0
			var logs bytes.Buffer
			h := existingHTTP(t, func(context.Context, model.Principal, string, string, string) (coreteam.ExistingMemberResult, error) {
				calls++
				return coreteam.ExistingMemberResult{}, tc.err
			}, slog.New(slog.NewJSONHandler(&logs, nil)))
			w := httptest.NewRecorder()
			h.ServeHTTP(w, existingRequest(existingBody))
			assertProjectError(t, w, tc.status, tc.code)
			if calls != 1 || strings.Contains(w.Body.String(), "private") || strings.Contains(logs.String(), "private") {
				t.Fatalf("calls=%d response=%s logs=%s", calls, w.Body.String(), logs.String())
			}
		})
	}
}

func TestExistingMemberResponseLossDoesNotReplay(t *testing.T) {
	calls := 0
	var logs bytes.Buffer
	h := existingHTTP(t, func(context.Context, model.Principal, string, string, string) (coreteam.ExistingMemberResult, error) {
		calls++
		return coreteam.ExistingMemberResult{Membership: model.TeamMemberProfile{Membership: model.TeamMember{TeamID: directTeam, UserID: directTarget}}, Added: true}, nil
	}, slog.New(slog.NewJSONHandler(&logs, nil)))
	w := &threadFailingWriter{ResponseRecorder: httptest.NewRecorder()}
	h.ServeHTTP(w, existingRequest(existingBody))
	if calls != 1 || w.calls != 1 || !strings.Contains(logs.String(), `"write_outcome":"unknown"`) {
		t.Fatalf("calls=%d writes=%d logs=%s", calls, w.calls, logs.String())
	}
}

func TestExistingMemberRouteDispatchAndAllow(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	auth, err := authhttp.NewRequestAuthentication(func(_ context.Context, kind model.CredentialKind, _ string) (model.Principal, error) {
		return model.Principal{UserID: directActor, CredentialID: "40000000-0000-4000-8000-000000000001", Kind: kind}, nil
	}, authconfig.AuthSettings{PublicOrigin: "https://daynight.example"}, logger)
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	authentication := &authhttp.Authentication{RequestAuthentication: auth}
	RegisterRoutes(mux, nil, authentication, logger)
	RegisterDirectMemberRoutes(mux, &teamservice.DirectMembers{}, authentication, logger)
	for _, tc := range []struct{ method, path, allow string }{
		{"PUT", "/api/v1/teams/" + directTeam + "/members/" + directTarget, "POST, PATCH, DELETE"},
		{"GET", "/api/v1/teams/" + directTeam + "/members/resolve", "POST"},
		{"PATCH", "/api/v1/teams/" + directTeam + "/members/resolve", "POST"},
		{"DELETE", "/api/v1/teams/" + directTeam + "/members/resolve", "POST"},
	} {
		r := httptest.NewRequest(tc.method, tc.path, nil)
		r.Header.Set("Authorization", "Bearer valid")
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, r)
		if w.Code != 405 || w.Header().Get("Allow") != tc.allow || w.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("%s %s: %d %v", tc.method, tc.path, w.Code, w.Header())
		}
	}
	// A malformed resolve body must be parsed by the static route, not treated as a target UUID.
	r := httptest.NewRequest("POST", "/api/v1/teams/"+directTeam+"/members/resolve", strings.NewReader(existingBody))
	r.Header.Set("Authorization", "Bearer valid")
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("X-Request-ID", "project-test")
	w := httptest.NewRecorder()
	httpx.RequestLogging(logger, mux).ServeHTTP(w, r)
	assertProjectError(t, w, 400, "invalid_input")
}

func TestExistingMemberAuthenticationAndCancellation(t *testing.T) {
	calls := 0
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	h := existingHTTP(t, func(ctx context.Context, _ model.Principal, _, _, _ string) (coreteam.ExistingMemberResult, error) {
		calls++
		<-ctx.Done()
		return coreteam.ExistingMemberResult{}, ctx.Err()
	}, logger)
	r := existingRequest(existingBody)
	r.Header.Del("Authorization")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusUnauthorized || calls != 0 {
		t.Fatalf("status=%d calls=%d", w.Code, calls)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	w = httptest.NewRecorder()
	h.ServeHTTP(w, existingRequest(existingBody).WithContext(ctx))
	if w.Body.Len() != 0 {
		t.Fatalf("canceled request wrote %s", w.Body.String())
	}
}

func TestExistingMemberLoggingCorrelationAndRedaction(t *testing.T) {
	secret := "private\"profile\nprivate-query-private-cursor-external-identity"
	for _, tc := range []struct {
		name, target, phase, code string
		err                       error
		responseLoss              bool
	}{
		{"read", directTarget, "add_existing_member", "internal_error", &httpx.RuntimeError{Component: secret, Phase: secret, Cause: &store.Error{DatabaseFailure: true, Phase: secret}}, false},
		{"missing", directTarget, "add_existing_member", "user_not_found", &model.Fault{Code: "user_not_found", Message: secret, Cause: model.ErrNotFound}, false},
		{"commit", directTarget, "commit", "write_outcome_unknown", &store.TransactionError{Phase: "commit", Outcome: store.TransactionUnknown, CommitAttempted: true, Cause: errors.New(secret)}, false},
		{"cleanup", directTarget, "completion", "internal_error", &store.TransactionError{Phase: "cleanup", Outcome: store.TransactionUnknown, CleanupFailed: true, Cause: errors.New(secret)}, false},
		{"response", directTarget, "response", "write_outcome_unknown", nil, true},
		{"invalid-target", "private-target", "add_existing_member", "invalid_input", &model.Fault{Code: "invalid_input", Message: secret}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var logs bytes.Buffer
			h := existingHTTP(t, func(context.Context, model.Principal, string, string, string) (coreteam.ExistingMemberResult, error) {
				return coreteam.ExistingMemberResult{Membership: model.TeamMemberProfile{Membership: model.TeamMember{TeamID: directTeam, UserID: directTarget}}}, tc.err
			}, slog.New(slog.NewJSONHandler(&logs, nil)))
			r := existingRequest(existingBody)
			r.URL.Path = "/api/v1/teams/" + directTeam + "/members/" + tc.target
			if tc.responseLoss {
				w := &threadFailingWriter{ResponseRecorder: httptest.NewRecorder()}
				h.ServeHTTP(w, r)
			} else {
				h.ServeHTTP(httptest.NewRecorder(), r)
			}
			var operation map[string]any
			for _, line := range bytes.Split(bytes.TrimSpace(logs.Bytes()), []byte("\n")) {
				var event map[string]any
				if err := json.Unmarshal(line, &event); err != nil {
					t.Fatalf("invalid log: %s", line)
				}
				encoded, _ := json.Marshal(event)
				if strings.Contains(string(encoded), "private") {
					t.Fatalf("sensitive value in log: %s", encoded)
				}
				if event["type"] == "operation_error" {
					operation = event
				}
			}
			if operation == nil || operation["component"] != "team" || operation["phase"] != tc.phase || operation["error_code"] != tc.code || operation["diagnostic"] != "operation failed" || operation["request_id"] != "project-test" || operation["user_id"] != directActor || operation["team_id"] != directTeam {
				t.Fatalf("unexpected operation log: %s", logs.String())
			}
			if tc.target == directTarget && operation["target_user_id"] != directTarget {
				t.Fatalf("missing target: %s", logs.String())
			}
			if tc.target != directTarget && operation["target_user_id"] != nil {
				t.Fatalf("invalid target logged: %s", logs.String())
			}
		})
	}
}
