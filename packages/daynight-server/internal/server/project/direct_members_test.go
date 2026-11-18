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

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	coreproject "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	authhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"
	authconfig "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth/config"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
)

const directActor = "10000000-0000-4000-8000-000000000001"
const directProject = "20000000-0000-4000-8000-000000000001"
const directTarget = "30000000-0000-4000-8000-000000000001"
const directBody = `{"expectedUserId":"` + directActor + `"}`

type directOperation func(context.Context, model.Principal, string, string, string) (coreproject.ExistingMemberResult, error)

func (op directOperation) AddExistingMember(ctx context.Context, p model.Principal, projectID, target, expected string) (coreproject.ExistingMemberResult, error) {
	return op(ctx, p, projectID, target, expected)
}

func directHTTP(t *testing.T, op directOperation, logger *slog.Logger) http.Handler {
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
	mux := http.NewServeMux()
	NewMembershipRoutes(nil, auth, logger).RegisterRoutes(mux)
	RegisterDirectMemberRoute(mux, op, auth, logger)
	return httpx.RequestLogging(logger, mux)
}

func directRequest(body string) *http.Request {
	r := httptest.NewRequest(http.MethodPost, "/api/v1/projects/"+directProject+"/members/"+directTarget, strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Authorization", "Bearer valid")
	r.Header.Set("X-Request-ID", "project-test")
	return r
}

func TestDirectMemberReceiptAndContext(t *testing.T) {
	for _, added := range []bool{false, true} {
		name := "Name"
		now := time.Date(2026, 11, 18, 1, 2, 3, 0, time.FixedZone("offset", 3600))
		grant := model.ProjectGrant{ProjectID: directProject, UserID: directTarget, Role: model.ProjectMemberRole, Version: 9007199254740993, CreatedAt: now, UpdatedAt: now}
		deadline := time.Now().Add(time.Second)
		ctx, cancel := context.WithDeadline(context.Background(), deadline)
		calls := 0
		h := directHTTP(t, func(got context.Context, p model.Principal, projectID, target, expected string) (coreproject.ExistingMemberResult, error) {
			calls++
			d, ok := got.Deadline()
			if !ok || !d.Equal(deadline) || p.UserID != directActor || p.Kind != model.PATCredential || p.CredentialID == "" || projectID != directProject || target != directTarget || expected != directActor {
				t.Fatalf("operation context or arguments: %v %+v %s %s %s", d, p, projectID, target, expected)
			}
			return coreproject.ExistingMemberResult{Added: added, Participant: model.ProjectParticipant{UserID: target, EffectiveRole: model.ProjectAdmin, DirectGrant: &grant, Profile: model.ProjectParticipantProfile{Name: &name}}, ActorAccess: model.ProjectAccess{ProjectID: projectID, Role: model.ProjectAdmin}}, nil
		}, slog.New(slog.NewTextHandler(io.Discard, nil)))
		w := httptest.NewRecorder()
		h.ServeHTTP(w, directRequest(directBody).WithContext(ctx))
		cancel()
		var receipt directMemberReceipt
		if err := json.Unmarshal(w.Body.Bytes(), &receipt); err != nil {
			t.Fatal(err)
		}
		if calls != 1 || w.Code != 200 || w.Header().Get("Cache-Control") != "no-store" || w.Header().Get("Daynight-User-ID") != directActor || receipt.Added != added || receipt.Participant.UserID != directTarget || receipt.Participant.EffectiveRole != "admin" || receipt.Participant.DirectGrant == nil || receipt.Participant.DirectGrant.Role != "member" || receipt.Participant.DirectGrant.Version != grant.Version || !receipt.Participant.DirectGrant.CreatedAt.Equal(now) || receipt.Participant.DirectGrant.CreatedAt.Location() != time.UTC || *receipt.Participant.Profile.Name != name || receipt.ActorAccess.ProjectID != directProject || receipt.ActorAccess.EffectiveRole != "admin" {
			t.Fatalf("calls=%d response=%s", calls, w.Body.String())
		}
	}
}

func TestDirectMemberRejectsMalformedRequests(t *testing.T) {
	cases := []struct {
		body, query, media string
		force              bool
	}{
		{`{}`, "", "application/json", false}, {`{"expectedUserId":null}`, "", "application/json", false},
		{`{"expectedUserId":false}`, "", "application/json", false}, {`{"expectedUserId":"\ud800"}`, "", "application/json", false},
		{`{"expectedUserId":"x","expectedUserId":"y"}`, "", "application/json", false}, {`{"expectedUserId":"x","role":"member"}`, "", "application/json", false},
		{`{"expectedUserId":"x","profile":null}`, "", "application/json", false}, {directBody + `{}`, "", "application/json", false},
		{directBody, "other=1", "application/json", false}, {directBody, "", "application/json", true}, {directBody, "", "text/plain", false},
	}
	for i, tc := range cases {
		t.Run(string(rune('a'+i)), func(t *testing.T) {
			h := directHTTP(t, func(context.Context, model.Principal, string, string, string) (coreproject.ExistingMemberResult, error) {
				t.Fatal("invalid input reached operation")
				return coreproject.ExistingMemberResult{}, nil
			}, slog.New(slog.NewTextHandler(io.Discard, nil)))
			r := directRequest(tc.body)
			r.URL.RawQuery, r.URL.ForceQuery = tc.query, tc.force
			r.Header.Set("Content-Type", tc.media)
			w := httptest.NewRecorder()
			h.ServeHTTP(w, r)
			assertProjectError(t, w, 400, "invalid_input")
		})
	}
}

func TestDirectMemberErrorsAndCompletionPriority(t *testing.T) {
	missing := &model.Fault{Code: "user_not_found", Message: "User was not found.", Cause: model.ErrNotFound}
	tx := &store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, Cause: missing}
	unknown := &store.TransactionError{Phase: "commit", Outcome: store.TransactionUnknown, CommitAttempted: true, Cause: errors.New("private commit")}
	for _, tc := range []struct {
		name   string
		err    error
		status int
		code   string
	}{
		{"user", tx, 404, "user_not_found"}, {"project", coreproject.ProjectWriteError(&store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, Cause: model.ErrNotFound}), 404, "not_found"},
		{"credential", model.Unauthenticated(model.ErrNotFound), 401, "unauthenticated"}, {"forbidden", &model.Fault{Code: "forbidden", Message: "forbidden"}, 403, "forbidden"},
		{"identity", &model.Fault{Code: "identity_mismatch", Message: "changed"}, 409, "identity_mismatch"},
		{"unknown", errors.Join(tx, unknown), 503, "write_outcome_unknown"}, {"cleanup", &store.TransactionError{Phase: "cleanup", Outcome: store.TransactionNotCommitted, CleanupFailed: true, Cause: missing}, 500, "internal_error"},
		{"unknown with cleanup", &store.TransactionError{Phase: "cleanup", Outcome: store.TransactionUnknown, CommitAttempted: true, CleanupFailed: true, Cause: missing}, 503, "write_outcome_unknown"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			calls := 0
			var logs bytes.Buffer
			h := directHTTP(t, func(context.Context, model.Principal, string, string, string) (coreproject.ExistingMemberResult, error) {
				calls++
				return coreproject.ExistingMemberResult{}, tc.err
			}, slog.New(slog.NewJSONHandler(&logs, nil)))
			w := httptest.NewRecorder()
			h.ServeHTTP(w, directRequest(directBody))
			assertProjectError(t, w, tc.status, tc.code)
			if calls != 1 || strings.Contains(w.Body.String(), "private") || strings.Contains(logs.String(), "private") {
				t.Fatalf("calls=%d response=%s logs=%s", calls, w.Body.String(), logs.String())
			}
		})
	}
}

func TestDirectMemberResponseLossAndAllow(t *testing.T) {
	calls := 0
	var logs bytes.Buffer
	h := directHTTP(t, func(context.Context, model.Principal, string, string, string) (coreproject.ExistingMemberResult, error) {
		calls++
		return coreproject.ExistingMemberResult{Added: true}, nil
	}, slog.New(slog.NewJSONHandler(&logs, nil)))
	w := &threadFailingWriter{ResponseRecorder: httptest.NewRecorder()}
	h.ServeHTTP(w, directRequest(directBody))
	if calls != 1 || w.calls != 1 || !strings.Contains(logs.String(), `"write_outcome":"unknown"`) {
		t.Fatalf("calls=%d writes=%d logs=%s", calls, w.calls, logs.String())
	}
	r := directRequest(directBody)
	r.Method = http.MethodPut
	response := httptest.NewRecorder()
	h.ServeHTTP(response, r)
	if response.Code != 405 || response.Header().Get("Allow") != "POST, PATCH, DELETE" || response.Header().Get("Cache-Control") != "no-store" || calls != 1 {
		t.Fatalf("status=%d allow=%q calls=%d", response.Code, response.Header().Get("Allow"), calls)
	}
}

func TestDirectMemberOAuthAndAuthentication(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	auth, err := authhttp.NewRequestAuthentication(func(context.Context, model.CredentialKind, string) (model.Principal, error) {
		return model.Principal{}, authhttp.Failure()
	}, authconfig.AuthSettings{PublicOrigin: "https://daynight.example"}, logger)
	if err != nil {
		t.Fatal(err)
	}
	credential := "40000000-0000-4000-8000-000000000001"
	auth.BindAPIAccess(func(_ context.Context, token string) (store.OAuthAccessIdentity, error) {
		if token != "dnapi_valid" {
			return store.OAuthAccessIdentity{}, authhttp.Failure()
		}
		return store.OAuthAccessIdentity{Principal: model.Principal{Kind: model.OAuthCredential, UserID: directActor, CredentialID: credential}}, nil
	}, "https://daynight.example")
	calls := 0
	mux := http.NewServeMux()
	RegisterDirectMemberRoute(mux, directOperation(func(_ context.Context, p model.Principal, _, _, _ string) (coreproject.ExistingMemberResult, error) {
		calls++
		if p.Kind != model.OAuthCredential || p.UserID != directActor || p.CredentialID != credential {
			t.Fatalf("OAuth identity lost: %+v", p)
		}
		return coreproject.ExistingMemberResult{}, nil
	}), auth, logger)
	for _, tc := range []struct {
		token     string
		status    int
		wantCalls int
		user      string
	}{
		{"dnapi_invalid", 401, 0, ""}, {"dnapi_valid", 200, 1, directActor},
	} {
		r := directRequest(directBody)
		r.Header.Set("Authorization", "Bearer "+tc.token)
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, r)
		if w.Code != tc.status || calls != tc.wantCalls || w.Header().Get("Daynight-User-ID") != tc.user || w.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("status=%d calls=%d headers=%v", w.Code, calls, w.Header())
		}
	}
}
